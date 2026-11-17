import fs from "fs";
import { promises as fsAsync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { DockgeServer } from "../dockge-server";
import { Stack } from "../stack";
import { ValidationError } from "../util-server";
import { log } from "../log";
import { RUNNING } from "../../common/util-common";
import {
    datasetsInside, getCreationContext, isDatasetMount, MANAGED_PROPERTY, STACK_PROPERTY, VOLUME_PROPERTY, waitForMount, withDatasetReleased
} from "./datasets";
import { normalizeVolumePath, parseRecipes, recipeToCreateOptions, VolumeRecipe } from "./recipe";
import { forgetStackDatasets } from "./storage";
import { getSpace, mountsInside, readMountInfo } from "./mountinfo";
import { JobContext, startJob } from "./jobs";
import { ZfsProvider } from "./provider";

/**
 * Conversion of existing folders into datasets (docs/ZFS-DESIGN.md §6.3). A dataset cannot be created over a folder
 * (it would hide it), so: stop the stack, safety snapshot, move the folder aside (instant, same filesystem), create the
 * dataset where the folder was, copy the content back preserving owners, permissions, ACLs, xattrs and hard links
 * (cp -a, with block cloning when possible), verify, start the stack again. The copy stays as <name>.dockge-backup-<date>
 * until the user deletes it. On error the dataset is destroyed and the folder put back.
 *
 * The user property dockge:migration on the new dataset ("copying", then "done") marks an interrupted conversion.
 */

export const MIGRATION_PROPERTY = "dockge:migration";
export const BACKUP_MARK = ".dockge-backup-";

function timestamp(date = new Date()) : string {
    const pad = (value : number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

interface TreeSize {
    files : number;
    directories : number;
    bytes : number;
}

/**
 * Number of entries and apparent size of a tree (symbolic links are counted, not followed)
 */
async function treeSize(root : string) : Promise<TreeSize> {
    const result : TreeSize = {
        files: 0,
        directories: 0,
        bytes: 0,
    };
    const walk = async (dir : string) => {
        for (const entry of await fsAsync.readdir(dir, { withFileTypes: true })) {
            // The snapshot folder of a dataset root (visible with snapdir=visible) is not content
            if (dir === root && entry.name === ".zfs") {
                continue;
            }
            const target = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                result.directories++;
                await walk(target);
            } else {
                result.files++;
                if (entry.isFile()) {
                    result.bytes += (await fsAsync.lstat(target)).size;
                }
            }
        }
    };
    await walk(root);
    return result;
}

function formatSize(bytes : number) : string {
    const units = [ "B", "KiB", "MiB", "GiB", "TiB" ];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * cp -a --reflink=auto source/. target/ with the progress read from the space used by the new dataset
 */
function copyTree(source : string, target : string, context : JobContext, total : number) : Promise<void> {
    return new Promise((resolve, reject) => {
        const startUsed = usedBytes(target);
        const child = spawn("cp", [ "-a", "--reflink=auto", source + "/.", target + "/" ], {
            stdio: [ "ignore", "ignore", "pipe" ],
        });
        let stderr = "";
        child.stderr.on("data", (data : Buffer) => {
            stderr += data.toString();
            if (stderr.length > 16 * 1024) {
                stderr = stderr.slice(-16 * 1024);
            }
        });
        const timer = setInterval(() => {
            const used = usedBytes(target);
            if (used !== null && startUsed !== null) {
                context.setBytes(Math.max(0, used - startUsed), total);
            }
            if (context.job.cancelRequested) {
                child.kill("SIGTERM");
            }
        }, 2000);
        child.on("error", (e) => {
            clearInterval(timer);
            reject(e);
        });
        child.on("close", (code) => {
            clearInterval(timer);
            if (context.job.cancelRequested) {
                reject(new Error("Cancelled during the copy"));
            } else if (code === 0) {
                resolve();
            } else {
                // Failures to keep extended attributes / ACLs are reported but do not stop cp: show them
                reject(new Error(`cp exited with code ${code}: ${stderr.trim().split("\n").slice(-5).join("; ")}`));
            }
        });
    });
}

function usedBytes(target : string) : number | null {
    const space = getSpace(target);
    return space ? space.total - space.available : null;
}

interface ConversionPlan {
    kind : "volume" | "stack";
    stack : string;
    /** "./library" or the stack folder */
    display : string;
    /** Folder converted */
    target : string;
    backup : string;
    dataset : string;
    /** Dataset that gets the safety snapshot */
    parentDataset : string;
    snapshotName : string;
    size : TreeSize;
    available : number | null;
    running : boolean;
    recipe : VolumeRecipe | undefined;
    warnings : string[];
}

function publicPlan(plan : ConversionPlan) {
    return {
        kind: plan.kind,
        stack: plan.stack,
        path: plan.display,
        dataset: plan.dataset,
        backup: path.basename(plan.backup),
        safetySnapshot: `${plan.parentDataset}@${plan.snapshotName}`,
        files: plan.size.files,
        directories: plan.size.directories,
        bytes: plan.size.bytes,
        size: formatSize(plan.size.bytes),
        available: plan.available,
        stopsAndStartsStack: plan.running,
        properties: plan.recipe ?? null,
        warnings: plan.warnings,
    };
}

async function checkSpace(plan : ConversionPlan) {
    if (plan.available !== null && plan.available < plan.size.bytes * 1.05 + 64 * 1024 * 1024) {
        throw new ValidationError(`Not enough free space: the copy needs about ${formatSize(plan.size.bytes)}, ${formatSize(plan.available)} are available. (Block cloning may avoid the copy, but it cannot be guaranteed in advance.)`);
    }
}

function checkNoMountsInside(target : string, display : string) {
    const inside = mountsInside(readMountInfo(), target);
    if (inside.length > 0) {
        throw new ValidationError(`${display} contains mounted datasets (${inside.map((entry) => entry.source).join(", ")}): convert those parts separately`);
    }
}

async function isRunning(stack : Stack) : Promise<boolean> {
    await stack.updateStatus();
    return stack.status === RUNNING;
}

/**
 * Plan the conversion of ./relative of a stack into a dataset
 */
export async function planVolumeConversion(server : DockgeServer, stackName : string, relative : string) : Promise<ConversionPlan> {
    const { status } = await getCreationContext(server);
    const stack = await Stack.getStack(server, stackName);
    const stackDir = path.join(status.stacksDir, stackName);
    const stackDataset = isDatasetMount(stackDir);
    if (!stackDataset) {
        throw new ValidationError(`The stack ${stackName} is a folder: convert the stack to a dataset first`);
    }
    const clean = normalizeVolumePath(relative);
    const target = path.join(stackDir, clean);
    const display = "./" + clean;
    const stat = await fsAsync.lstat(target).catch(() => null);
    if (!stat || !stat.isDirectory()) {
        throw new ValidationError(`${display} is not an existing folder`);
    }
    if (isDatasetMount(target)) {
        throw new ValidationError(`${display} is already a dataset`);
    }
    checkNoMountsInside(target, display);
    const parentDir = path.dirname(target);
    const parentDataset = isDatasetMount(parentDir);
    if (!parentDataset) {
        throw new ValidationError(`${display} is inside the folder ./${path.relative(stackDir, parentDir)}: convert that one first`);
    }
    const warnings : string[] = [];
    const recipe = parseRecipes(stack.composeYAML).recipes.get(clean);
    if (recipe?.owner || recipe?.mode) {
        warnings.push("owner and mode of x-dockge.zfs are not applied: the conversion keeps those of the folder");
    }
    return {
        kind: "volume",
        stack: stackName,
        display,
        target,
        backup: `${target}${BACKUP_MARK}${timestamp()}`,
        dataset: `${parentDataset}/${path.basename(target)}`,
        parentDataset: stackDataset,
        snapshotName: `dockge-premigration-${timestamp()}`,
        size: await treeSize(target),
        available: getSpace(target)?.available ?? null,
        running: await isRunning(stack),
        recipe: recipe ? { recordsize: recipe.recordsize,
            compression: recipe.compression,
            atime: recipe.atime,
            quota: recipe.quota } : undefined,
        warnings,
    };
}

/**
 * Plan the conversion of the folder of a stack into a dataset
 */
export async function planStackConversion(server : DockgeServer, stackName : string) : Promise<ConversionPlan> {
    const { status } = await getCreationContext(server);
    if (!status.stacksIsDatasetRoot || !status.dataset) {
        throw new ValidationError("The stacks folder is not the root of a dataset");
    }
    const stack = await Stack.getStack(server, stackName);
    if (!stack.isManagedByDockge) {
        throw new ValidationError("This stack is not managed by Dockge");
    }
    const target = path.join(status.stacksDir, stackName);
    if (isDatasetMount(target)) {
        throw new ValidationError(`The stack ${stackName} is already a dataset`);
    }
    checkNoMountsInside(target, `The folder of ${stackName}`);
    return {
        kind: "stack",
        stack: stackName,
        display: stackName,
        target,
        backup: `${target}${BACKUP_MARK}${timestamp()}`,
        dataset: `${status.dataset}/${stackName}`,
        parentDataset: status.dataset,
        snapshotName: `dockge-premigration-${stackName}-${timestamp()}`,
        size: await treeSize(target),
        available: getSpace(target)?.available ?? null,
        running: await isRunning(stack),
        recipe: undefined,
        warnings: [],
    };
}

/**
 * Run a conversion (job)
 */
async function runConversion(server : DockgeServer, plan : ConversionPlan, context : JobContext, provider : ZfsProvider) {
    const stack = await Stack.getStack(server, plan.stack);
    // This instance may stop and start the stack while the job holds it
    stack.insideJob = true;
    let moved = false;
    let created = false;
    try {
        if (plan.running) {
            context.setStep("stopping the stack", 2);
            await stack.stop();
        }
        context.checkCancelled();

        context.setStep(`safety snapshot ${plan.parentDataset}@${plan.snapshotName}`, 4);
        try {
            await provider.createSnapshot(plan.parentDataset, plan.snapshotName, plan.kind === "volume");
        } catch (e) {
            context.log(`Safety snapshot not taken (${e instanceof Error ? e.message : e}): the folder is kept as a copy anyway`);
        }
        context.checkCancelled();

        context.setStep(`moving ${plan.display} to ${path.basename(plan.backup)}`, 6);
        await fsAsync.rename(plan.target, plan.backup);
        moved = true;

        context.setStep(`creating the dataset ${plan.dataset}`, 8);
        const userProperties : Record<string, string> = {
            [MANAGED_PROPERTY]: "true",
            [STACK_PROPERTY]: plan.stack,
            [MIGRATION_PROPERTY]: "copying",
        };
        if (plan.kind === "volume") {
            userProperties[VOLUME_PROPERTY] = path.relative(path.join(server.stacksDir, plan.stack), plan.target);
        }
        await provider.createDataset(plan.dataset, recipeToCreateOptions(plan.recipe, userProperties));
        created = true;
        await waitForMount(plan.target, plan.dataset);

        context.setStep(`copying ${plan.size.files} files, ${formatSize(plan.size.bytes)}`, 10);
        context.setBytes(0, plan.size.bytes);
        await copyTree(plan.backup, plan.target, context, plan.size.bytes);
        // The root of the new dataset gets owner, mode and times of the folder
        const original = await fsAsync.stat(plan.backup);
        await fsAsync.chown(plan.target, original.uid, original.gid);
        await fsAsync.chmod(plan.target, original.mode & 0o7777);

        context.setStep("verifying the copy", 96);
        const copied = await treeSize(plan.target);
        const source = await treeSize(plan.backup);
        if (copied.files !== source.files || copied.directories !== source.directories || copied.bytes !== source.bytes) {
            throw new Error(`The copy differs from the original: ${copied.files} files / ${copied.directories} folders / ${copied.bytes} bytes instead of ${source.files} / ${source.directories} / ${source.bytes}`);
        }

        await provider.setUserProperties(plan.dataset, {
            [MIGRATION_PROPERTY]: "done",
        });
        if (plan.running) {
            context.setStep("starting the stack", 98);
            await stack.startContainers();
        }
        context.log(`Converted. The original folder is kept as ${path.basename(plan.backup)} until you delete it.`);
        return publicPlan(plan);
    } catch (e) {
        context.log(`Error: ${e instanceof Error ? e.message : e}. Restoring the folder.`);
        try {
            if (created) {
                await withDatasetReleased(plan.target, () => provider.deleteDataset(plan.dataset, true));
                const start = Date.now();
                while (datasetsInside(plan.target).length > 0 && Date.now() - start < 20000) {
                    await new Promise((resolve) => setTimeout(resolve, 250));
                }
                await fsAsync.rm(plan.target, {
                    recursive: true,
                    force: true,
                });
            }
            if (moved) {
                await fsAsync.rename(plan.backup, plan.target);
            }
            context.log("The folder is back as it was.");
        } catch (restoreError) {
            context.log(`Could not restore automatically: ${restoreError instanceof Error ? restoreError.message : restoreError}. The original data is in ${plan.backup}.`);
        }
        if (plan.running) {
            await stack.startContainers().catch(() => {});
        }
        throw e;
    } finally {
        forgetStackDatasets(isDatasetMount(path.join(server.stacksDir, plan.stack)) ?? "");
    }
}

/**
 * Convert ./relative of a stack, or the stack folder itself (relative null), into a dataset
 * @returns The plan (dryRun) or the started job
 */
export async function convertToDataset(server : DockgeServer, stackName : string, relative : string | null, dryRun : boolean, onChange? : () => void) {
    const plan = relative === null ? await planStackConversion(server, stackName) : await planVolumeConversion(server, stackName, relative);
    if (dryRun) {
        return {
            dryRun: true,
            ...publicPlan(plan),
        };
    }
    await checkSpace(plan);
    const { provider } = await getCreationContext(server);
    const job = startJob(plan.kind === "stack" ? "convert stack" : "convert volume", stackName, plan.display, (context) => runConversion(server, plan, context, provider), onChange);
    return {
        job: job.id,
        ...publicPlan(plan),
    };
}

export interface MigrationBackup {
    /** Name as shown, e.g. "./library.dockge-backup-20261117-101500" or "immich.dockge-backup-..." */
    name : string;
    path : string;
    kind : "volume" | "stack";
}

/**
 * Copies kept by the conversions of a stack: its volume folders (any depth up to 4) and the stack folder itself
 */
export async function listMigrationBackups(server : DockgeServer, stackName : string) : Promise<MigrationBackup[]> {
    const stacksDir = fs.realpathSync(server.stacksDir);
    const stackDir = path.join(stacksDir, stackName);
    const result : MigrationBackup[] = [];
    for (const entry of await fsAsync.readdir(stacksDir).catch(() => [] as string[])) {
        if (entry.startsWith(stackName + BACKUP_MARK)) {
            result.push({
                name: entry,
                path: path.join(stacksDir, entry),
                kind: "stack",
            });
        }
    }
    const walk = async (dir : string, depth : number) => {
        if (depth > 4) {
            return;
        }
        for (const entry of await fsAsync.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (!entry.isDirectory()) {
                continue;
            }
            const target = path.join(dir, entry.name);
            if (entry.name.includes(BACKUP_MARK)) {
                result.push({
                    name: "./" + path.relative(stackDir, target).split(path.sep).join("/"),
                    path: target,
                    kind: "volume",
                });
            } else {
                await walk(target, depth + 1);
            }
        }
    };
    if (fs.existsSync(stackDir)) {
        await walk(stackDir, 1);
    }
    return result;
}

/**
 * Delete a copy kept by a conversion (job: it can be large)
 */
export async function deleteMigrationBackup(server : DockgeServer, stackName : string, name : string, dryRun = false, onChange? : () => void) {
    const backup = (await listMigrationBackups(server, stackName)).find((item) => item.name === name || path.basename(item.path) === name);
    if (!backup) {
        throw new ValidationError(`Backup ${name} not found for the stack ${stackName}`);
    }
    if (datasetsInside(backup.path).length > 0) {
        throw new ValidationError(`${backup.name} contains mounted datasets: it is not deleted`);
    }
    const size = await treeSize(backup.path);
    if (dryRun) {
        return {
            dryRun: true,
            backup: backup.name,
            files: size.files,
            size: formatSize(size.bytes),
        };
    }
    const job = startJob("delete backup", stackName, backup.name, async (context) => {
        context.setStep(`deleting ${backup.name} (${size.files} files, ${formatSize(size.bytes)})`, 10);
        await fsAsync.rm(backup.path, {
            recursive: true,
            force: true,
        });
        log.info("zfs", `Deleted the conversion backup ${backup.path}`);
        return {
            deleted: backup.name,
        };
    }, onChange);
    return {
        job: job.id,
        backup: backup.name,
    };
}

/**
 * Undo a conversion interrupted by a restart of Dockge (dataset still marked dockge:migration=copying):
 * destroy the new dataset and put the original folder back from its copy
 */
export async function abortInterruptedConversion(server : DockgeServer, stackName : string, relative : string | null) {
    const { status, provider } = await getCreationContext(server);
    const stackDir = path.join(status.stacksDir, stackName);
    const target = relative === null ? stackDir : path.join(stackDir, normalizeVolumePath(relative));
    const dataset = isDatasetMount(target);
    if (!dataset) {
        throw new ValidationError("No dataset there: nothing to undo");
    }
    const [ info ] = await provider.getDatasets(dataset, false);
    if (info?.userProperties[MIGRATION_PROPERTY] !== "copying") {
        throw new ValidationError(`${dataset} is not an interrupted conversion`);
    }
    const parent = path.dirname(target);
    const backups = (await fsAsync.readdir(parent)).filter((name) => name.startsWith(path.basename(target) + BACKUP_MARK)).sort();
    if (backups.length === 0) {
        throw new ValidationError("The copy of the original folder was not found: undo it in TrueNAS");
    }
    const backup = path.join(parent, backups[backups.length - 1]);
    if (datasetsInside(target).some((name) => name !== dataset)) {
        throw new ValidationError(`${dataset} has child datasets: undo it in TrueNAS`);
    }
    await withDatasetReleased(target, () => provider.deleteDataset(dataset, true));
    const start = Date.now();
    while (datasetsInside(target).length > 0 && Date.now() - start < 20000) {
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await fsAsync.rm(target, {
        recursive: true,
        force: true,
    });
    await fsAsync.rename(backup, target);
    forgetStackDatasets(isDatasetMount(stackDir) ?? "");
    log.info("zfs", `Interrupted conversion of ${target} undone: ${dataset} destroyed, ${backup} restored`);
    return {
        ok: true,
        restored: target,
        destroyed: dataset,
    };
}
