import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import { DockgeSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import {
    acceptedComposeFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    CREATED_STACK,
    EXITED, getCombinedTerminalName,
    getComposeTerminalName, getContainerExecTerminalName,
    getServiceLogTerminalName, isValidServiceName,
    PROGRESS_TERMINAL_ROWS,
    RUNNING, TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import childProcessAsync from "promisify-child-process";
import { Settings } from "./settings";
import { deleteIn, setStringIn } from "./yaml-text-edit";
import { imageUpdateChecker } from "./image-update-checker";

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML?: string;
    protected _composeENV?: string;
    protected _configFilePath?: string;
    protected _composeFileName: string = "compose.yaml";
    protected server: DockgeServer;

    protected combinedTerminal? : Terminal;

    /** Set by the API to collect the output of the next operations */
    public outputListener? : (data : string) => void;

    protected static managedStackList: Map<string, Stack> = new Map();

    constructor(server : DockgeServer, name : string, composeYAML? : string, composeENV? : string, skipFSOperations = false) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;

        if (!skipFSOperations) {
            // Check if compose file name is different from compose.yaml
            for (const filename of acceptedComposeFileNames) {
                if (fs.existsSync(path.join(this.path, filename))) {
                    this._composeFileName = filename;
                    break;
                }
            }
        }
    }

    async toJSON(endpoint : string) : Promise<object> {

        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = "localhost";
            } else {
                // Use the endpoint as the primary hostname
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    // Just in case if the endpoint is in a incorrect format
                    primaryHostname = "localhost";
                }
            }
        }

        let obj = this.toSimpleJSON(endpoint);
        return {
            ...obj,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            primaryHostname,
        };
    }

    toSimpleJSON(endpoint : string) : object {
        const isManagedByDockge = this.isManagedByDockge;
        return {
            name: this.name,
            status: this._status,
            tags: [],
            isManagedByDockge,
            composeFileName: this._composeFileName,
            endpoint,
            folder: isManagedByDockge ? this.folder : "",
            imageUpdates: isManagedByDockge ? (imageUpdateChecker.get(this.name) ?? null) : null,
        };
    }

    protected _folderCache? : { yaml: string, folder: string };

    /**
     * Virtual folder of the stack in the sidebar, stored in the compose file as
     *   x-dockge:
     *     folder: media/arr
     * The folder only exists in Dockge's UI: the stack stays in <stacks dir>/<name> on disk.
     */
    get folder() : string {
        const composeYAML = this.composeYAML;
        if (this._folderCache && this._folderCache.yaml === composeYAML) {
            return this._folderCache.folder;
        }

        let folder = "";
        try {
            const value = yaml.parse(composeYAML)?.["x-dockge"]?.folder;
            if (typeof(value) === "string") {
                folder = Stack.normalizeFolder(value);
            }
        } catch (e) {
            // Invalid YAML: no folder
        }

        this._folderCache = {
            yaml: composeYAML,
            folder,
        };
        return folder;
    }

    /**
     * "  media / arr/ " => "media/arr"
     * @param folder Folder path
     */
    static normalizeFolder(folder : string) : string {
        return folder.split("/")
            .map((part) => part.trim())
            .filter((part) => part !== "")
            .join("/");
    }

    /**
     * Move the stack to a virtual folder ("" = no folder). Only x-dockge.folder is changed in the compose file.
     * @param folder Folder path, e.g. "media/arr"
     */
    async setFolder(folder : string) {
        if (!this.isManagedByDockge) {
            throw new ValidationError("Only stacks managed by Dockge can be moved to a folder");
        }

        folder = Stack.normalizeFolder(folder);

        // eslint-disable-next-line no-control-regex
        if (folder.length > 200 || /[\x00-\x1f]/.test(folder)) {
            throw new ValidationError("Invalid folder name");
        }

        const filePath = path.join(this.path, this._composeFileName);
        const content = await fsAsync.readFile(filePath, "utf-8");
        const doc = yaml.parseDocument(content);

        if (doc.errors.length > 0) {
            throw new ValidationError("The compose file contains errors, fix it first");
        }

        // Only the folder line is touched, the rest of the file is kept as written
        let updated : string;
        if (folder) {
            updated = setStringIn(content, [ "x-dockge", "folder" ], folder);
        } else if (doc.hasIn([ "x-dockge", "folder" ])) {
            updated = deleteIn(content, [ "x-dockge", "folder" ]);
        } else {
            return;
        }

        await fsAsync.writeFile(filePath, updated);
        this._composeYAML = undefined;
    }

    /**
     * Get the status of the stack from `docker compose ps --format json`
     */
    async ps() : Promise<object> {
        let res = await childProcessAsync.spawn("docker", this.getComposeOptions("ps", "--format", "json"), {
            cwd: this.path,
            encoding: "utf-8",
        });
        if (!res.stdout) {
            return {};
        }
        return JSON.parse(res.stdout.toString());
    }

    get isManagedByDockge() : boolean {
        return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
    }

    get status() : number {
        return this._status;
    }

    validate() {
        // Check name, allows [a-z][0-9] _ - only
        if (!this.name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        // Check YAML format
        yaml.parse(this.composeYAML);

        let lines = this.composeENV.split("\n");

        // Check if the .env is able to pass docker-compose
        // Prevent "setenv: The parameter is incorrect"
        // It only happens when there is one line and it doesn't contain "="
        if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
            throw new ValidationError("Invalid .env format");
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            try {
                this._composeYAML = fs.readFileSync(path.join(this.path, this._composeFileName), "utf-8");
            } catch (e) {
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            try {
                this._composeENV = fs.readFileSync(path.join(this.path, ".env"), "utf-8");
            } catch (e) {
                this._composeENV = "";
            }
        }
        return this._composeENV;
    }

    get path() : string {
        return path.join(this.server.stacksDir, this.name);
    }

    get fullPath() : string {
        let dir = this.path;

        // Compose up via node-pty
        let fullPathDir;

        // if dir is relative, make it absolute
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
     * Save the stack to the disk
     * @param isAdd
     */
    async save(isAdd : boolean) {
        this.validate();

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            // Create the stack folder
            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
        }

        // Write or overwrite the compose.yaml
        fs.writeFileSync(path.join(dir, this._composeFileName), this.composeYAML);

        // Write or overwrite the .env (it was edited in the UI but never saved).
        // If .env does not exist and the content is empty, do not create it.
        const envPath = path.join(dir, ".env");
        const envExists = await fileExists(envPath);
        if (envExists || this.composeENV.trim() !== "") {
            fs.writeFileSync(envPath, this.composeENV);
        }

        if (process.env.PUID && process.env.PGID) {
            const uid = Number(process.env.PUID);
            const gid = Number(process.env.PGID);
            fs.lchownSync(dir, uid, gid);
            fs.chownSync(path.join(dir, this._composeFileName), uid, gid);
            if (await fileExists(envPath)) {
                fs.chownSync(envPath, uid, gid);
            }
        }
    }

    async deploy(socket? : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error("Failed to deploy, please check the terminal output for more information.");
        }
        return exitCode;
    }

    /**
     * Named volumes declared by this stack whose real name depends on the project name
     * (not external, no explicit "name:"). Docker names them "<project>_<volume>", so after a rename
     * compose would create new, empty volumes.
     */
    getProjectScopedVolumes() : string[] {
        let config;
        try {
            config = yaml.parse(this.composeYAML) ?? {};
        } catch (e) {
            return [];
        }
        const volumes = config.volumes;
        if (!volumes || typeof volumes !== "object") {
            return [];
        }
        return Object.keys(volumes).filter((key) => {
            const volume = volumes[key];
            return !(volume && typeof volume === "object" && (volume.external || volume.name));
        });
    }

    /**
     * Rename the stack: stop it, rename its folder, start it again if it was running.
     * @param socket Socket
     * @param newName New stack name
     * @param keepVolumes Pin the names of project scoped named volumes (name: <old project>_<volume>) so the data is kept
     * @returns The renamed stack
     */
    async rename(socket : DockgeSocket | undefined, newName: string, keepVolumes: boolean) : Promise<Stack> {
        if (!this.isManagedByDockge) {
            throw new ValidationError("Only stacks managed by Dockge can be renamed");
        }

        if (newName === this.name) {
            throw new ValidationError("The new name is the same as the current one");
        }

        const newStack = new Stack(this.server, newName, undefined, undefined, true);
        newStack._composeYAML = "services: {}";
        newStack._composeENV = "";
        newStack.validate();

        if (await fileExists(newStack.path)) {
            throw new ValidationError("Stack name already exists");
        }

        // Also refuse names already used by a compose project not managed by Dockge
        const statusList = await Stack.getStatusList();
        if (statusList.has(newName)) {
            throw new ValidationError("A compose project with this name already exists");
        }

        await this.updateStatus();
        const wasRunning = this.status === RUNNING;
        const exists = this.status !== UNKNOWN;
        const oldName = this.name;

        // Update the compose file before moving it (surgical edits, the rest of the file is kept as written)
        let content = this.composeYAML;
        const originalContent = content;

        // A top-level "name:" equal to the folder name would keep the old project name
        if (yaml.parse(content)?.name === oldName) {
            content = setStringIn(content, [ "name" ], newName);
        }

        if (keepVolumes) {
            for (const volume of this.getProjectScopedVolumes()) {
                content = setStringIn(content, [ "volumes", volume, "name" ], `${oldName}_${volume}`);
            }
        }
        const changed = content !== originalContent;

        // Remove the containers and networks of the old project. Volumes are never removed.
        if (exists) {
            const terminalName = getComposeTerminalName(socket?.endpoint ?? "", oldName);
            const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("down", "--remove-orphans"), this.path, this.outputListener);
            if (exitCode !== 0) {
                throw new Error("Failed to stop the stack, please check the terminal output for more information.");
            }
        }

        await fsAsync.rename(this.path, newStack.path);

        const renamed = await Stack.getStack(this.server, newName);
        if (changed) {
            fs.writeFileSync(path.join(renamed.path, renamed._composeFileName), content);
            renamed._composeYAML = undefined;
        }

        if (wasRunning) {
            const terminalName = getComposeTerminalName(socket?.endpoint ?? "", newName);
            const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", renamed.getComposeOptions("up", "-d", "--remove-orphans"), renamed.path, this.outputListener);
            if (exitCode !== 0) {
                throw new Error("The stack was renamed but failed to start, please check the terminal output for more information.");
            }
        }

        log.info("stack", `Renamed stack ${oldName} to ${newName}`);
        return renamed;
    }

    async delete(socket? : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("down", "--remove-orphans"), this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error("Failed to delete, please check the terminal output for more information.");
        }

        // Remove the stack folder
        await fsAsync.rm(this.path, {
            recursive: true,
            force: true
        });

        return exitCode;
    }

    async updateStatus() {
        let statusList = await Stack.getStatusList();
        let status = statusList.get(this.name);

        if (status) {
            this._status = status;
        } else {
            this._status = UNKNOWN;
        }
    }

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        // Check if any compose file exists
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (await fileExists(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stacksDir = server.stacksDir;
        let stackList : Map<string, Stack>;

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0) {
            stackList = this.managedStackList;
        } else {
            stackList = new Map<string, Stack>();

            // Scan the stacks directory, and get the stack list
            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    // Check if it is a directory
                    let stat = await fsAsync.stat(path.join(stacksDir, filename));
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    // If no compose file exists, skip it
                    if (!await Stack.composeFileExists(stacksDir, filename)) {
                        continue;
                    }
                    let stack = await this.getStack(server, filename);
                    stack._status = CREATED_FILE;
                    stackList.set(filename, stack);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                    }
                }
            }

            // Cache by copying
            this.managedStackList = new Map(stackList);
        }

        // Get status from docker compose ls
        let res = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return stackList;
        }

        let composeList = JSON.parse(res.stdout.toString());

        for (let composeStack of composeList) {
            let stack = stackList.get(composeStack.Name);

            // This stack probably is not managed by Dockge, but we still want to show it
            if (!stack) {
                // Skip the dockge stack if it is not managed by Dockge
                if (composeStack.Name === "dockge") {
                    continue;
                }
                stack = new Stack(server, composeStack.Name);
                stackList.set(composeStack.Name, stack);
            }

            stack._status = this.statusConvert(composeStack.Status);
            stack._configFilePath = composeStack.ConfigFiles;
        }

        return stackList;
    }

    /**
     * Get the status list, it will be used to update the status of the stacks
     * Not all status will be returned, only the stack that is deployed or created to `docker compose` will be returned
     */
    static async getStatusList() : Promise<Map<string, number>> {
        let statusList = new Map<string, number>();

        let res = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return statusList;
        }

        let composeList = JSON.parse(res.stdout.toString());

        for (let composeStack of composeList) {
            statusList.set(composeStack.Name, this.statusConvert(composeStack.Status));
        }

        return statusList;
    }

    /**
     * Convert the status string from `docker compose ls` to the status number
     * Input Example: "exited(1), running(1)"
     * @param status
     */
    static statusConvert(status : string) : number {
        if (status.startsWith("created")) {
            return CREATED_STACK;
        } else if (status.includes("exited")) {
            // If one of the service is exited, we consider the stack is exited
            return EXITED;
        } else if (status.startsWith("running")) {
            // If there is no exited services, there should be only running services
            return RUNNING;
        } else {
            return UNKNOWN;
        }
    }

    static async getStack(server: DockgeServer, stackName: string, skipFSOperations = false) : Promise<Stack> {
        let dir = path.join(server.stacksDir, stackName);

        if (!skipFSOperations) {
            if (!await fileExists(dir) || !(await fsAsync.stat(dir)).isDirectory()) {
                // Maybe it is a stack managed by docker compose directly
                let stackList = await this.getStackList(server, true);
                let stack = stackList.get(stackName);

                if (stack) {
                    return stack;
                } else {
                    // Really not found
                    throw new ValidationError("Stack not found");
                }
            }
        } else {
            //log.debug("getStack", "Skip FS operations");
        }

        let stack : Stack;

        if (!skipFSOperations) {
            stack = new Stack(server, stackName);
        } else {
            stack = new Stack(server, stackName, undefined, undefined, true);
        }

        stack._status = UNKNOWN;
        stack._configFilePath = path.resolve(dir);
        return stack;
    }

    getComposeOptions(command : string, ...extraOptions : string[]) {
        //--env-file ./../global.env --env-file .env
        let options = [ "compose", command, ...extraOptions ];
        if (fs.existsSync(path.join(this.server.stacksDir, "global.env"))) {
            if (fs.existsSync(path.join(this.path, ".env"))) {
                options.splice(1, 0, "--env-file", "./.env");
            }
            options.splice(1, 0, "--env-file", "../global.env");
        }
        console.log(options);
        return options;
    }

    async start(socket? : DockgeSocket) {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error("Failed to start, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async stop(socket? : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("stop"), this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error("Failed to stop, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async restart(socket? : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("restart"), this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async down(socket? : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("down"), this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error("Failed to down, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async update(socket? : DockgeSocket) {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("pull"), this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error("Failed to pull, please check the terminal output for more information.");
        }

        // If the stack is not running, we don't need to restart it
        await this.updateStatus();
        log.debug("update", "Status: " + this.status);
        if (this.status !== RUNNING) {
            return exitCode;
        }

        exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, "docker", this.getComposeOptions("logs", "-f", "--tail", "100"), this.path);
        terminal.enableKeepAlive = true;
        terminal.bufferLimit = 1000;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        terminal.join(socket);
        terminal.start();
    }

    /**
     * Follow the logs of the whole stack (serviceName = "") or of a single service
     * @param socket Socket
     * @param serviceName Service name, empty for all services
     */
    async joinLogTerminal(socket: DockgeSocket, serviceName: string = "") {
        if (!serviceName) {
            return this.joinCombinedTerminal(socket);
        }

        if (!isValidServiceName(serviceName)) {
            throw new ValidationError("Invalid service name");
        }

        const terminalName = getServiceLogTerminalName(socket.endpoint, this.name, serviceName);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, "docker", this.getComposeOptions("logs", "-f", "--tail", "500", "--no-log-prefix", serviceName), this.path);
        terminal.enableKeepAlive = true;
        terminal.bufferLimit = 1000;
        terminal.join(socket);
        terminal.start();
    }

    async leaveLogTerminal(socket: DockgeSocket, serviceName: string = "") {
        if (!serviceName) {
            return this.leaveCombinedTerminal(socket);
        }

        if (!isValidServiceName(serviceName)) {
            throw new ValidationError("Invalid service name");
        }

        const terminal = Terminal.getTerminal(getServiceLogTerminalName(socket.endpoint, this.name, serviceName));
        if (terminal) {
            terminal.leave(socket);
        }
    }

    async leaveCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getTerminal(terminalName);
        if (terminal) {
            terminal.leave(socket);
        }
    }

    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            terminal = new InteractiveTerminal(this.server, terminalName, "docker", this.getComposeOptions("exec", serviceName, shell), this.path);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }

    async getServiceStatusList() {
        let statusList = new Map<string, Array<object>>();

        try {
            let res = await childProcessAsync.spawn("docker", this.getComposeOptions("ps", "--format", "json"), {
                cwd: this.path,
                encoding: "utf-8",
            });

            if (!res.stdout) {
                return statusList;
            }

            let lines = res.stdout?.toString().split("\n");

            const addLine = (obj: { Service: string, State: string, Name: string, Health: string }) => {
                if (!statusList.has(obj.Service)) {
                    statusList.set(obj.Service, []);
                }
                statusList.get(obj.Service)?.push({
                    status: obj.Health || obj.State,
                    name: obj.Name
                });
            };

            for (let line of lines) {
                try {
                    let obj = JSON.parse(line);
                    if (obj instanceof Array) {
                        obj.forEach(addLine);
                    } else {
                        addLine(obj);
                    }
                } catch (e) {
                }
            }

            return statusList;
        } catch (e) {
            log.error("getServiceStatusList", e);
            return statusList;
        }
    }

    async startService(socket : DockgeSocket | undefined, serviceName: string) {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", serviceName ], this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error(`Failed to start service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async stopService(socket : DockgeSocket | undefined, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "stop", serviceName ], this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error(`Failed to stop service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async restartService(socket : DockgeSocket | undefined, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "restart", serviceName ], this.path, this.outputListener);
        if (exitCode !== 0) {
            throw new Error(`Failed to restart service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }
}
