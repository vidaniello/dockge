import { DockgeServer } from "../dockge-server";
import { Stack } from "../stack";
import { ValidationError } from "../util-server";
import { apiName, dockerApiGet } from "../docker-api";
import { log } from "../log";
import { getStackStorage, getStorageStatus, loadComposeConfig, forgetStackDatasets } from "./storage";
import { getZfsSettings } from "./settings";
import { Settings } from "../settings";
import { createVolumeDataset, createVolumeDirectory, isDatasetMount, planVolumeDataset } from "./datasets";
import { parseRecipes, validateRecipe, VolumeRecipe } from "./recipe";

/**
 * Before a deploy: the bind mounts ./xxx of a stack that do not exist yet would be created by Docker as plain
 * folders. When the stack is a dataset and datasets can be created, Dockge creates them first, as datasets or
 * folders, following the rule of the settings or the choice of the user (docs/ZFS-DESIGN.md §6.2).
 */

export type VolumeType = "dataset" | "directory";

export interface VolumeDecision {
    type : VolumeType;
    /** uid:gid, overrides x-dockge.zfs */
    owner? : string;
    /** Octal, overrides x-dockge.zfs */
    mode? : string;
}

/**
 * "ask": stop and let the user choose (UI); "fail": stop with the list (API);
 * "dataset" / "directory": the same for all; a map: per volume ("./data" → decision)
 */
export type MissingVolumesChoice = "ask" | "fail" | VolumeType | Record<string, VolumeDecision | VolumeType>;

export interface MissingVolume {
    /** "./data" */
    path : string;
    services : string[];
    canBeDataset : boolean;
    /** Why it cannot be a dataset */
    reason : string | null;
    /** Suggested owner uid[:gid] and where it comes from */
    suggestedOwner : string | null;
    ownerSource : string | null;
    recipe : VolumeRecipe | null;
    /** Default choice */
    defaultType : VolumeType;
}

export interface VolumePlanItem {
    path : string;
    type : VolumeType;
    datasets : string[];
    owner : string | null;
    mode : string | null;
}

export interface PrepareResult {
    plan : VolumePlanItem[];
    warnings : string[];
}

/** A bind mount that points into the folder of another stack (docs/ZFS-DESIGN.md §9) */
export interface OtherStackBind {
    /** Absolute path */
    path : string;
    otherStack : string;
    services : string[];
    /** Docker creates it as a plain folder at the next deploy */
    missing : boolean;
}

/**
 * The deploy is stopped until the user (or the API caller) chooses what to do with the missing volumes, and/or
 * confirms the bind mounts into other stacks (only asked once per path)
 */
export class MissingVolumesError extends ValidationError {
    data : { missingVolumes : MissingVolume[], otherStackBinds : OtherStackBind[] };

    constructor(public missingVolumes : MissingVolume[], public otherStackBinds : OtherStackBind[] = []) {
        const parts : string[] = [];
        if (missingVolumes.length > 0) {
            parts.push(`These volumes do not exist yet: ${missingVolumes.map((volume) => volume.path).join(", ")}. Choose whether to create them as datasets or folders (missingVolumes: "dataset" | "directory").`);
        }
        if (otherStackBinds.length > 0) {
            parts.push(`These bind mounts point into the folder of another stack: ${otherStackBinds.map((bind) => `${bind.path} (stack ${bind.otherStack})`).join(", ")}.`);
        }
        super(parts.join(" "));
        this.data = {
            missingVolumes,
            otherStackBinds,
        };
    }
}

export interface PrepareOptions {
    /** See MissingVolumesChoice; undefined: the rule of the settings */
    missingVolumes? : unknown;
    /** The user confirmed the bind mounts into other stacks */
    acceptOtherStacks? : boolean;
    /** The caller can ask the user ("ask" is allowed, other stack binds are confirmed); otherwise they are warnings */
    interactive? : boolean;
    /** Only return the plan */
    dryRun? : boolean;
}

const ACK_KEY = "zfsOtherStackBindsAck";

async function getAcknowledged(stackName : string) : Promise<string[]> {
    try {
        const value = await Settings.get(ACK_KEY);
        const list = value && typeof value === "object" ? (value as Record<string, unknown>)[stackName] : undefined;
        return Array.isArray(list) ? list.map(String) : [];
    } catch (e) {
        return [];
    }
}

async function acknowledge(stackName : string, paths : string[]) {
    let value : Record<string, string[]> = {};
    try {
        const stored = await Settings.get(ACK_KEY);
        if (stored && typeof stored === "object") {
            value = stored as Record<string, string[]>;
        }
    } catch (e) {
        // first time
    }
    value[stackName] = [ ...new Set([ ...(value[stackName] ?? []), ...paths ]) ];
    await Settings.set(ACK_KEY, value);
}

/**
 * Bind mounts of a saved stack into the folders of other stacks. Works whatever the filesystem.
 */
export async function findOtherStackBinds(server : DockgeServer, stack : Stack) : Promise<OtherStackBind[]> {
    let storage;
    try {
        storage = await getStackStorage(server, stack.name);
    } catch (e) {
        return [];
    }
    return storage.volumes
        .filter((volume) => volume.location === "otherStack" && volume.hostPath && volume.otherStack)
        .map((volume) => ({
            path: volume.hostPath as string,
            otherStack: volume.otherStack as string,
            services: volume.services,
            missing: volume.kind === "missing",
        }));
}

function otherStackWarning(bind : OtherStackBind) : string {
    return `${bind.path} is in the folder of the stack ${bind.otherStack}: the two stacks stay tied (deleting or rolling back ${bind.otherStack} changes it)` +
        (bind.missing ? "; it does not exist, Docker creates it as a plain folder" : "") + ". For data of this stack use ./name.";
}

const FILE_NAME = /\.(ya?ml|json|conf|cfg|ini|toml|xml|env|sh|txt|js|py|php|lua|properties|db|sqlite|pem|crt|key)$/i;

function numericUser(value : unknown) : string | null {
    if (typeof value !== "string" && typeof value !== "number") {
        return null;
    }
    const text = String(value).trim();
    return /^\d+(:\d+)?$/.test(text) ? text : null;
}

/**
 * Owner proposed for a volume (docs/ZFS-DESIGN.md §7.1): user: of the service, PUID/PGID, User of the image.
 * Only a proposal: many images start as root and chown by themselves.
 */
async function suggestOwner(config : Record<string, unknown>, services : string[]) : Promise<{ owner : string | null, source : string | null }> {
    const definitions = (config.services ?? {}) as Record<string, Record<string, unknown>>;
    for (const service of services) {
        const definition = definitions[service] ?? {};
        const user = numericUser(definition.user);
        if (user) {
            return {
                owner: user,
                source: `user: of ${service}`,
            };
        }
        const environment = (definition.environment ?? {}) as Record<string, unknown>;
        const puid = numericUser(environment.PUID);
        if (puid) {
            const pgid = numericUser(environment.PGID);
            return {
                owner: pgid ? `${puid}:${pgid}` : puid,
                source: `PUID/PGID of ${service}`,
            };
        }
    }
    for (const service of services) {
        const image = definitions[service]?.image;
        if (typeof image !== "string") {
            continue;
        }
        try {
            const inspect = await dockerApiGet<{ Config? : { User? : string } }>(`/images/${apiName(image)}/json`);
            const user = numericUser(inspect.Config?.User);
            if (user) {
                return {
                    owner: user,
                    source: `image ${image}`,
                };
            }
        } catch (e) {
            // Image not pulled yet
        }
    }
    return {
        owner: null,
        source: null,
    };
}

/**
 * The missing ./xxx volumes of a saved stack. Empty when datasets cannot be created (then Docker creates folders as
 * before: nothing changes for stacks that are not on ZFS).
 */
export async function findMissingVolumes(server : DockgeServer, stack : Stack) : Promise<{ missing : MissingVolume[], applies : boolean }> {
    const status = await getStorageStatus(server);
    if (!status.zfs || !status.canCreate || !isDatasetMount(stack.path)) {
        return {
            missing: [],
            applies: false,
        };
    }

    let config : Record<string, unknown> = {};
    try {
        config = await loadComposeConfig(stack);
    } catch (e) {
        // Invalid compose file: docker compose up will report it
        return {
            missing: [],
            applies: true,
        };
    }

    const storage = await getStackStorage(server, stack.name);
    const { recipes } = parseRecipes(stack.composeYAML);
    const missing : MissingVolume[] = [];
    for (const volume of storage.volumes) {
        if (volume.kind !== "missing" || volume.location !== "stack" || !volume.relative || volume.isStackFolder) {
            continue;
        }
        const relative = volume.relative.replace(/^\.\//, "");
        // A file (config.yml) that is missing is a mistake in the stack, not a volume to create: Docker handles it as before
        if (FILE_NAME.test(relative)) {
            continue;
        }
        let reason : string | null = null;
        try {
            planVolumeDataset(status, stack.name, relative);
        } catch (e) {
            reason = e instanceof Error ? e.message : String(e);
        }
        const { owner, source } = await suggestOwner(config, volume.services);
        const recipe = recipes.get(relative) ?? null;
        missing.push({
            path: volume.relative,
            services: volume.services,
            canBeDataset: reason === null,
            reason,
            suggestedOwner: recipe?.owner ?? owner,
            ownerSource: recipe?.owner ? "x-dockge.zfs" : source,
            recipe,
            defaultType: reason === null ? "dataset" : "directory",
        });
    }
    // Parents before children
    missing.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
    return {
        missing,
        applies: true,
    };
}

function decisionFor(choice : MissingVolumesChoice, volume : MissingVolume) : VolumeDecision | null {
    if (typeof choice === "string") {
        if (choice === "dataset") {
            // Where a dataset is impossible (e.g. inside a folder): a folder, as Docker would do
            return {
                type: volume.canBeDataset ? "dataset" : "directory",
            };
        }
        if (choice === "directory") {
            return {
                type: "directory",
            };
        }
        return null;
    }
    const entry = choice[volume.path] ?? choice[volume.path.replace(/^\.\//, "")];
    if (!entry) {
        return null;
    }
    if (typeof entry === "string") {
        return {
            type: entry,
        };
    }
    return entry;
}

function parseChoice(value : unknown) : MissingVolumesChoice | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    if (typeof value === "string") {
        if (![ "ask", "fail", "dataset", "directory" ].includes(value)) {
            throw new ValidationError("missingVolumes must be dataset, directory, fail or a map of volume → dataset | directory");
        }
        return value as MissingVolumesChoice;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
        const result : Record<string, VolumeDecision> = {};
        for (const [ key, entry ] of Object.entries(value as Record<string, unknown>)) {
            const decision = typeof entry === "string" ? { type: entry } : entry as Record<string, unknown>;
            if (!decision || (decision.type !== "dataset" && decision.type !== "directory")) {
                throw new ValidationError(`missingVolumes.${key}: type must be dataset or directory`);
            }
            const checked = validateRecipe({
                owner: decision.owner,
                mode: decision.mode,
            }, `missingVolumes.${key}`);
            result[key] = {
                type: decision.type,
                owner: checked.owner,
                mode: checked.mode,
            };
        }
        return result;
    }
    throw new ValidationError("Invalid missingVolumes");
}

/**
 * Create the missing volumes of a stack before docker compose up.
 * @param server Dockge server
 * @param stack Saved stack
 * @param rawChoice What to do (see MissingVolumesChoice); undefined: the rule of the settings
 * @param interactive The caller can ask the user ("ask" is allowed); otherwise "ask" becomes "fail"
 * @param dryRun Only return the plan
 */
export async function prepareStackVolumes(server : DockgeServer, stack : Stack, options : PrepareOptions = {}) : Promise<PrepareResult> {
    const result : PrepareResult = {
        plan: [],
        warnings: [],
    };
    const interactive = options.interactive === true;
    const dryRun = options.dryRun === true;
    let choice = parseChoice(options.missingVolumes) ?? (await getZfsSettings()).missingVolumes;
    if (choice === "ask" && !interactive) {
        choice = "fail";
    }

    // Bind mounts into other stacks: confirmed once per path in the UI, always a warning for the API
    const otherStackBinds = await findOtherStackBinds(server, stack);
    result.warnings.push(...otherStackBinds.map(otherStackWarning));
    let toConfirm : OtherStackBind[] = [];
    if (interactive && otherStackBinds.length > 0 && options.acceptOtherStacks !== true) {
        const acknowledged = await getAcknowledged(stack.name);
        toConfirm = otherStackBinds.filter((bind) => !acknowledged.includes(bind.path));
    }

    const { missing } = await findMissingVolumes(server, stack);

    const decisions = missing.map((volume) => decisionFor(choice, volume));
    const undecided = missing.filter((_volume, index) => decisions[index] === null);
    if (undecided.length > 0 || toConfirm.length > 0) {
        // The dialog shows all the missing volumes, not only the undecided ones
        throw new MissingVolumesError(undecided.length > 0 ? missing : [], toConfirm);
    }
    if (interactive && options.acceptOtherStacks === true && otherStackBinds.length > 0 && !dryRun) {
        await acknowledge(stack.name, otherStackBinds.map((bind) => bind.path));
    }
    if (missing.length === 0) {
        return result;
    }

    const status = await getStorageStatus(server);
    for (let i = 0; i < missing.length; i++) {
        const volume = missing[i];
        const decision = decisions[i] as VolumeDecision;
        const recipe : VolumeRecipe = {
            ...(volume.recipe ?? {}),
            ...(decision.owner ? { owner: decision.owner } : {}),
            ...(decision.mode ? { mode: decision.mode } : {}),
        };
        const relative = volume.path.replace(/^\.\//, "");
        let datasets : string[] = [];
        if (decision.type === "dataset") {
            if (!volume.canBeDataset) {
                throw new ValidationError(`${volume.path} cannot be a dataset: ${volume.reason}`);
            }
            datasets = planVolumeDataset(status, stack.name, relative).map((step) => step.dataset);
        }
        result.plan.push({
            path: volume.path,
            type: decision.type,
            datasets,
            owner: recipe.owner ?? null,
            mode: recipe.mode ?? null,
        });
    }

    // ./data as a folder and ./data/db as a dataset: impossible, the dataset would need ./data to be a dataset
    for (const item of result.plan) {
        if (item.type !== "dataset") {
            continue;
        }
        const parent = result.plan.find((other) => other.type === "directory" && item.path.startsWith(other.path + "/"));
        if (parent) {
            throw new ValidationError(`${item.path} cannot be a dataset if ${parent.path} is created as a folder`);
        }
    }

    if (dryRun) {
        return result;
    }

    for (const item of result.plan) {
        const relative = item.path.replace(/^\.\//, "");
        const recipe : VolumeRecipe = {
            ...(missing.find((volume) => volume.path === item.path)?.recipe ?? {}),
            owner: item.owner ?? undefined,
            mode: item.mode ?? undefined,
        };
        // createVolumeDataset plans again: a parent created in a previous step is now a dataset
        if (item.type === "dataset") {
            const created = await createVolumeDataset(server, stack.name, relative, recipe);
            result.warnings.push(...created.warnings);
            log.info("zfs", `Stack ${stack.name}: ${item.path} created as dataset ${created.dataset}`);
        } else {
            result.warnings.push(...await createVolumeDirectory(stack.path, relative, recipe));
            log.info("zfs", `Stack ${stack.name}: ${item.path} created as a folder`);
        }
    }
    const stackDataset = isDatasetMount(stack.path);
    if (stackDataset) {
        forgetStackDatasets(stackDataset);
    }
    return result;
}
