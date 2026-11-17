import childProcessAsync from "promisify-child-process";
import { DockgeServer } from "../dockge-server";
import { Stack } from "../stack";
import { ValidationError } from "../util-server";
import { isValidServiceName, LooseObject, statusName } from "../../common/util-common";
import { imageUpdateChecker } from "../image-update-checker";
import { listDirectory } from "../file-browser";
import { getHostIPs } from "../host-ips";
import { FileService } from "../files";
import { ApiPermission } from "./api-keys";
import packageJSON from "../../package.json";
import { getStackStorage, getStorageStatus, getStorageSummary } from "../zfs/storage";
import {
    addFolders, deleteFolder, deleteFolderOrder, getStoredFolders, removeFromOrder, renameFolderInOrder, renameStackInOrder, renameStoredFolders,
    validateFolder
} from "../stack-folders";

/**
 * The operations offered by the external API.
 * The same list is exposed as REST endpoints (/api/v1/...), as MCP tools (/mcp) and in the OpenAPI document,
 * so the three can never get out of sync.
 */

export interface JSONSchema {
    type? : string;
    description? : string;
    enum? : unknown[];
    default? : unknown;
    items? : JSONSchema;
    properties? : Record<string, JSONSchema>;
    required? : string[];
    minimum? : number;
    maximum? : number;
}

export interface Operation {
    /** Tool name (MCP) and operationId (OpenAPI) */
    id : string;
    method : "get" | "post" | "put" | "delete";
    /** Express style path, relative to /api/v1 */
    path : string;
    summary : string;
    description? : string;
    tag : string;
    permission : ApiPermission;
    /** All the arguments: path parameters, query (GET/DELETE) or JSON body (POST/PUT) */
    params : Record<string, JSONSchema>;
    required? : string[];
    /** MCP hint: the operation does not change anything */
    readOnly? : boolean;
    /** MCP hint: the operation can destroy data */
    destructive? : boolean;
    /** Available only when this returns true (otherwise not listed, and 404) */
    enabled? : (server : DockgeServer) => boolean;
    handler : (args : LooseObject, server : DockgeServer) => Promise<unknown>;
}

const MAX_OUTPUT = 512 * 1024;

/**
 * Remove colors / cursor movements of the docker CLI output
 */
export function stripAnsi(text : string) : string {
    // eslint-disable-next-line no-control-regex
    return text
        .replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        // Progress spinners repeat the same line many times
        .split("\n").filter((line, index, lines) => line.trim() !== "" && line !== lines[index - 1]).join("\n");
}

function limitOutput(text : string) : string {
    if (text.length <= MAX_OUTPUT) {
        return text;
    }
    return "[output truncated]\n" + text.slice(-MAX_OUTPUT);
}

async function getManagedStack(server : DockgeServer, name : unknown) : Promise<Stack> {
    if (typeof(name) !== "string" || !name) {
        throw new ValidationError("Stack name is required");
    }
    const stack = await Stack.getStack(server, name);
    if (!stack.isManagedByDockge) {
        throw new ValidationError("This stack is not managed by Dockge");
    }
    return stack;
}

function checkService(service : unknown) : string {
    if (!isValidServiceName(service)) {
        throw new ValidationError("Invalid service name");
    }
    return service;
}

/**
 * Run a stack operation and return its terminal output
 */
async function runWithOutput(stack : Stack, action : () => Promise<unknown>) : Promise<{ ok : boolean, output : string, error? : string }> {
    let output = "";
    stack.outputListener = (data) => {
        output += data;
        if (output.length > MAX_OUTPUT * 2) {
            output = output.slice(-MAX_OUTPUT);
        }
    };
    try {
        await action();
        return {
            ok: true,
            output: limitOutput(stripAnsi(output)),
        };
    } catch (e) {
        return {
            // Structured details, e.g. missingVolumes
            ...((e as { data? : object })?.data ?? {}),
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            output: limitOutput(stripAnsi(output)),
        };
    } finally {
        stack.outputListener = undefined;
    }
}

async function stackSummary(stack : Stack) {
    const json = stack.toSimpleJSON("") as LooseObject;
    return {
        name: stack.name,
        status: statusName(stack.status),
        managedByDockge: json.isManagedByDockge,
        folder: json.folder || null,
        imageUpdates: json.imageUpdates ? {
            updates: json.imageUpdates.updates,
            checkedAt: new Date(json.imageUpdates.checkedAt).toISOString(),
        } : null,
    };
}

const stackName : JSONSchema = {
    type: "string",
    description: "Stack name (lowercase letters, digits, - and _)",
};

const serviceName : JSONSchema = {
    type: "string",
    description: "Service name as written in compose.yaml",
};

const missingVolumesParam : JSONSchema = {
    description: "Only when the stack is a ZFS dataset and Dockge can create datasets: what to do with the ./xxx bind mounts that do not exist yet. " +
        "\"dataset\" or \"directory\" for all, \"fail\" to stop and get the list (missingVolumes in the result), or an object " +
        "{\"./data\": {\"type\": \"dataset\", \"owner\": \"1000:1000\", \"mode\": \"0750\"}}. Default: the rule of the ZFS settings (\"ask\" means fail here).",
};

const dryRunParam : JSONSchema = {
    type: "boolean",
    description: "Return the plan (what would be created) without changing anything",
    default: false,
};

/**
 * Destructive ZFS operations through the API: allowed by a setting, confirmed with the exact name of the target
 */
async function checkDestructive(confirm : unknown, target : unknown) {
    const { getZfsSettings } = await import("../zfs/settings");
    if (!(await getZfsSettings()).destructiveApi) {
        throw new ValidationError("Destructive ZFS operations through the API are disabled (Settings → Storage → destructive operations through the API)");
    }
    if (typeof(target) !== "string" || !target || confirm !== target) {
        throw new ValidationError(`Set confirm to the exact name of the target ("${String(target ?? "")}")`);
    }
}

/**
 * Plan of the missing volumes of a saved stack, for dryRun
 */
async function volumePlan(server : DockgeServer, stack : Stack, missingVolumes : unknown) {
    const { prepareStackVolumes, findMissingVolumes, MissingVolumesError } = await import("../zfs/volumes");
    try {
        return {
            dryRun: true,
            ...(await prepareStackVolumes(server, stack, {
                missingVolumes,
                dryRun: true,
            })),
        };
    } catch (e) {
        if (e instanceof MissingVolumesError) {
            return {
                dryRun: true,
                plan: [],
                warnings: [],
                missingVolumes: (await findMissingVolumes(server, stack)).missing,
                error: e.message,
            };
        }
        throw e;
    }
}

function stackAction(id : string, action : string, summary : string, run : (stack : Stack, args : LooseObject) => Promise<unknown>, destructive = false, volumes = false, extraParams : Record<string, JSONSchema> = {}) : Operation {
    return {
        id,
        method: "post",
        path: `/stacks/:name/${action}`,
        summary,
        tag: "Stack actions",
        permission: "write",
        destructive,
        params: {
            name: stackName,
            ...(volumes ? {
                missingVolumes: missingVolumesParam,
                dryRun: dryRunParam,
            } : {}),
            ...extraParams,
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            if (volumes && (args.dryRun === true || args.dryRun === "true")) {
                return volumePlan(server, stack, args.missingVolumes);
            }
            const result = await runWithOutput(stack, () => run(stack, args));
            server.sendStackList();
            return result;
        },
    };
}

function serviceAction(id : string, action : string, summary : string, run : (stack : Stack, service : string) => Promise<unknown>) : Operation {
    return {
        id,
        method: "post",
        path: `/stacks/:name/services/:service/${action}`,
        summary,
        tag: "Services",
        permission: "write",
        params: {
            name: stackName,
            service: serviceName,
        },
        required: [ "name", "service" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const service = checkService(args.service);
            const result = await runWithOutput(stack, () => run(stack, service));
            server.sendStackList();
            return result;
        },
    };
}

export const operations : Operation[] = [
    {
        id: "get_info",
        method: "get",
        path: "/info",
        summary: "Dockge version, stacks folder and the permission of the API key in use",
        tag: "General",
        permission: "read",
        readOnly: true,
        params: {},
        handler: async (_args, server) => ({
            name: "Dockge",
            version: packageJSON.version,
            stacksDir: server.stacksDir,
            storage: await getStorageSummary(server),
            documentation: "/api/v1/openapi.json",
        }),
    },
    {
        id: "list_stacks",
        method: "get",
        path: "/stacks",
        summary: "List the stacks managed by Dockge with status, folder and pending image updates (other compose projects of the host are not visible through the API)",
        tag: "Stacks",
        permission: "read",
        readOnly: true,
        params: {},
        handler: async (_args, server) => {
            const list = await Stack.getStackList(server, true);
            const result = [];
            for (const stack of list.values()) {
                // The API works only on the stacks managed by Dockge
                if (stack.isManagedByDockge) {
                    result.push(await stackSummary(stack));
                }
            }
            return result.sort((a, b) => a.name.localeCompare(b.name));
        },
    },
    {
        id: "get_stack",
        method: "get",
        path: "/stacks/:name",
        summary: "Get a stack: compose.yaml, .env, status of every service and image update details",
        tag: "Stacks",
        permission: "read",
        readOnly: true,
        params: {
            name: stackName,
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            await stack.updateStatus();
            const services = Object.fromEntries(await stack.getServiceStatusList());
            return {
                ...(await stackSummary(stack)),
                composeFileName: (stack.toSimpleJSON("") as LooseObject).composeFileName,
                composeYAML: stack.composeYAML,
                composeENV: stack.composeENV,
                path: stack.path,
                services,
                imageUpdates: imageUpdateChecker.get(stack.name) ?? null,
            };
        },
    },
    {
        id: "create_stack",
        method: "post",
        path: "/stacks",
        summary: "Create a new stack from a compose.yaml (and optional .env), optionally deploy it",
        description: "The stack is created in <stacks dir>/<name>. For the data of the stack use paths relative to the stack folder (./data:/data): they follow the stack when it is renamed and, on ZFS, can be datasets of the stack (see get_stack_storage). Use absolute host paths (list_host_paths) only for data shared with other stacks or outside the stacks folder (media library, shares, backups, devices).",
        tag: "Stacks",
        permission: "write",
        params: {
            name: stackName,
            composeYAML: {
                type: "string",
                description: "Content of compose.yaml",
            },
            composeENV: {
                type: "string",
                description: "Content of .env (optional)",
                default: "",
            },
            folder: {
                type: "string",
                description: "Virtual folder in the Dockge sidebar, e.g. media/arr (optional)",
            },
            deploy: {
                type: "boolean",
                description: "Run docker compose up -d after creating it",
                default: true,
            },
            dataset: {
                type: "boolean",
                description: "Create the stack folder as a ZFS dataset (default: the ZFS settings, when the stacks folder allows it; see get_storage_status canCreate)",
            },
            missingVolumes: missingVolumesParam,
            dryRun: {
                ...dryRunParam,
                description: "Only tell whether the folder would be created as a dataset, without creating anything",
            },
        },
        required: [ "name", "composeYAML" ],
        handler: async (args, server) => {
            if (typeof(args.composeYAML) !== "string") {
                throw new ValidationError("composeYAML must be a string");
            }
            const stack = new Stack(server, String(args.name ?? ""), args.composeYAML, typeof(args.composeENV) === "string" ? args.composeENV : "", false);
            const dataset = typeof(args.dataset) === "boolean" ? args.dataset : (args.dataset === "true" ? true : args.dataset === "false" ? false : undefined);
            if (args.dryRun === true || args.dryRun === "true") {
                stack.validate();
                const { getStorageStatus } = await import("../zfs/storage");
                const status = await getStorageStatus(server);
                const asDataset = await stack.shouldCreateDataset(dataset);
                return {
                    dryRun: true,
                    name: stack.name,
                    path: stack.path,
                    createdAs: asDataset ? "dataset" : "folder",
                    dataset: asDataset ? `${status.dataset}/${stack.name}` : null,
                    note: "Missing ./xxx volumes are checked at deploy time: use deploy_stack with dryRun after creating the stack without deploy",
                };
            }
            await stack.save(true, {
                dataset,
            });
            if (typeof(args.folder) === "string" && args.folder.trim()) {
                await stack.setFolder(args.folder);
            }
            let result : LooseObject = {
                ok: true,
                output: "",
            };
            if (args.deploy !== false) {
                const saved = await Stack.getStack(server, stack.name);
                result = await runWithOutput(saved, () => saved.deploy(undefined, {
                    missingVolumes: args.missingVolumes,
                }));
            }
            server.sendStackList();
            return {
                name: stack.name,
                created: true,
                deployed: args.deploy !== false && result.ok,
                ...result,
            };
        },
    },
    {
        id: "update_stack_files",
        method: "put",
        path: "/stacks/:name",
        summary: "Replace compose.yaml and/or .env of a stack, optionally redeploy it",
        tag: "Stacks",
        permission: "write",
        params: {
            name: stackName,
            composeYAML: {
                type: "string",
                description: "New content of compose.yaml (omit to keep the current one)",
            },
            composeENV: {
                type: "string",
                description: "New content of .env (omit to keep the current one)",
            },
            deploy: {
                type: "boolean",
                description: "Run docker compose up -d after saving",
                default: false,
            },
            missingVolumes: missingVolumesParam,
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const current = await getManagedStack(server, args.name);
            const composeYAML = typeof(args.composeYAML) === "string" ? args.composeYAML : current.composeYAML;
            const composeENV = typeof(args.composeENV) === "string" ? args.composeENV : current.composeENV;
            const stack = new Stack(server, current.name, composeYAML, composeENV, false);
            await stack.save(false);
            let result : LooseObject = {
                ok: true,
                output: "",
            };
            if (args.deploy === true) {
                result = await runWithOutput(stack, () => stack.deploy(undefined, {
                    missingVolumes: args.missingVolumes,
                }));
            }
            server.sendStackList();
            return {
                name: stack.name,
                saved: true,
                ...result,
            };
        },
    },
    {
        id: "delete_stack",
        method: "delete",
        path: "/stacks/:name",
        summary: "Stop and remove the containers of a stack and DELETE its folder (compose.yaml, .env and any data stored inside it)",
        description: "Named volumes are not removed. Requires confirm=true. A stack that is a ZFS dataset: with datasets=keep (default) the containers are removed and the data is kept; datasets=destroy destroys the stack dataset with all its volume datasets and snapshots (requires the setting \"destructive operations through the API\" and confirmName equal to the stack name).",
        tag: "Stacks",
        permission: "write",
        destructive: true,
        params: {
            name: stackName,
            confirm: {
                type: "boolean",
                description: "Must be true",
            },
            datasets: {
                type: "string",
                enum: [ "keep", "destroy" ],
                default: "keep",
                description: "Stack that is a ZFS dataset: keep its datasets, or destroy them with their snapshots",
            },
            confirmName: {
                type: "string",
                description: "With datasets=destroy: the stack name again",
            },
        },
        required: [ "name", "confirm" ],
        handler: async (args, server) => {
            if (args.confirm !== true && args.confirm !== "true") {
                throw new ValidationError("Set confirm=true to delete the stack");
            }
            const destroyDatasets = args.datasets === "destroy";
            if (destroyDatasets) {
                await checkDestructive(args.confirmName, args.name);
            }
            const stack = await getManagedStack(server, args.name);
            const result = await runWithOutput(stack, () => stack.delete(undefined, {
                destroyDatasets,
            }));
            server.sendStackList();
            return result;
        },
    },
    stackAction("deploy_stack", "deploy", "docker compose up -d --remove-orphans (create or update the containers)", (stack, args) => stack.deploy(undefined, {
        missingVolumes: args.missingVolumes,
    }), false, true),
    stackAction("start_stack", "start", "Start a stack (docker compose up -d)", (stack, args) => stack.start(undefined, {
        missingVolumes: args.missingVolumes,
    }), false, true),
    stackAction("stop_stack", "stop", "Stop the containers of a stack (docker compose stop)", (stack) => stack.stop()),
    stackAction("restart_stack", "restart", "Restart the containers of a stack (docker compose restart)", (stack) => stack.restart()),
    stackAction("down_stack", "down", "Stop and remove the containers and networks of a stack (docker compose down). Files and volumes are kept.", (stack) => stack.down()),
    stackAction("update_stack", "update", "Pull the newest images and recreate the containers if the stack is running. When the stack is a ZFS dataset, a recursive snapshot is taken before (setting, or snapshot: true / false).", async (stack, args) => {
        await stack.update(undefined, {
            missingVolumes: args.missingVolumes,
            snapshot: args.snapshot === true || args.snapshot === "true" ? true : (args.snapshot === false || args.snapshot === "false" ? false : undefined),
        });
        imageUpdateChecker.checkStack(stack.name).catch(() => {});
    }, false, true, {
        snapshot: {
            type: "boolean",
            description: "Recursive ZFS snapshot of the stack before recreating the containers (default: the ZFS settings)",
        },
    }),
    {
        id: "rename_stack",
        method: "post",
        path: "/stacks/:name/rename",
        summary: "Rename a stack (stops it, renames its folder, starts it again if it was running). Absolute bind mounts into the stack folder are rewritten as relative paths; bind sources with variables are left as they are and listed in warnings.",
        tag: "Stacks",
        permission: "write",
        params: {
            name: stackName,
            newName: stackName,
            keepVolumes: {
                type: "boolean",
                description: "Keep the data of named volumes by pinning their current name in compose.yaml",
                default: true,
            },
        },
        required: [ "name", "newName" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const folder = stack.folder;
            let warnings : string[] = [];
            const result = await runWithOutput(stack, async () => {
                ({ warnings } = await stack.rename(undefined, String(args.newName ?? ""), args.keepVolumes !== false));
            });
            if (result.ok) {
                await renameStackInOrder(folder, stack.name, String(args.newName));
            }
            server.sendStackList();
            return {
                ...result,
                name: result.ok ? args.newName : args.name,
                warnings,
            };
        },
    },
    {
        id: "set_stack_folder",
        method: "put",
        path: "/stacks/:name/folder",
        summary: "Move a stack to a virtual folder of the Dockge sidebar (\"\" = no folder). Only x-dockge.folder in compose.yaml changes.",
        tag: "Stacks",
        permission: "write",
        params: {
            name: stackName,
            folder: {
                type: "string",
                description: "Folder path, e.g. media/arr",
            },
        },
        required: [ "name", "folder" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const oldFolder = stack.folder;
            await stack.setFolder(String(args.folder ?? ""));
            await addFolders(oldFolder, validateFolder(String(args.folder ?? "")));
            if (oldFolder !== validateFolder(String(args.folder ?? ""))) {
                await removeFromOrder(oldFolder, "s:" + stack.name);
            }
            server.sendStackList();
            return {
                ok: true,
            };
        },
    },
    {
        id: "list_folders",
        method: "get",
        path: "/folders",
        summary: "Virtual folders of the Dockge sidebar (including empty ones) with the stacks inside each",
        tag: "Folders",
        permission: "read",
        readOnly: true,
        params: {},
        handler: async (_args, server) => {
            const list = await Stack.getStackList(server, true);
            const folders = new Map<string, string[]>();
            const ensure = (folder : string) => {
                const parts = folder.split("/");
                for (let i = 1; i <= parts.length; i++) {
                    const path = parts.slice(0, i).join("/");
                    if (!folders.has(path)) {
                        folders.set(path, []);
                    }
                }
            };
            for (const folder of await getStoredFolders()) {
                ensure(folder);
            }
            for (const stack of list.values()) {
                if (stack.isManagedByDockge && stack.folder) {
                    ensure(stack.folder);
                    folders.get(stack.folder)?.push(stack.name);
                }
            }
            return [ ...folders.entries() ].sort(([ a ], [ b ]) => a.localeCompare(b)).map(([ path, stacks ]) => ({
                path,
                stacks,
            }));
        },
    },
    {
        id: "create_folder",
        method: "post",
        path: "/folders",
        summary: "Create a virtual folder (can stay empty), e.g. media/arr",
        tag: "Folders",
        permission: "write",
        params: {
            folder: {
                type: "string",
                description: "Folder path, use / for sub folders",
            },
        },
        required: [ "folder" ],
        handler: async (args, server) => {
            const folder = validateFolder(String(args.folder ?? ""));
            if (!folder) {
                throw new ValidationError("The folder name is empty");
            }
            await addFolders(folder);
            server.sendStackList();
            return {
                ok: true,
                folder,
            };
        },
    },
    {
        id: "move_folder",
        method: "post",
        path: "/folders/move",
        summary: "Rename or move a folder with everything inside (e.g. media -> apps/media)",
        tag: "Folders",
        permission: "write",
        params: {
            from: {
                type: "string",
                description: "Current folder path",
            },
            to: {
                type: "string",
                description: "New folder path (\"\" moves its content to the top level)",
            },
        },
        required: [ "from", "to" ],
        handler: async (args, server) => {
            const from = validateFolder(String(args.from ?? ""));
            const to = validateFolder(String(args.to ?? ""));
            if (!from) {
                throw new ValidationError("Invalid folder");
            }
            if (to === from || to.startsWith(from + "/")) {
                throw new ValidationError("A folder cannot be moved inside itself");
            }
            const list = await Stack.getStackList(server);
            let count = 0;
            for (const stack of list.values()) {
                const folder = stack.isManagedByDockge ? stack.folder : "";
                if (folder && (folder === from || folder.startsWith(from + "/"))) {
                    await stack.setFolder(to + folder.slice(from.length));
                    count++;
                }
            }
            await renameStoredFolders(from, to);
            await renameFolderInOrder(from, to);
            server.sendStackList();
            return {
                ok: true,
                movedStacks: count,
            };
        },
    },
    {
        id: "delete_folder",
        method: "delete",
        path: "/folders",
        summary: "Delete an empty folder and its empty sub folders (stacks are never deleted: move them out first)",
        tag: "Folders",
        permission: "write",
        params: {
            folder: {
                type: "string",
                description: "Folder path",
            },
        },
        required: [ "folder" ],
        handler: async (args, server) => {
            const folder = validateFolder(String(args.folder ?? ""));
            const list = await Stack.getStackList(server);
            await deleteFolder(folder, [ ...list.values() ]);
            await deleteFolderOrder(folder);
            server.sendStackList();
            return {
                ok: true,
            };
        },
    },
    {
        id: "get_logs",
        method: "get",
        path: "/stacks/:name/logs",
        summary: "Recent logs of a stack, or of one of its services",
        tag: "Services",
        permission: "read",
        readOnly: true,
        params: {
            name: stackName,
            service: {
                ...serviceName,
                description: "Only this service (optional)",
            },
            tail: {
                type: "integer",
                description: "Number of lines per container",
                default: 200,
                minimum: 1,
                maximum: 5000,
            },
            since: {
                type: "string",
                description: "Only logs newer than this, e.g. 10m, 2h or 2026-01-01T00:00:00 (optional)",
            },
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const tail = Math.min(5000, Math.max(1, Number(args.tail) || 200));
            const options = [ "logs", "--no-color", "--timestamps", "--tail", String(tail) ];
            if (typeof(args.since) === "string" && args.since) {
                if (!/^[0-9A-Za-z:.+-]+$/.test(args.since)) {
                    throw new ValidationError("Invalid since");
                }
                options.push("--since", args.since);
            }
            if (args.service) {
                options.push(checkService(args.service));
            }
            const res = await childProcessAsync.spawn("docker", stack.getComposeOptions(options[0], ...options.slice(1)), {
                cwd: stack.path,
                encoding: "utf-8",
                maxBuffer: 16 * 1024 * 1024,
            });
            return {
                logs: limitOutput(stripAnsi((res.stdout?.toString() ?? "") + (res.stderr?.toString() ?? ""))),
            };
        },
    },
    serviceAction("start_service", "start", "Start one service of a stack", (stack, service) => stack.startService(undefined, service)),
    serviceAction("stop_service", "stop", "Stop one service of a stack", (stack, service) => stack.stopService(undefined, service)),
    serviceAction("restart_service", "restart", "Restart one service of a stack", (stack, service) => stack.restartService(undefined, service)),
    {
        id: "exec_in_service",
        method: "post",
        path: "/stacks/:name/services/:service/exec",
        summary: "Run a command inside the running container of a service (docker compose exec, non interactive) and return its output",
        tag: "Services",
        permission: "write",
        destructive: true,
        params: {
            name: stackName,
            service: serviceName,
            command: {
                type: "string",
                description: "Command line, run with the shell, e.g. \"ls -la /config\"",
            },
            shell: {
                type: "string",
                description: "Shell used to run the command",
                default: "sh",
                enum: [ "sh", "bash", "ash" ],
            },
            user: {
                type: "string",
                description: "Run as this user (optional), e.g. root or 1000",
            },
            timeoutSeconds: {
                type: "integer",
                description: "Kill the command after this many seconds",
                default: 60,
                minimum: 1,
                maximum: 3600,
            },
        },
        required: [ "name", "service", "command" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const service = checkService(args.service);
            if (typeof(args.command) !== "string" || !args.command.trim()) {
                throw new ValidationError("command is required");
            }
            const shell = [ "sh", "bash", "ash" ].includes(args.shell) ? args.shell : "sh";
            const timeout = Math.min(3600, Math.max(1, Number(args.timeoutSeconds) || 60)) * 1000;
            const execArgs = [ "exec", "-T" ];
            if (typeof(args.user) === "string" && args.user) {
                if (!/^[A-Za-z0-9_.:-]+$/.test(args.user)) {
                    throw new ValidationError("Invalid user");
                }
                execArgs.push("--user", args.user);
            }
            execArgs.push(service, shell, "-c", args.command);

            try {
                const res = await childProcessAsync.spawn("docker", stack.getComposeOptions(execArgs[0], ...execArgs.slice(1)), {
                    cwd: stack.path,
                    encoding: "utf-8",
                    timeout,
                    maxBuffer: 16 * 1024 * 1024,
                });
                return {
                    exitCode: res.code ?? 0,
                    stdout: limitOutput(res.stdout?.toString() ?? ""),
                    stderr: limitOutput(res.stderr?.toString() ?? ""),
                };
            } catch (e) {
                const err = e as LooseObject;
                return {
                    exitCode: typeof(err.code) === "number" ? err.code : null,
                    timedOut: err.killed === true,
                    stdout: limitOutput(err.stdout?.toString() ?? ""),
                    stderr: limitOutput(err.stderr?.toString() ?? err.message ?? ""),
                };
            }
        },
    },
    {
        id: "list_files",
        method: "get",
        path: "/files",
        summary: "List a folder of a stack managed by Dockge (relative path, e.g. . or ./config) or of one of the volumes declared in its compose file (absolute path)",
        description: "Entries: name, path, type (file / directory / symlink), size, modified, mode, uid, gid, dataset (ZFS dataset mounted on a folder). writable tells whether Dockge can write there.",
        tag: "Files",
        permission: "read",
        readOnly: true,
        params: {
            stack: {
                ...stackName,
                description: "Stack managed by Dockge: relative paths are inside its folder; absolute paths only for the volumes declared in its compose file",
            },
            path: {
                type: "string",
                description: "Folder, default . (the stack folder)",
                default: ".",
            },
        },
        handler: async (args, server) => (await FileService.forStack(server, args.stack)).list(args.path ?? "."),
    },
    {
        id: "read_file",
        method: "get",
        path: "/files/content",
        summary: "Read a file of a stack or of a volume (text up to 2 MiB; binary files with encoding=base64, up to 16 MiB)",
        description: "The result tells the line ending (LF / CRLF / mixed) and whether the file has a UTF-8 BOM (removed from content).",
        tag: "Files",
        permission: "read",
        readOnly: true,
        params: {
            stack: {
                ...stackName,
                description: "Stack managed by Dockge: relative paths are inside its folder; absolute paths only for the volumes declared in its compose file",
            },
            path: {
                type: "string",
                description: "File, e.g. ./config/app.yml",
            },
            encoding: {
                type: "string",
                enum: [ "utf8", "base64" ],
                default: "utf8",
            },
        },
        required: [ "stack", "path" ],
        handler: async (args, server) => (await FileService.forStack(server, args.stack)).read(args.path, args.encoding === "base64" ? "base64" : "utf8"),
    },
    {
        id: "write_file",
        method: "put",
        path: "/files/content",
        summary: "Create or replace a file of a stack or of a volume. An existing file keeps owner and permissions; a new one gets the owner of its folder.",
        description: "To apply a changed configuration, restart the service afterwards (restart_service). Shell scripts must use LF line endings: lineEnding=lf converts them.",
        tag: "Files",
        permission: "write",
        params: {
            stack: {
                ...stackName,
                description: "Stack managed by Dockge: relative paths are inside its folder; absolute paths only for the volumes declared in its compose file",
            },
            path: {
                type: "string",
                description: "File, e.g. ./config/app.yml",
            },
            content: {
                type: "string",
                description: "New content (text, or base64 with encoding=base64)",
            },
            encoding: {
                type: "string",
                enum: [ "utf8", "base64" ],
                default: "utf8",
            },
            lineEnding: {
                type: "string",
                enum: [ "keep", "lf", "crlf" ],
                default: "keep",
                description: "Convert the line endings of a text content",
            },
            executable: {
                type: "boolean",
                description: "Set (true) or remove (false) the execute permission",
            },
            createOnly: {
                type: "boolean",
                default: false,
                description: "Fail if the file exists",
            },
            createParents: {
                type: "boolean",
                default: false,
                description: "Create the missing folders",
            },
        },
        required: [ "stack", "path", "content" ],
        handler: async (args, server) => (await FileService.forStack(server, args.stack)).write(args.path, {
            content: args.content,
            encoding: args.encoding,
            lineEnding: args.lineEnding,
            executable: args.executable === true || args.executable === "true" ? true : (args.executable === false || args.executable === "false" ? false : undefined),
            createOnly: args.createOnly === true || args.createOnly === "true",
            createParents: args.createParents === true || args.createParents === "true",
        }),
    },
    {
        id: "make_dir",
        method: "post",
        path: "/files/dir",
        summary: "Create a folder (and the missing parents) in a stack or a volume, owned like its parent folder",
        tag: "Files",
        permission: "write",
        params: {
            stack: {
                ...stackName,
                description: "Stack managed by Dockge: relative paths are inside its folder; absolute paths only for the volumes declared in its compose file",
            },
            path: {
                type: "string",
            },
        },
        required: [ "stack", "path" ],
        handler: async (args, server) => (await FileService.forStack(server, args.stack)).makeDir(args.path),
    },
    {
        id: "move_file",
        method: "post",
        path: "/files/move",
        summary: "Rename or move a file or a folder (within the same filesystem / dataset)",
        tag: "Files",
        permission: "write",
        params: {
            stack: {
                ...stackName,
                description: "Stack managed by Dockge: relative paths are inside its folder; absolute paths only for the volumes declared in its compose file",
            },
            from: {
                type: "string",
            },
            to: {
                type: "string",
            },
            overwrite: {
                type: "boolean",
                default: false,
                description: "Replace an existing file (never a folder)",
            },
        },
        required: [ "stack", "from", "to" ],
        handler: async (args, server) => (await FileService.forStack(server, args.stack)).move(args.from, args.to, args.overwrite === true || args.overwrite === "true"),
    },
    {
        id: "delete_file",
        method: "delete",
        path: "/files",
        summary: "Delete a file, or a folder (recursive: true for its content). Mount points (datasets) and the stack folder are never deleted.",
        description: "Requires confirm equal to the path.",
        tag: "Files",
        permission: "write",
        destructive: true,
        params: {
            stack: {
                ...stackName,
                description: "Stack managed by Dockge: relative paths are inside its folder; absolute paths only for the volumes declared in its compose file",
            },
            path: {
                type: "string",
            },
            recursive: {
                type: "boolean",
                default: false,
            },
            confirm: {
                type: "string",
                description: "The same path again",
            },
        },
        required: [ "stack", "path", "confirm" ],
        handler: async (args, server) => {
            if (args.confirm !== args.path) {
                throw new ValidationError("Set confirm to the same path");
            }
            return (await FileService.forStack(server, args.stack)).remove(args.path, args.recursive === true || args.recursive === "true");
        },
    },
    {
        id: "exec_in_stack_dir",
        method: "post",
        path: "/stacks/:name/exec",
        summary: "Run a shell command in the Dockge container, starting from the folder of a stack (docker CLI available; the services may be stopped). Non interactive.",
        description: "Only when the Console is enabled (DOCKGE_ENABLE_CONSOLE=true): it is root access to the host through the docker socket. Use exec_in_service to run a command inside a service.",
        tag: "Stack actions",
        permission: "write",
        destructive: true,
        enabled: (server) => server.config.enableConsole === true,
        params: {
            name: stackName,
            command: {
                type: "string",
                description: "Command line, e.g. \"ls -la\" or \"docker compose config\"",
            },
            shell: {
                type: "string",
                enum: [ "sh", "bash" ],
                default: "bash",
            },
            timeoutSeconds: {
                type: "integer",
                default: 60,
                minimum: 1,
                maximum: 3600,
            },
        },
        required: [ "name", "command" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            if (typeof(args.command) !== "string" || !args.command.trim()) {
                throw new ValidationError("command is required");
            }
            const shell = args.shell === "sh" ? "sh" : "bash";
            const timeout = Math.min(3600, Math.max(1, Number(args.timeoutSeconds) || 60)) * 1000;
            try {
                const res = await childProcessAsync.spawn(shell, [ "-c", args.command ], {
                    cwd: stack.path,
                    encoding: "utf-8",
                    timeout,
                    maxBuffer: 16 * 1024 * 1024,
                });
                return {
                    exitCode: res.code ?? 0,
                    stdout: limitOutput(res.stdout?.toString() ?? ""),
                    stderr: limitOutput(res.stderr?.toString() ?? ""),
                };
            } catch (e) {
                const err = e as LooseObject;
                return {
                    exitCode: typeof(err.code) === "number" ? err.code : null,
                    timedOut: err.killed === true,
                    stdout: limitOutput(err.stdout?.toString() ?? ""),
                    stderr: limitOutput(err.stderr?.toString() ?? err.message ?? ""),
                };
            }
        },
    },
    {
        id: "list_image_updates",
        method: "get",
        path: "/updates",
        summary: "Result of the last image update check: stacks whose images have a newer version on the registry",
        tag: "Image updates",
        permission: "read",
        readOnly: true,
        params: {},
        handler: async (_args, server) => {
            const list = await Stack.getStackList(server, true);
            const result = [];
            for (const stack of list.values()) {
                const info = stack.isManagedByDockge ? imageUpdateChecker.get(stack.name) : undefined;
                if (info) {
                    result.push({
                        stack: stack.name,
                        updates: info.updates,
                        checkedAt: new Date(info.checkedAt).toISOString(),
                        services: info.services,
                    });
                }
            }
            return result.sort((a, b) => b.updates - a.updates || a.stack.localeCompare(b.stack));
        },
    },
    {
        id: "check_image_updates",
        method: "post",
        path: "/updates/check",
        summary: "Ask the registries now whether newer images exist (one stack, or all stacks). Nothing is pulled.",
        tag: "Image updates",
        permission: "read",
        params: {
            name: {
                ...stackName,
                description: "Only this stack (optional)",
            },
        },
        handler: async (args, server) => {
            if (typeof(args.name) === "string" && args.name) {
                const stack = await getManagedStack(server, args.name);
                return imageUpdateChecker.checkStack(stack.name);
            }
            await imageUpdateChecker.checkAll();
            return {
                ok: true,
            };
        },
    },
    {
        id: "list_host_paths",
        method: "get",
        path: "/host/paths",
        summary: "Browse the host folders mounted into Dockge (DOCKGE_BROWSE_ROOTS), to choose absolute paths for bind mounts of shared or external data. Folders only: files are not listed, their content cannot be read through the API",
        description: "Every entry tells the ZFS dataset mounted on it (dataset) and the stack whose folder contains it (stack). The data of a single stack belongs in its own folder (./name), not here.",
        tag: "Host",
        permission: "read",
        readOnly: true,
        params: {
            path: {
                type: "string",
                description: "Absolute folder path, empty to list the roots",
                default: "",
            },
        },
        handler: async (args, server) => listDirectory(typeof(args.path) === "string" ? args.path : "", false, server.stacksDir),
    },
    {
        id: "list_host_ips",
        method: "get",
        path: "/host/ips",
        summary: "IP addresses of the host, to publish a port on a single IP (\"IP:HOST_PORT:CONTAINER_PORT\")",
        tag: "Host",
        permission: "read",
        readOnly: true,
        params: {},
        handler: async () => getHostIPs(),
    },
    {
        id: "get_storage_status",
        method: "get",
        path: "/storage",
        summary: "ZFS status of the stacks folder: dataset, whether it is the root of its dataset, mount propagation, TrueNAS host, problems with their remedy",
        description: "Read only. Nothing is created yet: stacks and volumes as datasets need ready=true.",
        tag: "Storage",
        permission: "read",
        readOnly: true,
        params: {},
        handler: async (_args, server) => getStorageStatus(server),
    },
    {
        id: "get_stack_storage",
        method: "get",
        path: "/stacks/:name/storage",
        summary: "Storage of a stack: whether its folder is a ZFS dataset and, for every bind mount, the services using it and its kind (dataset / directory / file / missing / notVisible / unresolved) and location (stack / otherStack / external)",
        description: "A missing path inside the stack folder is created by Docker as a plain folder at the next deploy. Paths are resolved with docker compose config when the compose file is valid.",
        tag: "Storage",
        permission: "read",
        readOnly: true,
        params: {
            name: stackName,
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            return getStackStorage(server, stack.name);
        },
    },
    {
        id: "create_volume_dataset",
        method: "post",
        path: "/stacks/:name/storage/volumes",
        summary: "Create ./path of a stack as a ZFS dataset (the stack must be a dataset; intermediate datasets of a nested path are created too)",
        description: "Only where nothing exists yet: an existing folder cannot be converted. Use it before adding \"./path:/container/path\" to the compose file. Properties not given come from x-dockge.zfs.<path>, then are inherited.",
        tag: "Storage",
        permission: "write",
        params: {
            name: stackName,
            path: {
                type: "string",
                description: "Path relative to the stack folder, e.g. ./pgdata",
            },
            recordsize: {
                type: "string",
                description: "e.g. 16K for databases, 1M for large files",
            },
            compression: {
                type: "string",
                description: "e.g. LZ4, ZSTD, OFF",
            },
            atime: {
                type: "string",
                enum: [ "ON", "OFF" ],
            },
            quota: {
                type: "string",
                description: "e.g. 50G (at least 1G)",
            },
            owner: {
                type: "string",
                description: "uid or uid:gid of the new dataset (numbers)",
            },
            mode: {
                type: "string",
                description: "Octal permissions, e.g. 0750",
            },
            dryRun: dryRunParam,
        },
        required: [ "name", "path" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            if (typeof(args.path) !== "string") {
                throw new ValidationError("path is required");
            }
            const { createVolumeDataset, getCreationContext, isDatasetMount, planVolumeDataset } = await import("../zfs/datasets");
            const { normalizeVolumePath, parseRecipes, validateRecipe } = await import("../zfs/recipe");
            const { forgetStackDatasets } = await import("../zfs/storage");
            const relative = normalizeVolumePath(args.path);
            const recipe = {
                ...(parseRecipes(stack.composeYAML).recipes.get(relative) ?? {}),
                ...validateRecipe({
                    recordsize: args.recordsize,
                    compression: args.compression,
                    atime: args.atime,
                    quota: args.quota,
                    owner: args.owner,
                    mode: args.mode,
                }, "arguments"),
            };
            const { status } = await getCreationContext(server);
            const steps = planVolumeDataset(status, stack.name, relative);
            if (args.dryRun === true || args.dryRun === "true") {
                return {
                    dryRun: true,
                    path: "./" + relative,
                    datasets: steps.map((step) => ({
                        dataset: step.dataset,
                        path: "./" + step.path,
                        intermediate: step.intermediate,
                    })),
                    properties: recipe,
                };
            }
            const created = await createVolumeDataset(server, stack.name, relative, recipe);
            forgetStackDatasets(isDatasetMount(stack.path) ?? "");
            return {
                ok: true,
                ...created,
            };
        },
    },
    {
        id: "set_dataset_properties",
        method: "put",
        path: "/stacks/:name/storage/properties",
        summary: "Change ZFS properties of a dataset of a stack (recordsize, compression, atime, quota)",
        description: "path: ./volume, or . for the dataset of the stack. recordsize only affects data written afterwards. Does not edit x-dockge.zfs.",
        tag: "Storage",
        permission: "write",
        params: {
            name: stackName,
            path: {
                type: "string",
                description: "./volume or .",
            },
            recordsize: {
                type: "string",
            },
            compression: {
                type: "string",
            },
            atime: {
                type: "string",
                enum: [ "ON", "OFF" ],
            },
            quota: {
                type: "string",
                description: "e.g. 50G, or none to remove it",
            },
            dryRun: dryRunParam,
        },
        required: [ "name", "path" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            if (typeof(args.path) !== "string") {
                throw new ValidationError("path is required");
            }
            const { setDatasetProperties, isDatasetMount } = await import("../zfs/datasets");
            const { parseDatasetProperties } = await import("../zfs/recipe");
            const { forgetStackDatasets } = await import("../zfs/storage");
            const properties = parseDatasetProperties({
                recordsize: args.recordsize,
                compression: args.compression,
                atime: args.atime,
                quota: args.quota,
            });
            const result = await setDatasetProperties(server, stack.name, args.path, properties, args.dryRun === true || args.dryRun === "true");
            forgetStackDatasets(isDatasetMount(stack.path) ?? "");
            return result;
        },
    },
    {
        id: "set_volume_permissions",
        method: "put",
        path: "/stacks/:name/storage/permissions",
        summary: "Change owner and permissions of a folder or dataset of a stack",
        description: "path: ./volume, or . for the stack folder. recursive changes the owner of the content too, without entering child datasets; mode applies to the folder itself only.",
        tag: "Storage",
        permission: "write",
        params: {
            name: stackName,
            path: {
                type: "string",
                description: "./volume or .",
            },
            owner: {
                type: "string",
                description: "uid or uid:gid (numbers)",
            },
            mode: {
                type: "string",
                description: "Octal, e.g. 0750",
            },
            recursive: {
                type: "boolean",
                default: false,
            },
            dryRun: dryRunParam,
        },
        required: [ "name", "path" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            if (typeof(args.path) !== "string") {
                throw new ValidationError("path is required");
            }
            const { setVolumePermissions } = await import("../zfs/datasets");
            const { validateRecipe } = await import("../zfs/recipe");
            const checked = validateRecipe({
                owner: args.owner,
                mode: args.mode,
            }, "arguments");
            return setVolumePermissions(server, stack.name, args.path, {
                owner: checked.owner,
                mode: checked.mode,
                recursive: args.recursive === true || args.recursive === "true",
            }, args.dryRun === true || args.dryRun === "true");
        },
    },
    {
        id: "list_snapshots",
        method: "get",
        path: "/stacks/:name/snapshots",
        summary: "Snapshots of a stack that is a ZFS dataset (recursive: compose files and volume datasets), newest first",
        description: "kind: manual (dockge-...), auto (dockge-auto-..., before update_stack), other (e.g. TrueNAS periodic tasks). complete=false: some datasets of the stack were created after it.",
        tag: "Snapshots",
        permission: "read",
        readOnly: true,
        params: {
            name: stackName,
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const { listStackSnapshots } = await import("../zfs/snapshots");
            return listStackSnapshots(server, stack.name);
        },
    },
    {
        id: "create_snapshot",
        method: "post",
        path: "/stacks/:name/snapshots",
        summary: "Take a recursive snapshot of a stack (compose.yaml, .env and every volume dataset at the same instant)",
        description: "With the containers running the copy is like after a power cut (fine for PostgreSQL / MySQL); stopFirst stops them during the snapshot.",
        tag: "Snapshots",
        permission: "write",
        params: {
            name: stackName,
            label: {
                type: "string",
                description: "Optional label added to the name (letters, digits, - and _)",
            },
            stopFirst: {
                type: "boolean",
                default: false,
            },
            dryRun: dryRunParam,
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const { createStackSnapshot } = await import("../zfs/snapshots");
            return createStackSnapshot(server, stack.name, {
                label: typeof(args.label) === "string" ? args.label : undefined,
                stopFirst: args.stopFirst === true || args.stopFirst === "true",
                dryRun: args.dryRun === true || args.dryRun === "true",
            });
        },
    },
    {
        id: "clone_stack",
        method: "post",
        path: "/stacks/:name/snapshots/:snapshot/clone",
        summary: "Create a new stack from a snapshot (ZFS clones of every dataset of the stack). The new stack is not started.",
        description: "Change container_name and published ports in the clone before starting it. The clones depend on the snapshot. On TrueNAS 25.04 a clone needs the API key of a full administrator.",
        tag: "Snapshots",
        permission: "write",
        params: {
            name: stackName,
            snapshot: {
                type: "string",
                description: "Snapshot name (after @)",
            },
            newName: {
                ...stackName,
                description: "Name of the new stack",
            },
            dryRun: dryRunParam,
        },
        required: [ "name", "snapshot", "newName" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const { cloneStack } = await import("../zfs/snapshots");
            const result = await cloneStack(server, stack.name, String(args.snapshot ?? ""), String(args.newName ?? ""), args.dryRun === true || args.dryRun === "true");
            server.sendStackList();
            return result;
        },
    },
    {
        id: "rollback_snapshot",
        method: "post",
        path: "/stacks/:name/snapshots/:snapshot/rollback",
        summary: "Roll a stack back to a snapshot: stop it, roll back every dataset, start it again. Snapshots newer than this one are DESTROYED.",
        description: "Requires the ZFS setting \"destructive operations through the API\" and confirm equal to the snapshot name. Use dryRun first: it lists the snapshots that would be destroyed. On TrueNAS 25.04 a rollback needs the API key of a full administrator.",
        tag: "Snapshots",
        permission: "write",
        destructive: true,
        params: {
            name: stackName,
            snapshot: {
                type: "string",
                description: "Snapshot name (after @)",
            },
            confirm: {
                type: "string",
                description: "The snapshot name again",
            },
            dryRun: dryRunParam,
        },
        required: [ "name", "snapshot" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const dryRun = args.dryRun === true || args.dryRun === "true";
            if (!dryRun) {
                await checkDestructive(args.confirm, args.snapshot);
            }
            const { rollbackStack } = await import("../zfs/snapshots");
            const result = await rollbackStack(server, stack.name, String(args.snapshot ?? ""), dryRun);
            server.sendStackList();
            return result;
        },
    },
    {
        id: "delete_snapshot",
        method: "delete",
        path: "/stacks/:name/snapshots/:snapshot",
        summary: "Delete a snapshot of a stack (recursive)",
        description: "Requires the ZFS setting \"destructive operations through the API\" and confirm equal to the snapshot name.",
        tag: "Snapshots",
        permission: "write",
        destructive: true,
        params: {
            name: stackName,
            snapshot: {
                type: "string",
                description: "Snapshot name (after @)",
            },
            confirm: {
                type: "string",
                description: "The snapshot name again",
            },
            dryRun: dryRunParam,
        },
        required: [ "name", "snapshot" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const dryRun = args.dryRun === true || args.dryRun === "true";
            if (!dryRun) {
                await checkDestructive(args.confirm, args.snapshot);
            }
            const { deleteStackSnapshot } = await import("../zfs/snapshots");
            return deleteStackSnapshot(server, stack.name, String(args.snapshot ?? ""), dryRun);
        },
    },
    {
        id: "convert_to_dataset",
        method: "post",
        path: "/stacks/:name/storage/convert",
        summary: "Convert an existing folder into a ZFS dataset: ./path of a stack (the stack must be a dataset), or the stack folder itself (path omitted). Runs as a job.",
        description: "Stops the stack if running, takes a safety snapshot, moves the folder to <name>.dockge-backup-<date>, creates the dataset, copies the content back (cp -a, block cloning when possible), verifies, starts the stack again. The copy is kept until delete_migration_backup. Use dryRun first: it tells size, free space and what is stopped. Follow the job with get_job.",
        tag: "Storage",
        permission: "write",
        params: {
            name: stackName,
            path: {
                type: "string",
                description: "./volume to convert; omit to convert the stack folder",
            },
            dryRun: dryRunParam,
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const { convertToDataset } = await import("../zfs/migrate");
            const relative = typeof(args.path) === "string" && args.path.trim() && args.path.trim() !== "." ? args.path : null;
            return convertToDataset(server, stack.name, relative, args.dryRun === true || args.dryRun === "true", () => server.sendStackList());
        },
    },
    {
        id: "abort_conversion",
        method: "post",
        path: "/stacks/:name/storage/convert/abort",
        summary: "Undo a conversion interrupted by a restart of Dockge: destroy the new dataset and put the original folder back from its copy",
        description: "Requires the setting \"destructive operations through the API\" and confirm equal to the stack name.",
        tag: "Storage",
        permission: "write",
        destructive: true,
        params: {
            name: stackName,
            path: {
                type: "string",
                description: "./volume, or omit for the stack folder",
            },
            confirm: {
                type: "string",
                description: "The stack name again",
            },
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            await checkDestructive(args.confirm, stack.name);
            const { abortInterruptedConversion } = await import("../zfs/migrate");
            const relative = typeof(args.path) === "string" && args.path.trim() && args.path.trim() !== "." ? args.path : null;
            return abortInterruptedConversion(server, stack.name, relative);
        },
    },
    {
        id: "list_migration_backups",
        method: "get",
        path: "/stacks/:name/storage/backups",
        summary: "Copies of the original folders kept by the conversions to dataset",
        tag: "Storage",
        permission: "read",
        readOnly: true,
        params: {
            name: stackName,
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const { listMigrationBackups } = await import("../zfs/migrate");
            return (await listMigrationBackups(server, stack.name)).map((backup) => ({
                name: backup.name,
                kind: backup.kind,
            }));
        },
    },
    {
        id: "delete_migration_backup",
        method: "delete",
        path: "/stacks/:name/storage/backups/:backup",
        summary: "Delete a copy kept by a conversion to dataset (job)",
        description: "Requires the setting \"destructive operations through the API\" and confirm equal to the backup name.",
        tag: "Storage",
        permission: "write",
        destructive: true,
        params: {
            name: stackName,
            backup: {
                type: "string",
                description: "Name as returned by list_migration_backups",
            },
            confirm: {
                type: "string",
            },
            dryRun: dryRunParam,
        },
        required: [ "name", "backup" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const dryRun = args.dryRun === true || args.dryRun === "true";
            if (!dryRun) {
                await checkDestructive(args.confirm, args.backup);
            }
            const { deleteMigrationBackup } = await import("../zfs/migrate");
            return deleteMigrationBackup(server, stack.name, String(args.backup ?? ""), dryRun);
        },
    },
    {
        id: "adopt_dataset",
        method: "post",
        path: "/stacks/:name/storage/adopt",
        summary: "Move an existing dataset (same pool) into a stack as ./path, and rewrite the bind mounts that used its absolute path",
        description: "Instant (zfs rename, nothing is copied). The stack is stopped and started again. Shares and tasks of TrueNAS that use the dataset, and other stacks that use it, are listed: use dryRun first. On TrueNAS 25.04 renaming a dataset needs the API key of a full administrator.",
        tag: "Storage",
        permission: "write",
        params: {
            name: stackName,
            dataset: {
                type: "string",
                description: "Dataset to adopt, e.g. tank/appdata/immich/library",
            },
            path: {
                type: "string",
                description: "Where it goes in the stack, e.g. ./library",
            },
            dryRun: dryRunParam,
        },
        required: [ "name", "dataset", "path" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const { adoptDataset } = await import("../zfs/adopt");
            const result = await adoptDataset(server, stack.name, String(args.dataset ?? ""), String(args.path ?? ""), args.dryRun === true || args.dryRun === "true");
            server.sendStackList();
            return result;
        },
    },
    {
        id: "get_stacks_folder_script",
        method: "get",
        path: "/storage/stacks-folder-script",
        summary: "When the stacks folder is a plain folder inside a dataset: shell script to run on TrueNAS (as root) that moves it into its own dataset",
        tag: "Storage",
        permission: "read",
        readOnly: true,
        params: {},
        handler: async (_args, server) => {
            const { stacksFolderScript } = await import("../zfs/scripts");
            return stacksFolderScript(server);
        },
    },
    {
        id: "find_hidden_data",
        method: "get",
        path: "/storage/hidden",
        summary: "Data hidden under the datasets of the stacks folder (content of a folder over which a dataset was created): still takes space, invisible",
        description: "Starts the Dockge image for a moment with non-recursive bind mounts (Docker 25 or later).",
        tag: "Storage",
        permission: "read",
        readOnly: true,
        params: {},
        handler: async (_args, server) => {
            const { findHiddenData } = await import("../zfs/hidden");
            return findHiddenData(server);
        },
    },
    {
        id: "recover_hidden_data",
        method: "post",
        path: "/storage/hidden/recover",
        summary: "Move the data hidden under a mount point into a visible folder next to it (<name>.dockge-hidden-<date>)",
        tag: "Storage",
        permission: "write",
        params: {
            mountpoint: {
                type: "string",
                description: "Mount point as returned by find_hidden_data",
            },
        },
        required: [ "mountpoint" ],
        handler: async (args, server) => {
            const { recoverHiddenData } = await import("../zfs/hidden");
            return recoverHiddenData(server, String(args.mountpoint ?? ""));
        },
    },
    {
        id: "list_jobs",
        method: "get",
        path: "/jobs",
        summary: "ZFS jobs (conversions, deletion of backups, ...), running and recent",
        tag: "Storage",
        permission: "read",
        readOnly: true,
        params: {
            stack: {
                ...stackName,
                description: "Only the jobs of this stack (optional)",
            },
        },
        handler: async (args) => {
            const { listJobs, jobSummary } = await import("../zfs/jobs");
            return listJobs(typeof(args.stack) === "string" && args.stack ? args.stack : undefined).map((job) => jobSummary(job, 5));
        },
    },
    {
        id: "get_job",
        method: "get",
        path: "/jobs/:id",
        summary: "A ZFS job: step, progress, bytes copied, log, result or error",
        tag: "Storage",
        permission: "read",
        readOnly: true,
        params: {
            id: {
                type: "string",
            },
        },
        required: [ "id" ],
        handler: async (args) => {
            const { getJob, jobSummary } = await import("../zfs/jobs");
            const job = getJob(String(args.id ?? ""));
            if (!job) {
                throw new ValidationError("Job not found");
            }
            return jobSummary(job, 100);
        },
    },
    {
        id: "cancel_job",
        method: "post",
        path: "/jobs/:id/cancel",
        summary: "Ask a running ZFS job to stop (a conversion is undone and the folder put back)",
        tag: "Storage",
        permission: "write",
        params: {
            id: {
                type: "string",
            },
        },
        required: [ "id" ],
        handler: async (args) => {
            const { cancelJob, jobSummary } = await import("../zfs/jobs");
            return jobSummary(cancelJob(String(args.id ?? "")), 5);
        },
    },
    {
        id: "list_networks",
        method: "get",
        path: "/networks",
        summary: "Docker networks available to the stacks",
        tag: "Host",
        permission: "read",
        readOnly: true,
        params: {},
        handler: async (_args, server) => server.getDockerNetworkList(),
    },
];
