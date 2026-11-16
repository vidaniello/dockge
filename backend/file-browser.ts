import { promises as fsAsync } from "fs";
import path from "path";
import { ValidationError } from "./util-server";
import { describeHostPaths } from "./zfs/storage";
import { log } from "./log";

/**
 * Read-only folder browser used by the "pick a host path" dialog of the volume fields.
 *
 * Dockge runs in a container, so it can only see the host folders that are mounted into it.
 * Mount them with the same path on both sides (e.g. "/mnt:/mnt:ro") so that the paths shown here
 * are the real host paths, then list them in DOCKGE_BROWSE_ROOTS (comma separated, default "/mnt").
 */

export interface DirectoryEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    /** ZFS dataset mounted on this folder */
    dataset?: string | null;
    /** Stack whose folder contains this path */
    stack?: string | null;
}

export interface DirectoryListing {
    roots: string[];
    path: string;
    parent: string | null;
    entries: DirectoryEntry[];
    /** "truenas": read through the TrueNAS API (the folder does not need to be mounted into Dockge) */
    source?: "local" | "truenas";
    /** Why the TrueNAS API could not be used (local view shown instead) */
    remoteError?: string;
}

const MAX_ENTRIES = 2000;

export function getBrowseRoots() : string[] {
    const value = process.env.DOCKGE_BROWSE_ROOTS ?? "/mnt";
    return value.split(",")
        .map((root) => root.trim())
        .filter((root) => root !== "")
        .map((root) => path.resolve(root));
}

function isInside(child : string, parent : string) : boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Roots that exist inside this container
 */
async function existingRoots(roots : string[]) : Promise<string[]> {
    const result : string[] = [];
    for (const root of roots) {
        try {
            if ((await fsAsync.stat(root)).isDirectory()) {
                result.push(root);
            }
        } catch (e) {
            // Not mounted
        }
    }
    return result;
}

/**
 * List a folder. An empty path lists the roots.
 * @param requestedPath Absolute path
 * @param showFiles Also list files (a single file can be bind mounted too)
 * @param stacksDir Stacks folder, to tell which entries belong to a stack
 */
export async function listDirectory(requestedPath : string, showFiles = false, stacksDir? : string) : Promise<DirectoryListing> {
    // With the TrueNAS API configured the whole host is visible, without mounting /mnt into Dockge.
    // Without the role FILESYSTEM_ATTRS_READ (or another error) the local view is used.
    let listing : DirectoryListing | null = null;
    let remoteDatasets : Map<string, string> | null = null;
    let remoteError : string | undefined;
    try {
        const remote = await readRemoteListing(requestedPath, showFiles);
        if (remote) {
            listing = remote.listing;
            remoteDatasets = remote.datasets;
        }
    } catch (e) {
        if (e instanceof ValidationError) {
            throw e;
        }
        remoteError = e instanceof Error ? e.message : String(e);
        log.debug("file-browser", "TrueNAS listing failed, using the local view: " + remoteError);
    }
    if (!listing) {
        listing = await readListing(requestedPath, showFiles);
        listing.source = "local";
        listing.remoteError = remoteError;
    }
    if (stacksDir) {
        const info = describeHostPaths(listing.entries.map((entry) => entry.path), stacksDir);
        for (const entry of listing.entries) {
            Object.assign(entry, info.get(entry.path));
            const dataset = remoteDatasets?.get(entry.path);
            if (dataset) {
                entry.dataset = dataset;
            }
        }
    }
    return listing;
}

async function readRemoteListing(requestedPath : string, showFiles : boolean) : Promise<{ listing : DirectoryListing, datasets : Map<string, string> } | null> {
    const { getZfsSettings } = await import("./zfs/settings");
    const { getProvider } = await import("./zfs/provider");
    const provider = getProvider(await getZfsSettings());
    if (!provider) {
        return null;
    }
    const roots = getBrowseRoots();
    if (!requestedPath) {
        return {
            listing: {
                roots,
                path: "",
                parent: null,
                entries: roots.map((root) => ({
                    name: root,
                    path: root,
                    isDirectory: true,
                })),
                source: "truenas",
            },
            datasets: new Map(),
        };
    }
    if (!path.isAbsolute(requestedPath)) {
        throw new ValidationError("The path must be absolute");
    }
    const resolved = path.posix.normalize(requestedPath).replace(/\/+$/, "") || "/";
    const root = roots.find((candidate) => isInside(resolved, candidate));
    if (!root) {
        throw new ValidationError("This folder is outside of the browsable folders (DOCKGE_BROWSE_ROOTS)");
    }
    const { entries, datasets } = await provider.listHostDirectory(resolved, showFiles);
    return {
        listing: {
            roots,
            path: resolved,
            parent: resolved === root ? null : path.posix.dirname(resolved),
            entries: entries.slice(0, MAX_ENTRIES).sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1)),
            source: "truenas",
        },
        datasets,
    };
}

async function readListing(requestedPath : string, showFiles : boolean) : Promise<DirectoryListing> {
    const configuredRoots = getBrowseRoots();
    const roots = await existingRoots(configuredRoots);

    if (!requestedPath) {
        return {
            roots,
            path: "",
            parent: null,
            entries: roots.map((root) => ({
                name: root,
                path: root,
                isDirectory: true,
            })),
        };
    }

    if (!path.isAbsolute(requestedPath)) {
        throw new ValidationError("The path must be absolute");
    }

    // Resolve symlinks, so that a link cannot escape the allowed roots
    const resolved = await fsAsync.realpath(path.resolve(requestedPath));
    const realRoots = await Promise.all(roots.map((root) => fsAsync.realpath(root)));
    const rootIndex = realRoots.findIndex((root) => isInside(resolved, root));

    if (rootIndex === -1) {
        throw new ValidationError("This folder is outside of the browsable folders (DOCKGE_BROWSE_ROOTS)");
    }

    if (!(await fsAsync.stat(resolved)).isDirectory()) {
        throw new ValidationError("Not a folder");
    }

    const dirents = await fsAsync.readdir(resolved, { withFileTypes: true });
    const entries : DirectoryEntry[] = [];

    for (const dirent of dirents) {
        let isDirectory = dirent.isDirectory();

        // Follow symlinks to tell folders from files
        if (dirent.isSymbolicLink()) {
            try {
                isDirectory = (await fsAsync.stat(path.join(resolved, dirent.name))).isDirectory();
            } catch (e) {
                continue;
            }
        }

        if (!isDirectory && !showFiles) {
            continue;
        }

        entries.push({
            name: dirent.name,
            path: path.join(resolved, dirent.name),
            isDirectory,
        });

        if (entries.length >= MAX_ENTRIES) {
            break;
        }
    }

    entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });

    const parent = resolved === realRoots[rootIndex] ? null : path.dirname(resolved);

    return {
        roots,
        path: resolved,
        parent,
        entries,
    };
}
