import fs from "fs";
import { promises as fsAsync } from "fs";
import path from "path";
import { DockgeServer } from "../dockge-server";
import { ValidationError } from "../util-server";
import { log } from "../log";
import { mountAt, mountsInside, readMountInfo } from "./mountinfo";
import { getZfsSettings } from "./settings";
import { DatasetProperties, getProvider, ZfsProvider } from "./provider";
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

/**
 * Path of ./relative (or "." for the stack folder) inside a stack, checked
 */
function stackTarget(status : StorageStatus, stackName : string, relative : string) : { target : string, display : string } {
    const stackDir = path.join(status.stacksDir, stackName);
    if (relative.trim() === "." || relative.trim() === "./") {
        return {
            target: stackDir,
            display: ".",
        };
    }
    const clean = normalizeVolumePath(relative);
    return {
        target: path.join(stackDir, clean),
        display: "./" + clean,
    };
}

/**
 * Change ZFS properties of a dataset of a stack (the stack dataset itself with ".")
 */
export async function setDatasetProperties(server : DockgeServer, stackName : string, relative : string, properties : DatasetProperties, dryRun = false) {
    const { status, provider } = await getCreationContext(server);
    const { target, display } = stackTarget(status, stackName, relative);
    const dataset = isDatasetMount(target);
    if (!dataset) {
        throw new ValidationError(`${display} is not a dataset`);
    }
    checkSubtree(status, dataset);
    if (Object.values(properties).every((value) => value === undefined)) {
        throw new ValidationError("No property to change (recordsize, compression, atime, quota)");
    }
    if (!dryRun) {
        log.info("zfs", `Updating dataset ${dataset}: ${JSON.stringify(properties)}`);
        await provider.updateDataset(dataset, properties);
    }
    return {
        path: display,
        dataset,
        properties,
        dryRun,
        note: properties.recordsize ? "recordsize applies to data written from now on, existing files keep their record size" : undefined,
    };
}

/**
 * Change owner and permissions of a folder or dataset of a stack. Done by Dockge itself (root in its container).
 * recursive: the owner only, inside the same filesystem (child datasets are not entered, like setperm of TrueNAS);
 * mode is applied to the folder itself only (the same mode on files and folders would be wrong).
 */
export async function setVolumePermissions(server : DockgeServer, stackName : string, relative : string, options : { owner? : string, mode? : string, recursive? : boolean }, dryRun = false) {
    const stacksDir = fs.realpathSync(server.stacksDir);
    const status = {
        stacksDir,
    } as StorageStatus;
    const { target, display } = stackTarget(status, stackName, relative);
    let stat : fs.Stats;
    try {
        stat = await fsAsync.lstat(target);
    } catch (e) {
        throw new ValidationError(`${display} does not exist`);
    }
    if (!stat.isDirectory()) {
        throw new ValidationError(`${display} is not a folder`);
    }
    // A symbolic link in the middle of the path must not lead outside the stack
    const realStack = fs.realpathSync(path.join(stacksDir, stackName));
    const realTarget = fs.realpathSync(target);
    if (realTarget !== realStack && !realTarget.startsWith(realStack + path.sep)) {
        throw new ValidationError(`${display} is outside the stack folder`);
    }
    if (!options.owner && !options.mode) {
        throw new ValidationError("Give owner and/or mode");
    }
    const result = {
        path: display,
        owner: options.owner ?? null,
        mode: options.mode ?? null,
        recursive: options.recursive === true,
        changed: 0,
        warnings: [] as string[],
        dryRun,
    };
    if (dryRun) {
        return result;
    }
    await applyOwnerAndMode(target, {
        owner: options.owner,
        mode: options.mode,
    }, result.warnings);
    result.changed = 1;

    if (options.recursive && options.owner) {
        const [ uid, gid ] = options.owner.split(":").map(Number);
        const device = stat.dev;
        const walk = async (dir : string) => {
            for (const entry of await fsAsync.readdir(dir, { withFileTypes: true })) {
                const child = path.join(dir, entry.name);
                const childStat = await fsAsync.lstat(child);
                if (childStat.dev !== device) {
                    // Another dataset (or mount): not entered
                    continue;
                }
                try {
                    await fsAsync.lchown(child, uid, gid ?? uid);
                    result.changed++;
                } catch (e) {
                    if (result.warnings.length < 20) {
                        result.warnings.push(`${child}: ${e instanceof Error ? e.message : e}`);
                    }
                }
                if (childStat.isDirectory()) {
                    await walk(child);
                }
            }
        };
        await walk(target);
    }
    log.info("zfs", `Permissions of ${display} in stack ${stackName}: owner ${options.owner ?? "-"}, mode ${options.mode ?? "-"}, recursive ${options.recursive === true}, ${result.changed} entries`);
    return result;
}

/**
 * What deleting a stack would destroy: its datasets and their snapshots
 */
export async function getStackDeletionInfo(server : DockgeServer, stackName : string) {
    const target = path.join(fs.realpathSync(server.stacksDir), stackName);
    const datasets = datasetsInside(target);
    const stackDataset = isDatasetMount(target);
    let snapshots : number | null = null;
    let canDestroy = false;
    let reason : string | null = null;
    if (datasets.length > 0) {
        try {
            const { provider } = await getCreationContext(server);
            canDestroy = stackDataset !== null && datasets.every((dataset) => dataset === stackDataset || dataset.startsWith(stackDataset + "/"));
            if (!canDestroy) {
                reason = "The stack folder is not a dataset but contains datasets: delete them in TrueNAS";
            }
            try {
                // A recursive snapshot is one per dataset: count the names
                snapshots = new Set((await provider.listSnapshots(datasets)).map((snapshot) => snapshot.name)).size;
            } catch (e) {
                // SNAPSHOT_READ missing: the count is not shown
            }
        } catch (e) {
            reason = e instanceof Error ? e.message : String(e);
        }
    }
    return {
        stack: stackName,
        datasets,
        stackDataset,
        snapshots,
        canDestroy,
        reason,
    };
}

/**
 * Destroy the dataset of a stack with all its children and snapshots, then remove what is left of the folder.
 * The containers must already be removed.
 */
export async function destroyStackDatasets(server : DockgeServer, stackName : string) : Promise<string[]> {
    const { status, provider } = await getCreationContext(server);
    const target = path.join(status.stacksDir, stackName);
    const stackDataset = isDatasetMount(target);
    const datasets = datasetsInside(target);
    if (!stackDataset || datasets.some((dataset) => dataset !== stackDataset && !dataset.startsWith(stackDataset + "/"))) {
        throw new ValidationError("The stack folder is not a dataset but contains datasets: delete them in TrueNAS");
    }
    checkSubtree(status, stackDataset);

    log.info("zfs", `Destroying dataset ${stackDataset} of stack ${stackName} with its children and snapshots: ${datasets.join(", ")}`);
    try {
        await withDatasetReleased(target, () => provider.deleteDataset(stackDataset, true));
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/not authori[sz]ed|EACCES|ENOTAUTHORIZED/i.test(message)) {
            throw new ValidationError(`TrueNAS refused to delete the datasets: ${message}. The TrueNAS user needs the DATASET_DELETE role.`);
        }
        if (/clone|dependent/i.test(message)) {
            throw new ValidationError(`The datasets have clones (stacks cloned from their snapshots): delete or promote those first. ${message}`);
        }
        throw e;
    }

    // rm -rf only once the datasets are unmounted here: otherwise it would go into them
    const start = Date.now();
    while (datasetsInside(target).length > 0) {
        if (Date.now() - start > MOUNT_WAIT_MS) {
            throw new Error(`The datasets were destroyed but Dockge still sees them mounted at ${target}: the folder was not removed`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await fsAsync.rm(target, {
        recursive: true,
        force: true,
    });
    return datasets;
}

export interface StackDatasetRename {
    from : string;
    to : string;
    oldName : string;
    newName : string;
    target : string;
}

/**
 * Check that a stack that is a dataset can be renamed (before anything is stopped)
 */
export async function planStackDatasetRename(server : DockgeServer, oldName : string, newName : string) : Promise<StackDatasetRename> {
    const { status } = await getCreationContext(server);
    const source = path.join(status.stacksDir, oldName);
    const stackDataset = isDatasetMount(source);
    const datasets = datasetsInside(source);
    if (!stackDataset || datasets.some((dataset) => dataset !== stackDataset && !dataset.startsWith(stackDataset + "/"))) {
        throw new ValidationError(`The stack folder contains datasets (${datasets.join(", ")}) but is not a dataset itself: it cannot be renamed. Convert it to a dataset first, or rename it in TrueNAS.`);
    }
    if (!status.stacksIsDatasetRoot || stackDataset !== `${status.dataset}/${oldName}`) {
        throw new ValidationError(`The dataset ${stackDataset} is not named after the stack: rename it in TrueNAS`);
    }
    const to = `${status.dataset}/${newName}`;
    checkSubtree(status, to);
    return {
        from: stackDataset,
        to,
        oldName,
        newName,
        target: path.join(status.stacksDir, newName),
    };
}

/**
 * Before TrueNAS unmounts a dataset of a stack (rename, destroy): close the terminals of Dockge working in it, then run
 * the operation, retrying a few times while the dataset is busy (a process that is still exiting)
 */
export async function withDatasetReleased<T>(folder : string, operation : () => Promise<T>) : Promise<T> {
    const { Terminal } = await import("../terminal");
    await Terminal.closeInside(folder);
    const delays = [ 1000, 2000, 4000 ];
    for (let attempt = 0; ; attempt++) {
        try {
            return await operation();
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (!/busy|EBUSY/i.test(message)) {
                throw e;
            }
            if (attempt >= delays.length) {
                throw new ValidationError(`${message}. Something still uses files in ${folder}: a shell or a file manager open in it (also on TrueNAS), an SMB/NFS share, a process of a container that is not stopped. Close it and try again.`);
            }
            log.info("zfs", `${folder} is busy, retrying in ${delays[attempt] / 1000} s`);
            await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        }
    }
}

export function explainAdminOnly(e : unknown, action : string) : Error {
    const message = e instanceof Error ? e.message : String(e);
    if (/not authori[sz]ed|EACCES|ENOTAUTHORIZED/i.test(message)) {
        return new ValidationError(`TrueNAS refused to ${action}: ${message}. TrueNAS 25.04 allows renaming a dataset only to a full administrator: use the API key of an admin user, or rename it in TrueNAS.`);
    }
    return e instanceof Error ? e : new Error(message);
}

/**
 * Rename the dataset of a stack (the containers must be removed) and wait until it is mounted at the new path
 */
export async function renameStackDataset(server : DockgeServer, plan : StackDatasetRename) : Promise<void> {
    const { status, provider } = await getCreationContext(server);
    log.info("zfs", `Renaming dataset ${plan.from} to ${plan.to}`);
    try {
        await withDatasetReleased(path.join(status.stacksDir, plan.oldName), () => provider.renameDataset(plan.from, plan.to));
    } catch (e) {
        throw explainAdminOnly(e, `rename ${plan.from}`);
    }
    await waitForMount(plan.target, plan.to);
    try {
        await provider.setUserProperties(plan.to, {
            [STACK_PROPERTY]: plan.newName,
        });
    } catch (e) {
        log.warn("zfs", `Cannot update ${STACK_PROPERTY} of ${plan.to}: ${e instanceof Error ? e.message : e}`);
    }
}
