import fs from "fs";
import { promises as fsAsync } from "fs";
import path from "path";
import { DockgeServer } from "../dockge-server";
import { ValidationError } from "../util-server";
import { log } from "../log";
import { mountAt, mountsInside, readMountInfo } from "./mountinfo";
import { getZfsSettings } from "./settings";
import { getProvider, ZfsProvider } from "./provider";
import { normalizeVolumePath, recipeToCreateOptions, VolumeRecipe } from "./recipe";
import { getStorageStatus, StorageStatus } from "./storage";

/**
 * Creation of datasets (docs/ZFS-DESIGN.md, phase 2). Rules:
 * - a dataset is created only where nothing exists yet (never over a folder: it would hide its content);
 * - only inside the dataset of the stacks folder, whatever the API key could do;
 * - nothing is written into a new dataset before Dockge sees it mounted (otherwise the file would end up in the
 *   folder hidden under the mount).
 */

export const MANAGED_PROPERTY = "dockge:managed";
export const STACK_PROPERTY = "dockge:stack";
export const VOLUME_PROPERTY = "dockge:volume";

const MOUNT_WAIT_MS = 20 * 1000;

export interface CreationContext {
    status : StorageStatus;
    provider : ZfsProvider;
}

/**
 * Everything needed to create a dataset, or an error that says why it is not possible
 */
export async function getCreationContext(server : DockgeServer) : Promise<CreationContext> {
    const status = await getStorageStatus(server);
    if (!status.canCreate || !status.dataset) {
        const reason = status.problems.find((problem) => problem.severity === "error")?.message
            ?? (status.zfs ? "Datasets cannot be created: see Settings → Storage" : "The stacks folder is not on ZFS");
        throw new ValidationError(reason);
    }
    const provider = getProvider(await getZfsSettings());
    if (!provider) {
        throw new ValidationError("TrueNAS is not configured: see Settings → Storage");
    }
    return {
        status,
        provider,
    };
}

function checkSubtree(status : StorageStatus, dataset : string) {
    if (!status.dataset || !dataset.startsWith(status.dataset + "/")) {
        throw new ValidationError(`Refused: ${dataset} is outside the dataset of the stacks folder (${status.dataset})`);
    }
}

/**
 * Wait until the dataset is mounted at target inside this container
 */
export async function waitForMount(target : string, dataset : string) : Promise<void> {
    const start = Date.now();
    while (Date.now() - start < MOUNT_WAIT_MS) {
        const entry = mountAt(readMountInfo(), target);
        if (entry && entry.fsType === "zfs" && entry.source === dataset) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`The dataset ${dataset} was created but Dockge does not see it mounted at ${target}. Check the mount propagation (rslave) of the stacks folder; nothing was written into it.`);
}

export function isDatasetMount(target : string) : string | null {
    const entry = mountAt(readMountInfo(), target);
    return entry && entry.fsType === "zfs" && entry.root === "/" ? entry.source : null;
}

/**
 * ZFS datasets mounted at or under a folder (rm -rf would go into them, rename would fail)
 */
export function datasetsInside(target : string) : string[] {
    return mountsInside(readMountInfo(), target).filter((entry) => entry.fsType === "zfs").map((entry) => entry.source);
}

/**
 * A dataset created before the stack (e.g. from TrueNAS) can host a new stack if it is empty.
 * Hidden entries of ZFS (.zfs is not listed by readdir) do not count.
 */
export async function isEmptyDatasetFolder(target : string) : Promise<boolean> {
    if (!isDatasetMount(target)) {
        return false;
    }
    const entries = await fsAsync.readdir(target);
    return entries.length === 0;
}

/**
 * Create the dataset of a new stack: <stacks dataset>/<name>
 */
export async function createStackDataset(server : DockgeServer, stackName : string) : Promise<string> {
    const { status, provider } = await getCreationContext(server);
    if (!status.stacksIsDatasetRoot) {
        throw new ValidationError("The stacks folder is not the root of a dataset");
    }
    const target = path.join(status.stacksDir, stackName);
    if (fs.existsSync(target)) {
        throw new ValidationError("Stack name already exists");
    }
    const dataset = `${status.dataset}/${stackName}`;
    checkSubtree(status, dataset);

    log.info("zfs", `Creating dataset ${dataset} for stack ${stackName}`);
    await provider.createDataset(dataset, {
        userProperties: {
            [MANAGED_PROPERTY]: "true",
            [STACK_PROPERTY]: stackName,
        },
    });
    await waitForMount(target, dataset);
    return dataset;
}

export interface CreatedVolume {
    path : string;
    dataset : string;
    /** Intermediate datasets created for a nested path */
    parents : string[];
    warnings : string[];
}

export interface VolumePlanStep {
    /** Relative path, e.g. "data/db" */
    path : string;
    dataset : string;
    intermediate : boolean;
}

/**
 * The datasets to create for ./relative inside a stack, or an error if it is not possible
 */
export function planVolumeDataset(status : StorageStatus, stackName : string, relative : string) : VolumePlanStep[] {
    const volumePath = normalizeVolumePath(relative);
    const stackDir = path.join(status.stacksDir, stackName);
    const stackDataset = isDatasetMount(stackDir);
    if (!stackDataset) {
        throw new ValidationError(`The stack ${stackName} is a folder, not a dataset: its volumes cannot be datasets (converting a stack is not available yet)`);
    }

    const parts = volumePath.split("/");
    const steps : VolumePlanStep[] = [];
    let parentDataset = stackDataset;
    for (let i = 0; i < parts.length; i++) {
        const current = parts.slice(0, i + 1).join("/");
        const target = path.join(stackDir, current);
        const last = i === parts.length - 1;
        const existing = isDatasetMount(target);
        if (existing) {
            if (last) {
                throw new ValidationError(`./${current} is already a dataset (${existing})`);
            }
            parentDataset = existing;
            continue;
        }
        if (fs.existsSync(target)) {
            throw new ValidationError(last
                ? `./${current} already exists as a folder: a dataset created there would hide its content (converting a folder is not available yet)`
                : `./${current} is a folder: the dataset ./${volumePath} needs it to be a dataset (converting a folder is not available yet)`);
        }
        // A child dataset is named after its parent dataset (inherited mountpoint)
        const dataset = `${parentDataset}/${parts[i]}`;
        checkSubtree(status, dataset);
        steps.push({
            path: current,
            dataset,
            intermediate: !last,
        });
        parentDataset = dataset;
    }
    return steps;
}

/**
 * Apply owner and mode of the recipe to a new, empty dataset or folder. Dockge runs as root and sees the mount.
 */
export async function applyOwnerAndMode(target : string, recipe : VolumeRecipe | undefined, warnings : string[]) {
    if (recipe?.owner) {
        const [ uid, gid ] = recipe.owner.split(":").map(Number);
        try {
            await fsAsync.chown(target, uid, gid ?? uid);
        } catch (e) {
            warnings.push(`Cannot change the owner of ${target} to ${recipe.owner}: ${e instanceof Error ? e.message : e}`);
        }
    }
    if (recipe?.mode) {
        try {
            await fsAsync.chmod(target, parseInt(recipe.mode, 8));
        } catch (e) {
            // EPERM: NFSv4 ACL with aclmode=restricted
            warnings.push(`Cannot change the permissions of ${target} to ${recipe.mode}: ${e instanceof Error ? e.message : e}`);
        }
    }
}

/**
 * Create ./relative of a stack as a dataset (and the missing intermediate datasets)
 */
export async function createVolumeDataset(server : DockgeServer, stackName : string, relative : string, recipe? : VolumeRecipe) : Promise<CreatedVolume> {
    const { status, provider } = await getCreationContext(server);
    const steps = planVolumeDataset(status, stackName, relative);
    const stackDir = path.join(status.stacksDir, stackName);
    const result : CreatedVolume = {
        path: "./" + normalizeVolumePath(relative),
        dataset: steps[steps.length - 1].dataset,
        parents: [],
        warnings: [],
    };

    for (const step of steps) {
        const target = path.join(stackDir, step.path);
        log.info("zfs", `Creating dataset ${step.dataset} for ./${step.path} of stack ${stackName}`);
        await provider.createDataset(step.dataset, recipeToCreateOptions(step.intermediate ? undefined : recipe, {
            [MANAGED_PROPERTY]: "true",
            [STACK_PROPERTY]: stackName,
            [VOLUME_PROPERTY]: step.path,
        }));
        await waitForMount(target, step.dataset);
        if (step.intermediate) {
            result.parents.push(step.dataset);
            result.warnings.push(`./${step.path} was created as a dataset too, because ./${normalizeVolumePath(relative)} is inside it`);
        } else {
            await applyOwnerAndMode(target, recipe, result.warnings);
        }
    }
    return result;
}

/**
 * Create ./relative of a stack as a plain folder
 */
export async function createVolumeDirectory(stackDir : string, relative : string, recipe? : VolumeRecipe) : Promise<string[]> {
    const target = path.join(stackDir, normalizeVolumePath(relative));
    const warnings : string[] = [];
    await fsAsync.mkdir(target, { recursive: true });
    await applyOwnerAndMode(target, recipe, warnings);
    return warnings;
}
