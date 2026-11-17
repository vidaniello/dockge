import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { AgentSocket } from "../../common/agent-socket";
import { LooseObject } from "../../common/util-common";
import { listDirectory } from "../file-browser";
import { getHostIPs } from "../host-ips";
import { FileService } from "../files";
import {
    addFolders, deleteFolder, deleteFolderOrder, removeFromOrder, renameFolderInOrder, renameStackInOrder,
    renameStoredFolders, setChildrenOrder, validateFolder
} from "../stack-folders";
import { imageUpdateChecker } from "../image-update-checker";
import { log } from "../log";
import { getStackStorage, getStorageStatus, resetProviderCache } from "../zfs/storage";
import { getZfsSettings, toPublic, updateZfsSettings } from "../zfs/settings";

/**
 * Handlers that gained an optional options object before the callback: accept both forms
 */
function optionsAndCallback(rest : unknown[]) : { options : LooseObject, callback : unknown } {
    const callback = rest[rest.length - 1];
    const options = rest.length > 1 && rest[0] && typeof(rest[0]) === "object" ? rest[0] as LooseObject : {};
    return {
        options,
        callback,
    };
}

export class DockerSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        // Do not call super.create()

        // options (optional): { dataset? : boolean, missingVolumes? : MissingVolumesChoice }
        agentSocket.on("deployStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, ...rest : unknown[]) => {
            const { options, callback } = optionsAndCallback(rest);
            let saved = false;
            try {
                checkLogin(socket);
                const stack = await this.saveStack(server, name, composeYAML, composeENV, isAdd, options);
                saved = true;
                await stack.deploy(socket, {
                    missingVolumes: options.missingVolumes,
                    acceptOtherStacks: options.acceptOtherStacks === true,
                    interactive: true,
                });
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Deployed",
                    msgi18n: true,
                }, callback);
                stack.joinCombinedTerminal(socket);
            } catch (e) {
                if (saved) {
                    // The stack exists now: a new attempt must not create it again
                    server.sendStackList();
                    (e as { data? : object }).data = {
                        ...((e as { data? : object }).data ?? {}),
                        saved: true,
                    };
                }
                callbackError(e, callback);
            }
        });

        agentSocket.on("saveStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, ...rest : unknown[]) => {
            const { options, callback } = optionsAndCallback(rest);
            try {
                checkLogin(socket);
                await this.saveStack(server, name, composeYAML, composeENV, isAdd, options);
                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // options (optional): { destroyDatasets: true, confirm: <stack name> }
        agentSocket.on("deleteStack", async (name : unknown, ...rest : unknown[]) => {
            const { options, callback } = optionsAndCallback(rest);
            try {
                checkLogin(socket);
                if (typeof(name) !== "string") {
                    throw new ValidationError("Name must be a string");
                }
                const destroyDatasets = options.destroyDatasets === true;
                if (destroyDatasets && options.confirm !== name) {
                    throw new ValidationError("Type the stack name to confirm");
                }
                const stack = await Stack.getStack(server, name);

                try {
                    await stack.delete(socket, {
                        destroyDatasets,
                    });
                } catch (e) {
                    server.sendStackList();
                    throw e;
                }

                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Deleted",
                    msgi18n: true,
                }, callback);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (stack.isManagedByDockge) {
                    stack.joinCombinedTerminal(socket);
                }

                callbackResult({
                    ok: true,
                    stack: await stack.toJSON(socket.endpoint),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // requestStackList
        agentSocket.on("requestStackList", async (callback) => {
            try {
                checkLogin(socket);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // startStack
        agentSocket.on("startStack", async (stackName : unknown, ...rest : unknown[]) => {
            const { options, callback } = optionsAndCallback(rest);
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.start(socket, {
                    missingVolumes: options.missingVolumes,
                    acceptOtherStacks: options.acceptOtherStacks === true,
                    interactive: true,
                });
                callbackResult({
                    ok: true,
                    msg: "Started",
                    msgi18n: true,
                }, callback);
                server.sendStackList();

                stack.joinCombinedTerminal(socket);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        // stopStack
        agentSocket.on("stopStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.stop(socket);
                callbackResult({
                    ok: true,
                    msg: "Stopped",
                    msgi18n: true,
                }, callback);
                server.sendStackList();

                stack.leaveCombinedTerminal(socket);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // restartStack
        agentSocket.on("restartStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.restart(socket);
                callbackResult({
                    ok: true,
                    msg: "Restarted",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // updateStack
        agentSocket.on("updateStack", async (stackName : unknown, ...rest : unknown[]) => {
            const { options, callback } = optionsAndCallback(rest);
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.update(socket, {
                    missingVolumes: options.missingVolumes,
                    acceptOtherStacks: options.acceptOtherStacks === true,
                    interactive: true,
                });

                // Refresh the update badge of this stack
                imageUpdateChecker.checkStack(stackName).catch((e) => log.debug("image-update", String(e)));
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Check if newer images are available, for one stack or for all stacks ("")
        agentSocket.on("checkImageUpdates", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                if (stackName) {
                    await imageUpdateChecker.checkStack(stackName);
                } else {
                    await imageUpdateChecker.checkAll();
                }

                callbackResult({
                    ok: true,
                    msg: "imageUpdateCheckDone",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // IP addresses of the host, to bind published ports to a specific IP
        agentSocket.on("getHostIPs", async (callback) => {
            try {
                checkLogin(socket);
                callbackResult({
                    ok: true,
                    ...(await getHostIPs()),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Browse the host folders mounted into Dockge (read-only), for the volume path picker
        agentSocket.on("listDirectory", async (dirPath : unknown, showFiles : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(dirPath) !== "string") {
                    throw new ValidationError("Path must be a string");
                }

                callbackResult({
                    ok: true,
                    ...(await listDirectory(dirPath, showFiles === true, server.stacksDir)),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // ZFS status of the stacks folder (read-only)
        agentSocket.on("getStorageStatus", async (...rest : unknown[]) => {
            const { options, callback } = optionsAndCallback(rest);
            try {
                checkLogin(socket);
                if (options.refresh === true) {
                    resetProviderCache();
                }
                callbackResult({
                    ok: true,
                    status: await getStorageStatus(server),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // ZFS settings of this instance (the API key of TrueNAS is never sent back)
        agentSocket.on("getZfsSettings", async (callback) => {
            try {
                checkLogin(socket);
                callbackResult({
                    ok: true,
                    settings: toPublic(await getZfsSettings()),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Save ZFS settings, then check them: the result is the new storage status
        agentSocket.on("setZfsSettings", async (changes : unknown, callback) => {
            try {
                checkLogin(socket);
                if (!changes || typeof(changes) !== "object") {
                    throw new ValidationError("Invalid settings");
                }
                const settings = await updateZfsSettings(changes as Record<string, unknown>);
                resetProviderCache();
                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                    settings: toPublic(settings),
                    status: await getStorageStatus(server),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Apply properties to an existing dataset of a stack (e.g. the values of x-dockge.zfs)
        agentSocket.on("setDatasetProperties", async (stackName : unknown, volumePath : unknown, properties : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || typeof(volumePath) !== "string" || !properties || typeof(properties) !== "object") {
                    throw new ValidationError("Invalid arguments");
                }
                const stack = await Stack.getStack(server, stackName);
                const { setDatasetProperties, isDatasetMount } = await import("../zfs/datasets");
                const { parseDatasetProperties } = await import("../zfs/recipe");
                const { forgetStackDatasets } = await import("../zfs/storage");
                const result = await setDatasetProperties(server, stack.name, volumePath, parseDatasetProperties(properties as Record<string, unknown>));
                forgetStackDatasets(isDatasetMount(stack.path) ?? "");
                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                    result,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Folders of a stack, for the "in this stack" tab of the path picker
        agentSocket.on("listStackFolder", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || !/^[a-z0-9_-]+$/.test(stackName)) {
                    throw new ValidationError("Invalid stack name");
                }
                const { listStackFolder } = await import("../zfs/storage");
                callbackResult({
                    ok: true,
                    ...(await listStackFolder(server, stackName)),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Snapshots of a stack that is a dataset (phase 3)
        agentSocket.on("listSnapshots", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);
                const { listStackSnapshots } = await import("../zfs/snapshots");
                callbackResult({
                    ok: true,
                    ...(await listStackSnapshots(server, String(stackName ?? ""))),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("createSnapshot", async (stackName : unknown, options : unknown, callback) => {
            try {
                checkLogin(socket);
                const { createStackSnapshot } = await import("../zfs/snapshots");
                const opts = (options && typeof(options) === "object" ? options : {}) as LooseObject;
                const result = await createStackSnapshot(server, String(stackName ?? ""), {
                    label: typeof(opts.label) === "string" ? opts.label : undefined,
                    stopFirst: opts.stopFirst === true,
                });
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "snapshotCreated",
                    msgi18n: true,
                    ...result,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // confirm: the snapshot name typed by the user
        agentSocket.on("rollbackSnapshot", async (stackName : unknown, snapshot : unknown, confirm : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(snapshot) !== "string" || confirm !== snapshot) {
                    throw new ValidationError("Type the snapshot name to confirm");
                }
                const { rollbackStack } = await import("../zfs/snapshots");
                const result = await rollbackStack(server, String(stackName ?? ""), snapshot);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "snapshotRolledBack",
                    msgi18n: true,
                    ...result,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("cloneStack", async (stackName : unknown, snapshot : unknown, newName : unknown, callback) => {
            try {
                checkLogin(socket);
                const { cloneStack } = await import("../zfs/snapshots");
                const result = await cloneStack(server, String(stackName ?? ""), String(snapshot ?? ""), String(newName ?? ""));
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "snapshotCloned",
                    msgi18n: true,
                    ...result,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("deleteSnapshot", async (stackName : unknown, snapshot : unknown, confirm : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(snapshot) !== "string" || confirm !== snapshot) {
                    throw new ValidationError("Type the snapshot name to confirm");
                }
                const { deleteStackSnapshot } = await import("../zfs/snapshots");
                const result = await deleteStackSnapshot(server, String(stackName ?? ""), snapshot);
                callbackResult({
                    ok: true,
                    msg: "snapshotDeleted",
                    msgi18n: true,
                    ...result,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // What deleting a stack would destroy (datasets, snapshots), for the delete dialog
        agentSocket.on("getStackDeletionInfo", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(stackName) !== "string" || !/^[a-z0-9_-]+$/.test(stackName)) {
                    throw new ValidationError("Invalid stack name");
                }
                const { getStackDeletionInfo } = await import("../zfs/datasets");
                callbackResult({
                    ok: true,
                    ...(await getStackDeletionInfo(server, stackName)),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Conversion of a folder (./path) or of the stack folder (path null) into a dataset: plan, then job
        agentSocket.on("convertToDataset", async (stackName : unknown, relative : unknown, dryRun : unknown, callback) => {
            try {
                checkLogin(socket);
                const { convertToDataset } = await import("../zfs/migrate");
                const result = await convertToDataset(server, String(stackName ?? ""), typeof(relative) === "string" && relative ? relative : null, dryRun === true, () => server.sendStackList());
                callbackResult({
                    ok: true,
                    ...result,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("adoptDataset", async (stackName : unknown, dataset : unknown, relative : unknown, dryRun : unknown, callback) => {
            try {
                checkLogin(socket);
                const { adoptDataset } = await import("../zfs/adopt");
                const result = await adoptDataset(server, String(stackName ?? ""), String(dataset ?? ""), String(relative ?? ""), dryRun === true);
                if (dryRun !== true) {
                    server.sendStackList();
                }
                callbackResult({
                    ...result,
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getStacksFolderScript", async (callback) => {
            try {
                checkLogin(socket);
                const { stacksFolderScript } = await import("../zfs/scripts");
                callbackResult({
                    ok: true,
                    ...(await stacksFolderScript(server)),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("findHiddenData", async (callback) => {
            try {
                checkLogin(socket);
                const { findHiddenData } = await import("../zfs/hidden");
                callbackResult({
                    ok: true,
                    list: await findHiddenData(server),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("recoverHiddenData", async (mountpoint : unknown, callback) => {
            try {
                checkLogin(socket);
                const { recoverHiddenData } = await import("../zfs/hidden");
                const result = await recoverHiddenData(server, String(mountpoint ?? ""));
                callbackResult({
                    ...result,
                    ok: true,
                    msg: "hiddenDataRecovered",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getZfsJob", async (id : unknown, callback) => {
            try {
                checkLogin(socket);
                const { getJob, jobSummary } = await import("../zfs/jobs");
                const job = getJob(String(id ?? ""));
                if (!job) {
                    throw new ValidationError("Job not found");
                }
                callbackResult({
                    ok: true,
                    job: jobSummary(job, 20),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("cancelZfsJob", async (id : unknown, callback) => {
            try {
                checkLogin(socket);
                const { cancelJob, jobSummary } = await import("../zfs/jobs");
                callbackResult({
                    ok: true,
                    job: jobSummary(cancelJob(String(id ?? "")), 20),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // options (optional): { dryRun: true } to get the size first
        agentSocket.on("deleteMigrationBackup", async (stackName : unknown, name : unknown, ...rest : unknown[]) => {
            const { options, callback } = optionsAndCallback(rest);
            try {
                checkLogin(socket);
                const { deleteMigrationBackup } = await import("../zfs/migrate");
                callbackResult({
                    ok: true,
                    ...(await deleteMigrationBackup(server, String(stackName ?? ""), String(name ?? ""), options.dryRun === true)),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("abortConversion", async (stackName : unknown, relative : unknown, callback) => {
            try {
                checkLogin(socket);
                const { abortInterruptedConversion } = await import("../zfs/migrate");
                const result = await abortInterruptedConversion(server, String(stackName ?? ""), typeof(relative) === "string" && relative ? relative : null);
                callbackResult({
                    ...result,
                    ok: true,
                    msg: "conversionAborted",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // File manager of the stack page (same service as the API: backend/files.ts)
        const fileHandler = (event : string, run : (files : FileService, ...args : unknown[]) => Promise<unknown>) => {
            agentSocket.on(event, async (stackName : unknown, ...rest : unknown[]) => {
                const callback = rest.pop();
                try {
                    checkLogin(socket);
                    const files = await FileService.forStack(server, stackName);
                    callbackResult({
                        ok: true,
                        result: await run(files, ...rest),
                    }, callback);
                } catch (e) {
                    callbackError(e, callback);
                }
            });
        };
        fileHandler("fsList", (files, dirPath) => files.list(dirPath));
        fileHandler("fsRead", (files, filePath, encoding) => files.read(filePath, encoding === "base64" ? "base64" : "utf8"));
        fileHandler("fsWrite", (files, filePath, options) => files.write(filePath, (options ?? {}) as Parameters<FileService["write"]>[1]));
        fileHandler("fsMkdir", (files, dirPath) => files.makeDir(dirPath));
        fileHandler("fsMove", (files, from, to) => files.move(from, to, false));
        fileHandler("fsDelete", (files, target, recursive) => files.remove(target, recursive === true));
        fileHandler("fsUploadChunk", (files, filePath, uploadId, offset, base64, last, overwrite) => {
            if (typeof(base64) !== "string") {
                throw new ValidationError("Invalid chunk");
            }
            return files.uploadChunk(filePath, uploadId, Number(offset) || 0, Buffer.from(base64, "base64"), last === true, overwrite === true);
        });

        // Datasets / folders of the bind mounts of a stack. composeYAML (optional): analyze the draft of the editor
        agentSocket.on("getStackStorage", async (stackName : unknown, composeYAML : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string" || !stackName) {
                    throw new ValidationError("Stack name must be a string");
                }
                if (composeYAML !== undefined && composeYAML !== null && typeof(composeYAML) !== "string") {
                    throw new ValidationError("composeYAML must be a string");
                }
                if (!/^[a-z0-9_-]+$/.test(stackName)) {
                    throw new ValidationError("Invalid stack name");
                }

                callbackResult({
                    ok: true,
                    storage: await getStackStorage(server, stackName, typeof(composeYAML) === "string" ? composeYAML : undefined),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Move a stack to a virtual folder of the sidebar ("" = no folder)
        agentSocket.on("setStackFolder", async (stackName : unknown, folder : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string" || typeof(folder) !== "string") {
                    throw new ValidationError("Stack name and folder must be strings");
                }

                const stack = await Stack.getStack(server, stackName);
                const oldFolder = stack.folder;
                await stack.setFolder(folder);
                // Both folders stay in the sidebar even if they become empty
                await addFolders(oldFolder, validateFolder(folder));
                if (oldFolder !== validateFolder(folder)) {
                    await removeFromOrder(oldFolder, "s:" + stack.name);
                }
                server.sendStackList();

                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Rename / move a virtual folder: updates every stack inside it (and in its sub folders)
        agentSocket.on("renameStackFolder", async (oldFolder : unknown, newFolder : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(oldFolder) !== "string" || typeof(newFolder) !== "string") {
                    throw new ValidationError("Folders must be strings");
                }

                const from = Stack.normalizeFolder(oldFolder);
                const to = Stack.normalizeFolder(newFolder);

                if (!from) {
                    throw new ValidationError("Invalid folder");
                }

                if (to === from || to.startsWith(from + "/")) {
                    throw new ValidationError("A folder cannot be moved inside itself");
                }
                validateFolder(to);

                const stackList = await Stack.getStackList(server);
                let count = 0;

                for (const stack of stackList.values()) {
                    if (!stack.isManagedByDockge) {
                        continue;
                    }
                    const folder = stack.folder;
                    if (folder === from || folder.startsWith(from + "/")) {
                        await stack.setFolder(to + folder.slice(from.length));
                        count++;
                    }
                }
                await renameStoredFolders(from, to);
                await renameFolderInOrder(from, to);

                server.sendStackList();
                callbackResult({
                    ok: true,
                    count,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Drag & drop in the sidebar: move a stack / folder into "toParent" and set the order of its children
        agentSocket.on("moveSidebarItem", async (item : unknown, toParent : unknown, order : unknown, callback) => {
            try {
                checkLogin(socket);
                if (!item || typeof(item) !== "object" || typeof(toParent) !== "string" || !Array.isArray(order)) {
                    throw new ValidationError("Invalid parameters");
                }
                const { kind, name, path } = item as { kind? : unknown, name? : unknown, path? : unknown };
                const parent = validateFolder(toParent);

                if (kind === "stack" && typeof(name) === "string") {
                    const stack = await Stack.getStack(server, name);
                    const oldFolder = stack.folder;
                    if (oldFolder !== parent) {
                        await stack.setFolder(parent);
                        await addFolders(oldFolder, parent);
                        await removeFromOrder(oldFolder, "s:" + stack.name);
                    }
                } else if (kind === "folder" && typeof(path) === "string") {
                    const from = validateFolder(path);
                    const to = parent ? parent + "/" + from.split("/").pop() : (from.split("/").pop() ?? "");
                    if (!from || parent === from || parent.startsWith(from + "/")) {
                        throw new ValidationError("A folder cannot be moved inside itself");
                    }
                    if (to !== from) {
                        const stackList = await Stack.getStackList(server);
                        for (const stack of stackList.values()) {
                            const folder = stack.isManagedByDockge ? stack.folder : "";
                            if (folder && (folder === from || folder.startsWith(from + "/"))) {
                                await stack.setFolder(to + folder.slice(from.length));
                            }
                        }
                        await renameStoredFolders(from, to);
                        await renameFolderInOrder(from, to);
                    }
                } else {
                    throw new ValidationError("Invalid item");
                }

                await setChildrenOrder(parent, order as string[]);
                server.sendStackList();
                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Create an (empty) folder in the sidebar
        agentSocket.on("createStackFolder", async (folder : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(folder) !== "string") {
                    throw new ValidationError("Folder must be a string");
                }
                const normalized = validateFolder(folder);
                if (!normalized) {
                    throw new ValidationError("The folder name is empty");
                }
                await addFolders(normalized);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    folder: normalized,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Delete an empty folder (and its empty sub folders)
        agentSocket.on("deleteStackFolder", async (folder : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(folder) !== "string" || !Stack.normalizeFolder(folder)) {
                    throw new ValidationError("Invalid folder");
                }
                const stackList = await Stack.getStackList(server);
                await deleteFolder(Stack.normalizeFolder(folder), [ ...stackList.values() ]);
                await deleteFolderOrder(Stack.normalizeFolder(folder));
                server.sendStackList();
                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Rename stack
        agentSocket.on("renameStack", async (stackName : unknown, newName : unknown, keepVolumes : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string" || typeof(newName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const folder = stack.folder;
                let warnings : string[];
                try {
                    ({ warnings } = await stack.rename(socket, newName, keepVolumes === true));
                    await renameStackInOrder(folder, stackName, newName);
                } finally {
                    server.sendStackList();
                }

                callbackResult({
                    ok: true,
                    msg: "Renamed",
                    msgi18n: true,
                    warnings,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Named volumes that would be recreated empty after a rename
        agentSocket.on("getProjectScopedVolumes", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                callbackResult({
                    ok: true,
                    volumes: stack.getProjectScopedVolumes(),
                    bindMounts: stack.getBindMountsInStackFolder(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // down stack
        agentSocket.on("downStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.down(socket);
                callbackResult({
                    ok: true,
                    msg: "Downed",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Services status
        agentSocket.on("serviceStatusList", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName, true);
                const serviceStatusList = Object.fromEntries(await stack.getServiceStatusList());
                callbackResult({
                    ok: true,
                    serviceStatusList,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Docker stats
        agentSocket.on("dockerStats", async (callback) => {
            try {
                checkLogin(socket);

                const dockerStats = Object.fromEntries(await server.getDockerStats());
                callbackResult({
                    ok: true,
                    dockerStats,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Start a service
        agentSocket.on("startService", async (stackName: unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof (stackName) !== "string" || typeof (serviceName) !== "string") {
                    throw new ValidationError("Stack name and service name must be strings");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.startService(socket, serviceName);
                stack.joinCombinedTerminal(socket); // Ensure the combined terminal is joined
                callbackResult({
                    ok: true,
                    msg: "Service " + serviceName + " started"
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Stop a service
        agentSocket.on("stopService", async (stackName: unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof (stackName) !== "string" || typeof (serviceName) !== "string") {
                    throw new ValidationError("Stack name and service name must be strings");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.stopService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: "Service " + serviceName + " stopped"
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("restartService", async (stackName: unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof stackName !== "string" || typeof serviceName !== "string") {
                    throw new Error("Invalid stackName or serviceName");
                }

                const stack = await Stack.getStack(server, stackName, true);
                await stack.restartService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: "Service " + serviceName + " restarted"
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // getExternalNetworkList
        agentSocket.on("getDockerNetworkList", async (callback) => {
            try {
                checkLogin(socket);
                const dockerNetworkList = await server.getDockerNetworkList();
                callbackResult({
                    ok: true,
                    dockerNetworkList,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }

    async saveStack(server : DockgeServer, name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, options : LooseObject = {}) : Promise<Stack> {
        // Check types
        if (typeof(name) !== "string") {
            throw new ValidationError("Name must be a string");
        }
        if (typeof(composeYAML) !== "string") {
            throw new ValidationError("Compose YAML must be a string");
        }
        if (typeof(composeENV) !== "string") {
            throw new ValidationError("Compose ENV must be a string");
        }
        if (typeof(isAdd) !== "boolean") {
            throw new ValidationError("isAdd must be a boolean");
        }

        const stack = new Stack(server, name, composeYAML, composeENV, false);
        await stack.save(isAdd, {
            dataset: typeof(options.dataset) === "boolean" ? options.dataset : undefined,
        });
        return stack;
    }

}

