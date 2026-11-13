import { promises as fsAsync } from "fs";
import path from "path";
import { ValidationError } from "./util-server";

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
}

export interface DirectoryListing {
    roots: string[];
    path: string;
    parent: string | null;
    entries: DirectoryEntry[];
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
 */
export async function listDirectory(requestedPath : string, showFiles = false) : Promise<DirectoryListing> {
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
