import childProcessAsync from "promisify-child-process";
import { DockgeServer } from "../dockge-server";
import { Stack } from "../stack";
import { ValidationError } from "../util-server";
import { isValidServiceName, LooseObject, statusName } from "../../common/util-common";
import { imageUpdateChecker } from "../image-update-checker";
import { listDirectory } from "../file-browser";
import { getHostIPs } from "../host-ips";
import { ApiPermission } from "./api-keys";
import packageJSON from "../../package.json";
import { addFolders, deleteFolder, getStoredFolders, renameStoredFolders, validateFolder } from "../stack-folders";

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

function stackAction(id : string, action : string, summary : string, run : (stack : Stack) => Promise<unknown>, destructive = false) : Operation {
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
        },
        required: [ "name" ],
        handler: async (args, server) => {
            const stack = await getManagedStack(server, args.name);
            const result = await runWithOutput(stack, () => run(stack));
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
            documentation: "/api/v1/openapi.json",
        }),
    },
    {
        id: "list_stacks",
        method: "get",
        path: "/stacks",
        summary: "List all compose stacks (managed by Dockge or not) with status, folder and pending image updates",
        tag: "Stacks",
        permission: "read",
        readOnly: true,
        params: {},
        handler: async (_args, server) => {
            const list = await Stack.getStackList(server, true);
            const result = [];
            for (const stack of list.values()) {
                result.push(await stackSummary(stack));
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
        description: "The stack is created in <stacks dir>/<name>. Use absolute host paths for bind mounts (see list_host_paths).",
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
        },
        required: [ "name", "composeYAML" ],
        handler: async (args, server) => {
            if (typeof(args.composeYAML) !== "string") {
                throw new ValidationError("composeYAML must be a string");
            }
            const stack = new Stack(server, String(args.name ?? ""), args.composeYAML, typeof(args.composeENV) === "string" ? args.composeENV : "", false);
            await stack.save(true);
            if (typeof(args.folder) === "string" && args.folder.trim()) {
                await stack.setFolder(args.folder);
            }
            let result : LooseObject = {
                ok: true,
                output: "",
            };
            if (args.deploy !== false) {
                const saved = await Stack.getStack(server, stack.name);
                result = await runWithOutput(saved, () => saved.deploy());
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
                result = await runWithOutput(stack, () => stack.deploy());
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
        description: "Named volumes are not removed. Requires confirm=true.",
        tag: "Stacks",
        permission: "write",
        destructive: true,
        params: {
            name: stackName,
            confirm: {
                type: "boolean",
                description: "Must be true",
            },
        },
        required: [ "name", "confirm" ],
        handler: async (args, server) => {
            if (args.confirm !== true && args.confirm !== "true") {
                throw new ValidationError("Set confirm=true to delete the stack");
            }
            const stack = await getManagedStack(server, args.name);
            const result = await runWithOutput(stack, () => stack.delete());
            server.sendStackList();
            return result;
        },
    },
    stackAction("deploy_stack", "deploy", "docker compose up -d --remove-orphans (create or update the containers)", (stack) => stack.deploy()),
    stackAction("start_stack", "start", "Start a stack (docker compose up -d)", (stack) => stack.start()),
    stackAction("stop_stack", "stop", "Stop the containers of a stack (docker compose stop)", (stack) => stack.stop()),
    stackAction("restart_stack", "restart", "Restart the containers of a stack (docker compose restart)", (stack) => stack.restart()),
    stackAction("down_stack", "down", "Stop and remove the containers and networks of a stack (docker compose down). Files and volumes are kept.", (stack) => stack.down()),
    stackAction("update_stack", "update", "Pull the newest images and recreate the containers if the stack is running", async (stack) => {
        await stack.update();
        imageUpdateChecker.checkStack(stack.name).catch(() => {});
    }),
    {
        id: "rename_stack",
        method: "post",
        path: "/stacks/:name/rename",
        summary: "Rename a stack (stops it, renames its folder, starts it again if it was running)",
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
            const result = await runWithOutput(stack, () => stack.rename(undefined, String(args.newName ?? ""), args.keepVolumes !== false));
            server.sendStackList();
            return {
                ...result,
                name: result.ok ? args.newName : args.name,
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
                const info = imageUpdateChecker.get(stack.name);
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
        handler: async (args) => {
            if (typeof(args.name) === "string" && args.name) {
                return imageUpdateChecker.checkStack(args.name);
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
        summary: "Browse the host folders mounted into Dockge (DOCKGE_BROWSE_ROOTS), to choose absolute paths for bind mounts",
        tag: "Host",
        permission: "read",
        readOnly: true,
        params: {
            path: {
                type: "string",
                description: "Absolute folder path, empty to list the roots",
                default: "",
            },
            showFiles: {
                type: "boolean",
                default: false,
            },
        },
        handler: async (args) => listDirectory(typeof(args.path) === "string" ? args.path : "", args.showFiles === true || args.showFiles === "true"),
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
