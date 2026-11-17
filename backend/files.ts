import fs from "fs";
import { promises as fsAsync } from "fs";
import path from "path";
import { DockgeServer } from "./dockge-server";
import { ValidationError } from "./util-server";
import { getBrowseRoots } from "./file-browser";
import { mountAt, mountsInside, readMountInfo } from "./zfs/mountinfo";
import { log } from "./log";

/**
 * Files of a stack and of its volumes, for the API / MCP and the file manager of the stack page.
 *
 * Paths: relative ("./config/app.yml", "." for the stack folder) are inside the folder of the given stack;
 * absolute paths are allowed inside the stacks folder and inside DOCKGE_BROWSE_ROOTS (the host folders mounted into
 * Dockge, e.g. the volumes with absolute paths). Writing works only where the folder is mounted read-write.
 *
 * Safety: every path is resolved (symbolic links included) and must stay inside an allowed folder; a symbolic link is
 * never followed out of it; mount points (datasets) and the allowed folders themselves are never deleted or moved; a
 * recursive delete never enters another mounted filesystem.
 */

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_BINARY_BYTES = 16 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export interface FileEntry {
    name : string;
    /** "./relative" inside the stack, absolute otherwise */
    path : string;
    type : "file" | "directory" | "symlink" | "other";
    size : number;
    modified : string;
    /** Octal, e.g. "0644" */
    mode : string;
    uid : number;
    gid : number;
    /** Target of a symbolic link */
    target? : string;
    /** ZFS dataset mounted on this folder */
    dataset? : string | null;
}

interface Resolved {
    /** Absolute path as given (not resolved), used for the operation */
    absolute : string;
    /** "./relative" inside the stack or absolute */
    display : string;
    /** The allowed folder it is in */
    root : string;
    /** It is the allowed folder itself (or the stack folder) */
    isRoot : boolean;
}

function isInside(child : string, parent : string) : boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathOrNull(target : string) : string | null {
    try {
        return fs.realpathSync(target);
    } catch (e) {
        return null;
    }
}

/**
 * The deepest existing folder of a path, resolved
 */
function existingAncestor(target : string) : string {
    let current = target;
    for (;;) {
        const real = realpathOrNull(current);
        if (real) {
            return real;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return current;
        }
        current = parent;
    }
}

export class FileService {
    private stackDir : string | null;
    private stacksDir : string;

    constructor(private server : DockgeServer, private stackName : string | null) {
        this.stacksDir = realpathOrNull(server.stacksDir) ?? path.resolve(server.stacksDir);
        if (stackName !== null) {
            if (!/^[a-z0-9_-]+$/.test(stackName)) {
                throw new ValidationError("Invalid stack name");
            }
            this.stackDir = path.join(this.stacksDir, stackName);
            if (!fs.existsSync(this.stackDir)) {
                throw new ValidationError("Stack not found");
            }
        } else {
            this.stackDir = null;
        }
    }

    private roots() : string[] {
        const roots = [ this.stacksDir, ...getBrowseRoots().map((root) => realpathOrNull(root) ?? root) ];
        if (this.stackDir) {
            roots.unshift(fs.realpathSync(this.stackDir));
        }
        return [ ...new Set(roots) ];
    }

    private display(absolute : string) : string {
        if (this.stackDir && isInside(absolute, this.stackDir)) {
            const relative = path.relative(this.stackDir, absolute);
            return relative === "" ? "." : "./" + relative.split(path.sep).join("/");
        }
        return absolute;
    }

    /**
     * Resolve a path given by the caller and check that it stays inside an allowed folder.
     * @param input Path
     * @param followLast Resolve a symbolic link at the end of the path (reading, listing); not when it is the object
     * of the operation (delete, move, write over a link)
     */
    resolve(input : unknown, followLast = true) : Resolved {
        if (typeof input !== "string" || input.trim() === "") {
            throw new ValidationError("path is required");
        }
        const text = input.trim();
        if (text.includes("\0")) {
            throw new ValidationError("Invalid path");
        }
        let absolute : string;
        if (path.isAbsolute(text)) {
            absolute = path.resolve(text);
        } else {
            if (!this.stackDir) {
                throw new ValidationError("A relative path needs a stack");
            }
            absolute = path.resolve(this.stackDir, text);
        }

        // What the path really points to: the link itself is checked through its folder when it is not followed
        let real : string;
        const exists = fs.existsSync(absolute) || (() => {
            try {
                fs.lstatSync(absolute);
                return true;
            } catch (e) {
                return false;
            }
        })();
        if (exists && followLast) {
            real = realpathOrNull(absolute) ?? absolute;
        } else if (exists) {
            real = path.join(realpathOrNull(path.dirname(absolute)) ?? path.dirname(absolute), path.basename(absolute));
        } else {
            const ancestor = existingAncestor(path.dirname(absolute));
            real = path.join(ancestor, path.relative(existingAncestorPath(path.dirname(absolute)), absolute));
        }

        const roots = this.roots();
        const root = roots.find((candidate) => isInside(real, candidate));
        if (!root) {
            throw new ValidationError(`${text} is outside the folders Dockge can manage (the stack folder, the stacks folder and DOCKGE_BROWSE_ROOTS)`);
        }
        return {
            absolute: real,
            display: this.display(real),
            root,
            isRoot: roots.includes(real),
        };
    }

    private entry(absolute : string, stat : fs.Stats, mounts = readMountInfo()) : FileEntry {
        const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
        const result : FileEntry = {
            name: path.basename(absolute),
            path: this.display(absolute),
            type,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            mode: "0" + (stat.mode & 0o7777).toString(8).padStart(3, "0"),
            uid: stat.uid,
            gid: stat.gid,
        };
        if (type === "symlink") {
            try {
                result.target = fs.readlinkSync(absolute);
            } catch (e) {
                // unreadable
            }
        }
        if (type === "directory") {
            const mount = mountAt(mounts, absolute);
            result.dataset = mount && mount.fsType === "zfs" && mount.root === "/" ? mount.source : null;
        }
        return result;
    }

    async list(input : unknown) : Promise<{ path : string, writable : boolean, entries : FileEntry[], truncated : boolean }> {
        const target = this.resolve(input ?? ".");
        const stat = await fsAsync.stat(target.absolute).catch(() => null);
        if (!stat || !stat.isDirectory()) {
            throw new ValidationError(`${target.display} is not a folder`);
        }
        const mounts = readMountInfo();
        const names = await fsAsync.readdir(target.absolute);
        const entries : FileEntry[] = [];
        for (const name of names.slice(0, MAX_ENTRIES)) {
            const absolute = path.join(target.absolute, name);
            try {
                entries.push(this.entry(absolute, await fsAsync.lstat(absolute), mounts));
            } catch (e) {
                // vanished meanwhile
            }
        }
        entries.sort((a, b) => (a.type === "directory") === (b.type === "directory") ? a.name.localeCompare(b.name) : (a.type === "directory" ? -1 : 1));
        return {
            path: target.display,
            writable: await isWritable(target.absolute),
            entries,
            truncated: names.length > MAX_ENTRIES,
        };
    }

    async read(input : unknown, encoding : "utf8" | "base64" = "utf8") {
        const target = this.resolve(input);
        const stat = await fsAsync.stat(target.absolute).catch(() => null);
        if (!stat || !stat.isFile()) {
            throw new ValidationError(`${target.display} is not a file`);
        }
        const limit = encoding === "base64" ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
        if (stat.size > limit) {
            throw new ValidationError(`${target.display} is ${stat.size} bytes: the limit is ${limit} (${encoding})`);
        }
        const buffer = await fsAsync.readFile(target.absolute);
        const binary = isBinary(buffer);
        if (encoding === "utf8" && binary) {
            throw new ValidationError(`${target.display} is a binary file: read it with encoding base64`);
        }
        const text = encoding === "utf8" ? buffer.toString("utf8") : null;
        return {
            path: target.display,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            mode: "0" + (stat.mode & 0o7777).toString(8).padStart(3, "0"),
            binary,
            encoding,
            content: text !== null ? text.replace(/^\uFEFF/, "") : buffer.toString("base64"),
            bom: text !== null && text.startsWith("\uFEFF"),
            lineEnding: text !== null ? lineEnding(text) : null,
            writable: await isWritable(path.dirname(target.absolute)),
        };
    }

    /**
     * Write a file. An existing file is written in place (owner, permissions and ACLs are kept); a new one gets the
     * owner of its folder.
     */
    async write(input : unknown, options : { content : unknown, encoding? : unknown, lineEnding? : unknown, executable? : unknown, createOnly? : unknown, createParents? : unknown }) {
        const target = this.resolve(input, false);
        if (target.isRoot) {
            throw new ValidationError(`${target.display} is a folder`);
        }
        if (typeof options.content !== "string") {
            throw new ValidationError("content must be a string");
        }
        const encoding = options.encoding === "base64" ? "base64" : "utf8";
        let buffer : Buffer;
        if (encoding === "base64") {
            buffer = Buffer.from(options.content, "base64");
        } else {
            let text = options.content;
            if (options.lineEnding === "lf") {
                text = text.replace(/\r\n/g, "\n");
            } else if (options.lineEnding === "crlf") {
                text = text.replace(/\r?\n/g, "\r\n");
            }
            buffer = Buffer.from(text, "utf8");
        }
        if (buffer.length > MAX_BINARY_BYTES) {
            throw new ValidationError(`The content is ${buffer.length} bytes: the limit is ${MAX_BINARY_BYTES}`);
        }

        const existing = await fsAsync.lstat(target.absolute).catch(() => null);
        if (existing?.isSymbolicLink()) {
            throw new ValidationError(`${target.display} is a symbolic link: write to its target instead`);
        }
        if (existing && !existing.isFile()) {
            throw new ValidationError(`${target.display} is not a regular file`);
        }
        if (existing && options.createOnly === true) {
            throw new ValidationError(`${target.display} already exists`);
        }

        const folder = path.dirname(target.absolute);
        if (!fs.existsSync(folder)) {
            if (options.createParents !== true) {
                throw new ValidationError(`The folder of ${target.display} does not exist (createParents: true to create it)`);
            }
            await this.makeDirAbsolute(folder);
        }
        if (!await isWritable(folder)) {
            throw new ValidationError(`${this.display(folder)} is read-only for Dockge (mounted :ro?)`);
        }

        if (existing) {
            await fsAsync.writeFile(target.absolute, buffer);
        } else {
            const parent = await fsAsync.stat(folder);
            await fsAsync.writeFile(target.absolute, buffer, { mode: 0o644 });
            await fsAsync.chown(target.absolute, parent.uid, parent.gid).catch(() => {});
        }
        if (options.executable === true || options.executable === false) {
            const mode = (await fsAsync.stat(target.absolute)).mode & 0o7777;
            const read = (mode & 0o444) >> 2;
            await fsAsync.chmod(target.absolute, options.executable ? mode | read : mode & ~0o111);
        }
        log.info("files", `Written ${target.absolute} (${buffer.length} bytes)`);
        const stat = await fsAsync.lstat(target.absolute);
        return {
            ...this.entry(target.absolute, stat),
            created: !existing,
        };
    }

    /**
     * Upload in chunks (socket.io messages are limited to 1 MB): the data goes to a hidden temporary file next to the
     * target, which replaces it at the last chunk.
     * @param input Target file
     * @param uploadId Random id of the upload (letters, digits, -)
     * @param offset Position of the chunk (0 for the first one: the temporary file is created)
     * @param chunk Data
     * @param last Last chunk: move the file into place
     * @param overwrite Replace an existing file
     */
    async uploadChunk(input : unknown, uploadId : unknown, offset : number, chunk : Buffer, last : boolean, overwrite : boolean) {
        if (typeof uploadId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(uploadId)) {
            throw new ValidationError("Invalid upload id");
        }
        const target = this.resolve(input, false);
        if (target.isRoot) {
            throw new ValidationError(`${target.display} is a folder`);
        }
        const folder = path.dirname(target.absolute);
        const temporary = path.join(folder, `.dockge-upload-${uploadId}`);
        if (offset === 0) {
            if (!fs.existsSync(folder)) {
                throw new ValidationError(`The folder of ${target.display} does not exist`);
            }
            if (!await isWritable(folder)) {
                throw new ValidationError(`${this.display(folder)} is read-only for Dockge`);
            }
            const existing = await fsAsync.lstat(target.absolute).catch(() => null);
            if (existing && !overwrite) {
                throw new ValidationError(`${target.display} already exists`);
            }
            if (existing && !existing.isFile()) {
                throw new ValidationError(`${target.display} is not a regular file`);
            }
            await fsAsync.writeFile(temporary, chunk, { mode: 0o644 });
        } else {
            const size = (await fsAsync.stat(temporary).catch(() => null))?.size;
            if (size !== offset) {
                await fsAsync.rm(temporary, { force: true });
                throw new ValidationError("Upload out of order: start again");
            }
            if (size + chunk.length > MAX_UPLOAD_BYTES) {
                await fsAsync.rm(temporary, { force: true });
                throw new ValidationError(`The file is larger than ${MAX_UPLOAD_BYTES} bytes`);
            }
            await fsAsync.appendFile(temporary, chunk);
        }
        if (!last) {
            return {
                received: offset + chunk.length,
            };
        }
        const existing = await fsAsync.lstat(target.absolute).catch(() => null);
        if (existing) {
            // Replace the content in place: owner, permissions and ACLs of the file are kept
            await fsAsync.copyFile(temporary, target.absolute);
            await fsAsync.rm(temporary, { force: true });
        } else {
            const parent = await fsAsync.stat(folder);
            await fsAsync.rename(temporary, target.absolute);
            await fsAsync.chown(target.absolute, parent.uid, parent.gid).catch(() => {});
        }
        log.info("files", `Uploaded ${target.absolute}`);
        return this.entry(target.absolute, await fsAsync.lstat(target.absolute));
    }

    private async makeDirAbsolute(absolute : string) {
        // Create the missing folders one by one, each with the owner of its parent
        const missing : string[] = [];
        let current = absolute;
        while (!fs.existsSync(current)) {
            missing.unshift(current);
            current = path.dirname(current);
        }
        for (const folder of missing) {
            const parent = await fsAsync.stat(path.dirname(folder));
            await fsAsync.mkdir(folder, { mode: 0o755 });
            await fsAsync.chown(folder, parent.uid, parent.gid).catch(() => {});
        }
    }

    async makeDir(input : unknown) {
        const target = this.resolve(input, false);
        if (fs.existsSync(target.absolute)) {
            throw new ValidationError(`${target.display} already exists`);
        }
        if (!await isWritable(existingAncestor(target.absolute))) {
            throw new ValidationError(`${target.display} is in a read-only folder for Dockge`);
        }
        await this.makeDirAbsolute(target.absolute);
        return this.entry(target.absolute, await fsAsync.lstat(target.absolute));
    }

    private checkMovable(target : Resolved, action : string) {
        if (target.isRoot) {
            throw new ValidationError(`${target.display} cannot be ${action}: it is the stack folder or an allowed root`);
        }
        const mounts = readMountInfo();
        if (mountAt(mounts, target.absolute)) {
            throw new ValidationError(`${target.display} is a mount point (e.g. a dataset): it cannot be ${action} here`);
        }
    }

    async move(from : unknown, to : unknown, overwrite = false) {
        const source = this.resolve(from, false);
        const destination = this.resolve(to, false);
        this.checkMovable(source, "moved");
        if (!await fsAsync.lstat(source.absolute).catch(() => null)) {
            throw new ValidationError(`${source.display} does not exist`);
        }
        if (isInside(destination.absolute, source.absolute)) {
            throw new ValidationError("A folder cannot be moved inside itself");
        }
        const existing = await fsAsync.lstat(destination.absolute).catch(() => null);
        if (existing && !overwrite) {
            throw new ValidationError(`${destination.display} already exists`);
        }
        if (existing?.isDirectory()) {
            throw new ValidationError(`${destination.display} is a folder: it is not replaced`);
        }
        if (!fs.existsSync(path.dirname(destination.absolute))) {
            throw new ValidationError(`The folder of ${destination.display} does not exist`);
        }
        if (mountsInside(readMountInfo(), source.absolute).length > 0) {
            throw new ValidationError(`${source.display} contains mount points: it is not moved`);
        }
        try {
            await fsAsync.rename(source.absolute, destination.absolute);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EXDEV") {
                throw new ValidationError(`${source.display} and ${destination.display} are on different filesystems (datasets): move across them is a copy, not done here`);
            }
            throw e;
        }
        log.info("files", `Moved ${source.absolute} to ${destination.absolute}`);
        return {
            from: source.display,
            to: destination.display,
        };
    }

    async remove(input : unknown, recursive = false) {
        const target = this.resolve(input, false);
        this.checkMovable(target, "deleted");
        const stat = await fsAsync.lstat(target.absolute).catch(() => null);
        if (!stat) {
            throw new ValidationError(`${target.display} does not exist`);
        }
        if (stat.isDirectory()) {
            const entries = await fsAsync.readdir(target.absolute);
            if (entries.length > 0 && !recursive) {
                throw new ValidationError(`${target.display} is not empty (recursive: true to delete its content)`);
            }
            // rm -r would go into a dataset mounted below
            const inside = mountsInside(readMountInfo(), target.absolute);
            if (inside.length > 0) {
                throw new ValidationError(`${target.display} contains mount points (${inside.map((entry) => entry.mountPoint).join(", ")}): it is not deleted`);
            }
            await fsAsync.rm(target.absolute, {
                recursive: true,
            });
        } else {
            await fsAsync.unlink(target.absolute);
        }
        log.info("files", `Deleted ${target.absolute}`);
        return {
            deleted: target.display,
            type: stat.isDirectory() ? "directory" : "file",
        };
    }
}

/**
 * Absolute path of the deepest existing folder (not resolved): the base of a new path
 */
function existingAncestorPath(target : string) : string {
    let current = target;
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return current;
}

async function isWritable(folder : string) : Promise<boolean> {
    try {
        await fsAsync.access(folder, fs.constants.W_OK);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * NUL bytes or invalid UTF-8 in the first 8 KiB
 */
export function isBinary(buffer : Buffer) : boolean {
    const sample = buffer.subarray(0, 8192);
    if (sample.includes(0)) {
        return true;
    }
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(sample.length === buffer.length ? sample : trimIncomplete(sample));
        return false;
    } catch (e) {
        return true;
    }
}

/** A UTF-8 character may be cut at the end of the sample */
function trimIncomplete(sample : Buffer) : Buffer {
    let end = sample.length;
    for (let i = 1; i <= 3 && end - i >= 0; i++) {
        const byte = sample[end - i];
        if ((byte & 0xc0) === 0xc0) {
            return sample.subarray(0, end - i);
        }
        if ((byte & 0x80) === 0) {
            break;
        }
    }
    return sample;
}

export function lineEnding(text : string) : "LF" | "CRLF" | "mixed" | "none" {
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/\n/g) ?? []).length - crlf;
    if (crlf === 0 && lf === 0) {
        return "none";
    }
    if (crlf > 0 && lf > 0) {
        return "mixed";
    }
    return crlf > 0 ? "CRLF" : "LF";
}
