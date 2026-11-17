import fs from "fs";
import path from "path";
import yaml from "yaml";
import { DockgeServer } from "../dockge-server";
import { Stack } from "../stack";
import { ValidationError } from "../util-server";
import { log } from "../log";
import { RUNNING } from "../../common/util-common";
import { analyzeBindMounts, rewriteBindMounts } from "../bind-mounts";
import { setStringIn } from "../yaml-text-edit";
import { getCreationContext, isDatasetMount, MANAGED_PROPERTY, STACK_PROPERTY, waitForMount } from "./datasets";
import { getZfsSettings } from "./settings";
import { forgetStackDatasets } from "./storage";
import { SnapshotInfo, ZfsProvider } from "./provider";
import { TrueNasError } from "./truenas-client";

/**
 * Snapshots of a stack (docs/ZFS-DESIGN.md §6.7, phase 3). A snapshot of a stack is a recursive snapshot of its
 * dataset: compose.yaml, .env and the data of every volume dataset at the same instant.
 *
 * Names: dockge-<YYYYMMDD-HHMMSS>[-label] (manual), dockge-auto-<YYYYMMDD-HHMMSS> (before "Update").
 * Periodic snapshots stay with the snapshot tasks of TrueNAS: they are listed too.
 */

export type SnapshotKind = "manual" | "auto" | "other";

export interface StackSnapshot {
    /** Snapshot name (after @) */
    name : string;
    /** <stack dataset>@<name> */
    id : string;
    kind : SnapshotKind;
    label : string | null;
    created : number | null;
    /** Space held only by this snapshot, sum over the datasets of the stack */
    used : number | null;
    /** Datasets of the stack that have this snapshot */
    datasets : string[];
    /** Every current dataset of the stack has it (datasets created later do not) */
    complete : boolean;
}

export interface StackSnapshots {
    stack : string;
    dataset : string;
    datasets : string[];
    snapshots : StackSnapshot[];
}

const AUTO_PREFIX = "dockge-auto-";
const MANUAL_PREFIX = "dockge-";

function timestamp(date = new Date()) : string {
    const pad = (value : number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function snapshotKind(name : string) : SnapshotKind {
    if (name.startsWith(AUTO_PREFIX)) {
        return "auto";
    }
    return name.startsWith(MANUAL_PREFIX) ? "manual" : "other";
}

function labelOf(name : string) : string | null {
    const match = /^dockge-\d{8}-\d{6}-(.+)$/.exec(name);
    return match ? match[1] : null;
}

/**
 * Message for an error of the provider: rollback and clone of TrueNAS 25.04 are allowed only to full administrators
 */
function explain(e : unknown, action : "rollback" | "clone" | "snapshot" | "delete") : Error {
    const message = e instanceof Error ? e.message : String(e);
    if (/not authori[sz]ed|EACCES|ENOTAUTHORIZED|permission/i.test(message)) {
        const hints = {
            rollback: "TrueNAS 25.04 allows a rollback only to a full administrator: use the API key of an admin user, or do it in TrueNAS (Datasets → the stack dataset → Snapshots → Rollback, with \"recursive\"), with the stack stopped.",
            clone: "TrueNAS 25.04 allows a clone only to a full administrator: use the API key of an admin user, or clone the snapshot in TrueNAS.",
            snapshot: "The TrueNAS user needs the SNAPSHOT_WRITE role.",
            delete: "The TrueNAS user needs the SNAPSHOT_DELETE role.",
        };
        return new ValidationError(`TrueNAS refused the ${action}: ${message}. ${hints[action]}`);
    }
    return e instanceof Error ? e : new Error(message);
}

interface StackContext {
    stack : Stack;
    provider : ZfsProvider;
    stackDataset : string;
    stacksDataset : string;
    stacksDir : string;
}

async function stackContext(server : DockgeServer, stackName : string) : Promise<StackContext> {
    const { status, provider } = await getCreationContext(server);
    const stack = await Stack.getStack(server, stackName);
    if (!stack.isManagedByDockge) {
        throw new ValidationError("This stack is not managed by Dockge");
    }
    const stackDataset = isDatasetMount(stack.path);
    if (!stackDataset || !status.dataset || !stackDataset.startsWith(status.dataset + "/")) {
        throw new ValidationError(`The stack ${stackName} is not a dataset: snapshots are not available`);
    }
    return {
        stack,
        provider,
        stackDataset,
        stacksDataset: status.dataset,
        stacksDir: status.stacksDir,
    };
}

async function snapshotsOf(context : StackContext) : Promise<StackSnapshots> {
    const datasets = (await context.provider.getDatasets(context.stackDataset, true))
        .map((dataset) => dataset.name)
        .filter((name) => name === context.stackDataset || name.startsWith(context.stackDataset + "/"));
    let list : SnapshotInfo[];
    try {
        list = await context.provider.listSnapshots(datasets);
    } catch (e) {
        throw explain(e, "snapshot");
    }

    const byName = new Map<string, SnapshotInfo[]>();
    for (const snapshot of list) {
        byName.set(snapshot.name, [ ...(byName.get(snapshot.name) ?? []), snapshot ]);
    }

    const snapshots : StackSnapshot[] = [];
    for (const [ name, items ] of byName) {
        const root = items.find((item) => item.dataset === context.stackDataset);
        // A snapshot of a single volume (e.g. a TrueNAS task on a child) is not a snapshot of the stack
        if (!root) {
            continue;
        }
        const used = items.reduce<number | null>((sum, item) => (item.used === null ? sum : (sum ?? 0) + item.used), null);
        snapshots.push({
            name,
            id: root.id,
            kind: snapshotKind(name),
            label: labelOf(name),
            created: root.created,
            used,
            datasets: items.map((item) => item.dataset).sort(),
            complete: datasets.every((dataset) => items.some((item) => item.dataset === dataset)),
        });
    }
    snapshots.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || b.name.localeCompare(a.name));
    return {
        stack: context.stack.name,
        dataset: context.stackDataset,
        datasets,
        snapshots,
    };
}

export async function listStackSnapshots(server : DockgeServer, stackName : string) : Promise<StackSnapshots> {
    return snapshotsOf(await stackContext(server, stackName));
}

async function isRunning(stack : Stack) : Promise<boolean> {
    await stack.updateStatus();
    return stack.status === RUNNING;
}

export interface CreateSnapshotOptions {
    label? : string;
    /** Stop the containers during the snapshot (consistent copy of databases), then start them again */
    stopFirst? : boolean;
    /** Automatic snapshot before an update */
    auto? : boolean;
    dryRun? : boolean;
}

export async function createStackSnapshot(server : DockgeServer, stackName : string, options : CreateSnapshotOptions = {}) {
    const context = await stackContext(server, stackName);
    let label = "";
    if (options.label !== undefined && options.label !== null && String(options.label).trim() !== "") {
        label = String(options.label).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
        if (!label) {
            throw new ValidationError("Invalid label: use letters, digits, - and _");
        }
    }
    const name = options.auto ? AUTO_PREFIX + timestamp() : MANUAL_PREFIX + timestamp() + (label ? "-" + label : "");
    const id = `${context.stackDataset}@${name}`;
    const running = await isRunning(context.stack);
    const stop = options.stopFirst === true && running;

    if (options.dryRun) {
        return {
            dryRun: true,
            snapshot: id,
            name,
            recursive: true,
            stopsContainers: stop,
        };
    }

    if (stop) {
        await context.stack.stop();
    }
    try {
        await context.provider.createSnapshot(context.stackDataset, name, true);
    } catch (e) {
        throw explain(e, "snapshot");
    } finally {
        if (stop) {
            await context.stack.startContainers();
        }
    }
    log.info("zfs", `Snapshot ${id} (recursive)${stop ? ", containers stopped during it" : ""}`);
    return {
        snapshot: id,
        name,
        stoppedContainers: stop,
    };
}

/**
 * Keep the newest autoSnapshotKeep dockge-auto-* snapshots of the stack
 */
async function pruneAutoSnapshots(context : StackContext, keep : number) : Promise<string[]> {
    const warnings : string[] = [];
    const { snapshots } = await snapshotsOf(context);
    const auto = snapshots.filter((snapshot) => snapshot.kind === "auto");
    for (const snapshot of auto.slice(keep)) {
        try {
            await context.provider.deleteSnapshot(snapshot.id, true);
            log.info("zfs", `Deleted old automatic snapshot ${snapshot.id}`);
        } catch (e) {
            warnings.push(`Cannot delete the old automatic snapshot ${snapshot.name}: ${explain(e, "delete").message}`);
        }
    }
    return warnings;
}

/**
 * Before "Update" recreates the containers: an automatic snapshot (setting, or the snapshot option of update_stack).
 * Nothing happens when the stack is not a dataset or datasets cannot be used.
 * @returns The snapshot taken and warnings, or null when no snapshot was taken
 */
export async function snapshotBeforeUpdate(server : DockgeServer, stack : Stack, requested : boolean | undefined) : Promise<{ snapshot : string, warnings : string[] } | null> {
    const settings = await getZfsSettings();
    if (requested === false || (requested === undefined && !settings.autoSnapshotBeforeUpdate)) {
        return null;
    }
    if (!isDatasetMount(stack.path)) {
        if (requested === true) {
            throw new ValidationError("The stack is not a dataset: no snapshot can be taken before the update");
        }
        return null;
    }
    let context : StackContext;
    try {
        context = await stackContext(server, stack.name);
    } catch (e) {
        if (requested === true) {
            throw e;
        }
        // Datasets not usable right now (e.g. TrueNAS not configured): update as before
        log.debug("zfs", `No snapshot before the update of ${stack.name}: ${e instanceof Error ? e.message : e}`);
        return null;
    }
    const result = await createStackSnapshot(server, stack.name, {
        auto: true,
    }).catch((e) => {
        throw new ValidationError(`The automatic snapshot before the update failed, the update was not done: ${e instanceof Error ? e.message : e}. Disable "snapshot before Update" (or pass snapshot: false) to update without it.`);
    });
    const warnings = await pruneAutoSnapshots(context, settings.autoSnapshotKeep);
    return {
        snapshot: String(result.snapshot),
        warnings,
    };
}

function findSnapshot(list : StackSnapshots, name : string) : StackSnapshot {
    const snapshot = list.snapshots.find((item) => item.name === name || item.id === name);
    if (!snapshot) {
        throw new ValidationError(`Snapshot ${name} not found for the stack ${list.stack}`);
    }
    return snapshot;
}

/**
 * Roll the stack back to a snapshot: stop it, roll back every dataset that has the snapshot, start it again.
 * Newer snapshots are destroyed (ZFS cannot keep them after a rollback).
 */
export async function rollbackStack(server : DockgeServer, stackName : string, snapshotName : string, dryRun = false) {
    const context = await stackContext(server, stackName);
    const list = await snapshotsOf(context);
    const snapshot = findSnapshot(list, snapshotName);
    const newer = list.snapshots.filter((item) => (item.created ?? 0) > (snapshot.created ?? 0));
    const untouched = list.datasets.filter((dataset) => !snapshot.datasets.includes(dataset));
    const running = await isRunning(context.stack);
    const plan = {
        snapshot: snapshot.id,
        datasets: snapshot.datasets,
        /** Destroyed by the rollback */
        newerSnapshots: newer.map((item) => item.name),
        /** Created after the snapshot: not rolled back */
        untouchedDatasets: untouched,
        stopsAndStartsContainers: running,
    };
    if (dryRun) {
        return {
            dryRun: true,
            ...plan,
        };
    }

    if (running) {
        await context.stack.stop();
    }
    try {
        await context.provider.rollbackSnapshot(snapshot.id);
    } catch (e) {
        if (running) {
            await context.stack.startContainers().catch(() => {});
        }
        throw explain(e, "rollback");
    }
    forgetStackDatasets(context.stackDataset);
    log.info("zfs", `Stack ${stackName} rolled back to ${snapshot.id}; destroyed newer snapshots: ${plan.newerSnapshots.join(", ") || "none"}`);
    if (running) {
        await context.stack.startContainers();
    }
    return {
        ok: true,
        ...plan,
    };
}

/**
 * New stack from a snapshot: every dataset of the stack that has it is cloned under <stacks dataset>/<newName>.
 * The new stack is not started. Its datasets depend on the snapshot (it cannot be deleted while they exist).
 */
export async function cloneStack(server : DockgeServer, stackName : string, snapshotName : string, newName : string, dryRun = false) {
    const context = await stackContext(server, stackName);
    const list = await snapshotsOf(context);
    const snapshot = findSnapshot(list, snapshotName);

    if (typeof newName !== "string" || !/^[a-z0-9_-]+$/.test(newName)) {
        throw new ValidationError("Invalid name: lowercase letters, digits, - and _");
    }
    const target = path.join(context.stacksDir, newName);
    if (fs.existsSync(target)) {
        throw new ValidationError("Stack name already exists");
    }
    const statusList = await Stack.getStatusList();
    if (statusList.has(newName)) {
        throw new ValidationError("A compose project with this name already exists");
    }

    // Parents first: a child clone needs its parent
    const steps = snapshot.datasets
        .slice()
        .sort((a, b) => a.split("/").length - b.split("/").length)
        .map((dataset) => {
            const relative = dataset.slice(context.stackDataset.length);
            return {
                from: `${dataset}@${snapshot.name}`,
                to: `${context.stacksDataset}/${newName}${relative}`,
                path: path.join(target, relative),
            };
        });
    const warnings : string[] = [];
    const missing = list.datasets.filter((dataset) => !snapshot.datasets.includes(dataset));
    if (missing.length > 0) {
        warnings.push(`Not in the snapshot (created later), their folders are empty in the clone: ${missing.join(", ")}`);
    }

    // The compose file of the snapshot is the one of the clone: check what would conflict
    let content = context.stack.composeYAML;
    try {
        const snapshotFile = path.join(context.stack.path, ".zfs", "snapshot", snapshot.name, path.basename(context.stack.composeFileName));
        if (fs.existsSync(snapshotFile)) {
            content = fs.readFileSync(snapshotFile, "utf-8");
        }
    } catch (e) {
        // .zfs not reachable from the container: use the current file for the warnings
    }
    try {
        const config = yaml.parse(content) ?? {};
        for (const [ service, definition ] of Object.entries((config.services ?? {}) as Record<string, { container_name? : string, ports? : unknown[] }>)) {
            if (definition?.container_name) {
                warnings.push(`Service ${service} has container_name "${definition.container_name}": change it in the clone before starting it, or it conflicts with ${stackName}`);
            }
            if (Array.isArray(definition?.ports) && definition.ports.length > 0) {
                warnings.push(`Service ${service} publishes ports: change them in the clone before starting it, or they conflict with ${stackName}`);
            }
        }
    } catch (e) {
        // invalid file: nothing to check
    }

    if (dryRun) {
        return {
            dryRun: true,
            name: newName,
            snapshot: snapshot.id,
            clones: steps.map((step) => ({
                from: step.from,
                to: step.to,
            })),
            warnings,
        };
    }

    for (const step of steps) {
        try {
            await context.provider.cloneSnapshot(step.from, step.to, {
                [MANAGED_PROPERTY]: "true",
                [STACK_PROPERTY]: newName,
            });
        } catch (e) {
            throw explain(e, "clone");
        }
        await waitForMount(step.path, step.to);
    }
    log.info("zfs", `Stack ${stackName} cloned from ${snapshot.id} as ${newName}`);

    // Absolute bind mounts into the old stack folder become relative (as on rename), the project name follows the folder
    const clone = await Stack.getStack(server, newName);
    let cloneContent = clone.composeYAML;
    const original = cloneContent;
    if (yaml.parse(cloneContent)?.name === stackName) {
        cloneContent = setStringIn(cloneContent, [ "name" ], newName);
    }
    const binds = analyzeBindMounts(cloneContent, context.stack.path);
    cloneContent = rewriteBindMounts(cloneContent, binds.rewrites);
    if (cloneContent !== original) {
        fs.writeFileSync(path.join(clone.path, clone.composeFileName), cloneContent);
    }

    return {
        ok: true,
        name: newName,
        snapshot: snapshot.id,
        clones: steps.map((step) => step.to),
        warnings,
    };
}

export async function deleteStackSnapshot(server : DockgeServer, stackName : string, snapshotName : string, dryRun = false) {
    const context = await stackContext(server, stackName);
    const snapshot = findSnapshot(await snapshotsOf(context), snapshotName);
    if (dryRun) {
        return {
            dryRun: true,
            snapshot: snapshot.id,
            datasets: snapshot.datasets,
        };
    }
    try {
        await context.provider.deleteSnapshot(snapshot.id, true);
    } catch (e) {
        if (e instanceof TrueNasError && /clone/i.test(e.message)) {
            throw new ValidationError(`The snapshot ${snapshot.name} has clones (stacks cloned from it): delete or promote them first. ${e.message}`);
        }
        throw explain(e, "delete");
    }
    log.info("zfs", `Deleted snapshot ${snapshot.id} (recursive)`);
    return {
        ok: true,
        snapshot: snapshot.id,
    };
}
