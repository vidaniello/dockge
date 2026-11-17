import fs from "fs";
import path from "path";
import { DockgeServer } from "../dockge-server";
import { Stack } from "../stack";
import { ValidationError } from "../util-server";
import { log } from "../log";
import { RUNNING } from "../../common/util-common";
import { analyzeBindMountsUnder, rewriteBindMounts } from "../bind-mounts";
import { explainAdminOnly, withDatasetReleased, getCreationContext, isDatasetMount, MANAGED_PROPERTY, STACK_PROPERTY, VOLUME_PROPERTY, waitForMount } from "./datasets";
import { normalizeVolumePath } from "./recipe";
import { forgetStackDatasets } from "./storage";

/**
 * Adoption of an existing dataset into a stack (docs/ZFS-DESIGN.md §6.4): a dataset created elsewhere
 * (e.g. pool/appdata/immich/library, bound with an absolute path) is renamed to <stack dataset>/<name>. In the same
 * pool nothing is copied, it is instant; its inherited mountpoint mounts it at ./name, and the bind mounts of the
 * compose file are rewritten as ./name. Shares and tasks of TrueNAS that point to the old name must be updated by hand:
 * they are listed before.
 */

export async function adoptDataset(server : DockgeServer, stackName : string, source : string, relative : string, dryRun : boolean) {
    const { status, provider } = await getCreationContext(server);
    const stack = await Stack.getStack(server, stackName);
    if (!stack.isManagedByDockge) {
        throw new ValidationError("This stack is not managed by Dockge");
    }
    const stackDir = path.join(status.stacksDir, stackName);
    const stackDataset = isDatasetMount(stackDir);
    if (!stackDataset) {
        throw new ValidationError(`The stack ${stackName} is a folder: convert it to a dataset first`);
    }
    const clean = normalizeVolumePath(relative);
    const target = path.join(stackDir, clean);
    if (fs.existsSync(target)) {
        throw new ValidationError(`./${clean} already exists in the stack: choose another name`);
    }
    const parentDataset = isDatasetMount(path.dirname(target));
    if (!parentDataset) {
        throw new ValidationError(`./${path.dirname(clean)} is not a dataset: it cannot contain an adopted dataset`);
    }

    if (typeof source !== "string" || !/^[A-Za-z0-9_.:-]+(\/[A-Za-z0-9_.: -]+)+$/.test(source)) {
        throw new ValidationError("Invalid dataset name");
    }
    const [ info ] = await provider.getDatasets(source, false);
    if (!info) {
        throw new ValidationError(`Dataset ${source} not found`);
    }
    if (source.split("/")[0] !== stackDataset.split("/")[0]) {
        throw new ValidationError(`${source} is in another pool: it cannot be renamed into ${stackDataset} (it would need a copy)`);
    }
    if (source === status.dataset || (status.dataset && (status.dataset.startsWith(source + "/") || source.startsWith(status.dataset + "/")))) {
        throw new ValidationError(`${source} is the stacks dataset, contains it, or is already inside it`);
    }
    if (info.mountpoint && info.mountpoint !== "/mnt/" + source) {
        throw new ValidationError(`${source} has its own mountpoint (${info.mountpoint}): set it back to inherited in TrueNAS first`);
    }
    const destination = `${parentDataset}/${path.basename(target)}`;

    // Bind mounts of this stack that use the dataset: rewritten as ./name
    const oldMount = info.mountpoint ?? "/mnt/" + source;
    const binds = analyzeBindMountsUnder(stack.composeYAML, oldMount, "./" + clean);

    // Other stacks that use it would lose it
    const otherStacks : string[] = [];
    for (const [ name, other ] of await Stack.getStackList(server)) {
        if (name !== stackName && other.isManagedByDockge && analyzeBindMountsUnder(other.composeYAML, oldMount, "./x").rewrites.length > 0) {
            otherStacks.push(name);
        }
    }

    let attachments : { type : string, attachments : string[] }[] = [];
    const warnings : string[] = [];
    try {
        attachments = await provider.getAttachments(source);
    } catch (e) {
        warnings.push(`Cannot read the shares and tasks of ${source}: ${e instanceof Error ? e.message : e}`);
    }
    if (otherStacks.length > 0) {
        warnings.push(`Also used by the stacks ${otherStacks.join(", ")}: their paths would point to a folder that no longer exists`);
    }
    if (binds.rewrites.length === 0) {
        warnings.push(`No bind mount of ${stackName} uses ${oldMount}: add ./${clean} to the compose file yourself`);
    }

    await stack.updateStatus();
    const running = stack.status === RUNNING;
    const plan = {
        source,
        destination,
        path: "./" + clean,
        oldMountpoint: oldMount,
        rewrites: binds.rewrites.map((rewrite) => ({
            service: rewrite.service,
            from: rewrite.from,
            to: rewrite.to,
        })),
        attachments,
        otherStacks,
        stopsAndStartsStack: running,
        warnings,
    };
    if (dryRun) {
        return {
            dryRun: true,
            ...plan,
        };
    }

    if (running) {
        await stack.stop();
    }
    try {
        await withDatasetReleased(oldMount, () => provider.renameDataset(source, destination));
    } catch (e) {
        if (running) {
            await stack.startContainers().catch(() => {});
        }
        throw explainAdminOnly(e, `move ${source}`);
    }
    await waitForMount(target, destination);
    try {
        await provider.setUserProperties(destination, {
            [MANAGED_PROPERTY]: "true",
            [STACK_PROPERTY]: stackName,
            [VOLUME_PROPERTY]: clean,
        });
    } catch (e) {
        warnings.push(`User properties not set: ${e instanceof Error ? e.message : e}`);
    }
    if (binds.rewrites.length > 0) {
        fs.writeFileSync(path.join(stack.path, stack.composeFileName), rewriteBindMounts(stack.composeYAML, binds.rewrites));
    }
    forgetStackDatasets(stackDataset);
    log.info("zfs", `Adopted ${source} as ${destination} (./${clean} of ${stackName})`);
    if (running) {
        // The compose file changed: recreate the containers with the new paths
        const updated = await Stack.getStack(server, stackName);
        await updated.composeUp();
    }
    return {
        ok: true,
        ...plan,
    };
}
