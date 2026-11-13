import { Settings } from "./settings";
import { Stack } from "./stack";
import { ValidationError } from "./util-server";

/**
 * Virtual folders of the sidebar.
 *
 * A stack's folder is stored in its compose file (x-dockge.folder). The list below is stored in Dockge's
 * database so that folders can exist while empty (create the structure first, move the stacks later),
 * and do not disappear when their last stack is moved out.
 */

const SETTING_KEY = "stackFolders";

export function validateFolder(folder : string) : string {
    const normalized = Stack.normalizeFolder(folder);
    // eslint-disable-next-line no-control-regex
    if (normalized.length > 200 || /[\x00-\x1f]/.test(normalized)) {
        throw new ValidationError("Invalid folder name");
    }
    return normalized;
}

export async function getStoredFolders() : Promise<string[]> {
    const value = await Settings.get(SETTING_KEY);
    return Array.isArray(value) ? value.filter((item) => typeof(item) === "string" && item) : [];
}

async function save(folders : Iterable<string>) {
    const list = [ ...new Set([ ...folders ].map((folder) => Stack.normalizeFolder(folder)).filter((folder) => folder)) ].sort();
    await Settings.set(SETTING_KEY, list, "stackFolders");
}

/**
 * Remember folders (no-op for "" and already known ones)
 */
export async function addFolders(...folders : string[]) {
    const current = await getStoredFolders();
    const added = folders.map((folder) => Stack.normalizeFolder(folder)).filter((folder) => folder && !current.includes(folder));
    if (added.length > 0) {
        await save([ ...current, ...added ]);
    }
}

function isInside(folder : string, parent : string) : boolean {
    return folder === parent || folder.startsWith(parent + "/");
}

/**
 * Rename/move the stored folder and its sub folders
 */
export async function renameStoredFolders(from : string, to : string) {
    const current = await getStoredFolders();
    const renamed = current.map((folder) => isInside(folder, from) ? Stack.normalizeFolder(to + folder.slice(from.length)) : folder);
    if (to) {
        renamed.push(to);
    }
    await save(renamed);
}

/**
 * Delete a folder and its sub folders. Refused if a stack is still inside.
 */
export async function deleteFolder(folder : string, stacks : Stack[]) {
    const inside = stacks.filter((stack) => stack.isManagedByDockge && stack.folder && isInside(stack.folder, folder));
    if (inside.length > 0) {
        throw new ValidationError(`The folder is not empty (${inside.map((stack) => stack.name).join(", ")})`);
    }
    const current = await getStoredFolders();
    await save(current.filter((item) => !isInside(item, folder)));
}
