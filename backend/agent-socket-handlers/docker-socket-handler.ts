import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { AgentSocket } from "../../common/agent-socket";
import { listDirectory } from "../file-browser";
import { getHostIPs } from "../host-ips";
import {
    addFolders, deleteFolder, deleteFolderOrder, removeFromOrder, renameFolderInOrder, renameStackInOrder,
    renameStoredFolders, setChildrenOrder, validateFolder
} from "../stack-folders";
import { imageUpdateChecker } from "../image-update-checker";
import { log } from "../log";

export class DockerSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        // Do not call super.create()

        agentSocket.on("deployStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                const stack = await this.saveStack(server, name, composeYAML, composeENV, isAdd);
                await stack.deploy(socket);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Deployed",
                    msgi18n: true,
                }, callback);
                stack.joinCombinedTerminal(socket);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("saveStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                await this.saveStack(server, name, composeYAML, composeENV, isAdd);
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

        agentSocket.on("deleteStack", async (name : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(name) !== "string") {
                    throw new ValidationError("Name must be a string");
                }
                const stack = await Stack.getStack(server, name);

                try {
                    await stack.delete(socket);
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
        agentSocket.on("startStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.start(socket);
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
        agentSocket.on("updateStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.update(socket);

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
                    ...(await listDirectory(dirPath, showFiles === true)),
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
                try {
                    await stack.rename(socket, newName, keepVolumes === true);
                    await renameStackInOrder(folder, stackName, newName);
                } finally {
                    server.sendStackList();
                }

                callbackResult({
                    ok: true,
                    msg: "Renamed",
                    msgi18n: true,
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

    async saveStack(server : DockgeServer, name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown) : Promise<Stack> {
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
        await stack.save(isAdd);
        return stack;
    }

}

