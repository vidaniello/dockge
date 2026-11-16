import fs from "fs";
import path from "path";

/**
 * Reader of /proc/self/mountinfo.
 *
 * Dockge usually runs in a container without the ZFS tools, but the kernel tells everything that is needed
 * to recognize the datasets: for a ZFS mount the "source" field is the dataset name, "root" is the folder of
 * the dataset that is mounted ("/" = the whole dataset), and the optional fields tell the propagation.
 * Format: https://www.kernel.org/doc/Documentation/filesystems/proc.txt (3.5 /proc/<pid>/mountinfo)
 */

export interface MountEntry {
    mountId : number;
    parentId : number;
    /** Folder of the mounted filesystem that appears at mountPoint ("/" = its root) */
    root : string;
    mountPoint : string;
    options : string[];
    /** shared:N, master:N, propagate_from:N, unbindable */
    optionalFields : string[];
    fsType : string;
    /** For ZFS: the dataset name, e.g. "pool/stacks" */
    source : string;
}

export type Propagation = "shared" | "slave" | "private";

/** f_type of statfs() for ZFS (ZFS_SUPER_MAGIC) */
export const ZFS_SUPER_MAGIC = 0x2fc12fc2;

/**
 * Fields are escaped with octal sequences: "\040" is a space, "\011" a tab, "\012" a new line, "\134" a backslash
 */
function unescape(value : string) : string {
    return value.replace(/\\([0-7]{3})/g, (_match, octal : string) => String.fromCharCode(parseInt(octal, 8)));
}

export function parseMountInfo(content : string) : MountEntry[] {
    const entries : MountEntry[] = [];
    for (const line of content.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        const fields = line.split(" ");
        const separator = fields.indexOf("-", 6);
        if (fields.length < 10 || separator === -1) {
            continue;
        }
        entries.push({
            mountId: Number(fields[0]),
            parentId: Number(fields[1]),
            root: unescape(fields[3]),
            mountPoint: unescape(fields[4]),
            options: fields[5].split(","),
            optionalFields: fields.slice(6, separator),
            fsType: fields[separator + 1],
            source: unescape(fields[separator + 2] ?? ""),
        });
    }
    return entries;
}

export function readMountInfo() : MountEntry[] {
    try {
        return parseMountInfo(fs.readFileSync("/proc/self/mountinfo", "utf-8"));
    } catch (e) {
        // Not Linux
        return [];
    }
}

export function isInside(child : string, parent : string) : boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The mount that contains a path: the deepest mount point above it.
 * When the same mount point is used more than once, the last mount hides the others.
 * @param entries Content of mountinfo
 * @param target Absolute path, already resolved (no symlinks)
 */
export function findMount(entries : MountEntry[], target : string) : MountEntry | undefined {
    let found : MountEntry | undefined;
    for (const entry of entries) {
        if (!isInside(target, entry.mountPoint)) {
            continue;
        }
        if (!found || entry.mountPoint.length >= found.mountPoint.length) {
            found = entry;
        }
    }
    return found;
}

/**
 * The mount whose mount point is exactly this path (the last one, it hides the others)
 */
export function mountAt(entries : MountEntry[], target : string) : MountEntry | undefined {
    let found : MountEntry | undefined;
    for (const entry of entries) {
        if (entry.mountPoint === target) {
            found = entry;
        }
    }
    return found;
}

export function getPropagation(entry : MountEntry) : Propagation {
    if (entry.optionalFields.some((field) => field.startsWith("master:"))) {
        return "slave";
    }
    if (entry.optionalFields.some((field) => field.startsWith("shared:"))) {
        return "shared";
    }
    return "private";
}

/**
 * Dataset and folder inside it that a path belongs to, for a path on ZFS.
 * E.g. /mnt/pool/apps/stacks on the mount of pool/apps → { dataset: "pool/apps", subPath: "stacks" }
 */
export function datasetOf(entry : MountEntry, target : string) : { dataset : string, subPath : string } {
    const relative = path.relative(entry.mountPoint, target);
    const subPath = path.posix.join(entry.root, relative.split(path.sep).join("/")).replace(/^\/+/, "").replace(/\/+$/, "");
    return {
        dataset: entry.source,
        subPath,
    };
}

/**
 * statfs() check, used when mountinfo cannot be read
 */
export function isZfsByStatfs(target : string) : boolean {
    try {
        return fs.statfsSync(target).type === ZFS_SUPER_MAGIC;
    } catch (e) {
        return false;
    }
}

/**
 * Free and total space of the filesystem of a path, in bytes
 */
export function getSpace(target : string) : { available : number, total : number } | null {
    try {
        const stat = fs.statfsSync(target);
        return {
            available: stat.bavail * stat.bsize,
            total: stat.blocks * stat.bsize,
        };
    } catch (e) {
        return null;
    }
}
