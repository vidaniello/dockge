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

/*
 * Manual order of the sidebar.
 * For each folder ("" = top level) the ordered keys of its children: "f:<folder name>" or "s:<stack name>".
 * Children missing from the list keep the default order (folders by name, then stacks) after the listed ones.
 */

const ORDER_SETTING_KEY = "stackFolderOrder";

export type SidebarOrder = Record<string, string[]>;

export async function getSidebarOrder() : Promise<SidebarOrder> {
    const value = await Settings.get(ORDER_SETTING_KEY);
    return value && typeof(value) === "object" && !Array.isArray(value) ? value as SidebarOrder : {};
}

async function saveOrder(order : SidebarOrder) {
    // Drop empty lists
    for (const key of Object.keys(order)) {
        if (!Array.isArray(order[key]) || order[key].length === 0) {
            delete order[key];
        }
    }
    await Settings.set(ORDER_SETTING_KEY, order, "stackFolders");
}

function parentOf(folder : string) : string {
    const index = folder.lastIndexOf("/");
    return index === -1 ? "" : folder.slice(0, index);
}

function baseName(folder : string) : string {
    return folder.slice(folder.lastIndexOf("/") + 1);
}

/**
 * Set the order of the children of a folder
 * @param parent Folder ("" = top level)
 * @param keys Ordered keys ("f:name" / "s:name")
 */
export async function setChildrenOrder(parent : string, keys : string[]) {
    const order = await getSidebarOrder();
    const valid = keys.filter((key) => typeof(key) === "string" && /^[fs]:.+$/.test(key) && key.length <= 300);
    order[Stack.normalizeFolder(parent)] = [ ...new Set(valid) ];
    await saveOrder(order);
}

/**
 * Remove a child from the order of its folder (after a move to another folder)
 */
export async function removeFromOrder(parent : string, key : string) {
    const order = await getSidebarOrder();
    const list = order[parent];
    if (list && list.includes(key)) {
        order[parent] = list.filter((item) => item !== key);
        await saveOrder(order);
    }
}

/**
 * A folder was renamed / moved: move the order lists of the folder and of its sub folders,
 * and rename its key in its parent
 */
export async function renameFolderInOrder(from : string, to : string) {
    const order = await getSidebarOrder();
    const result : SidebarOrder = {};
    for (const [ parent, keys ] of Object.entries(order)) {
        const newParent = isInside(parent, from) ? Stack.normalizeFolder(to + parent.slice(from.length)) : parent;
        result[newParent] = [ ...(result[newParent] ?? []), ...keys ];
    }

    const fromParent = parentOf(from);
    const toParent = parentOf(to);
    const oldKey = "f:" + baseName(from);
    const newKey = "f:" + baseName(to);
    if (result[fromParent]) {
        if (fromParent === toParent) {
            result[fromParent] = result[fromParent].map((key) => key === oldKey ? newKey : key);
        } else {
            result[fromParent] = result[fromParent].filter((key) => key !== oldKey);
        }
    }
    await saveOrder(result);
}

/**
 * A stack was renamed: keep its position
 */
export async function renameStackInOrder(folder : string, oldName : string, newName : string) {
    const order = await getSidebarOrder();
    if (order[folder]) {
        order[folder] = order[folder].map((key) => key === "s:" + oldName ? "s:" + newName : key);
        await saveOrder(order);
    }
}

/**
 * A folder was deleted: forget its order and the order of its sub folders
 */
export async function deleteFolderOrder(folder : string) {
    const order = await getSidebarOrder();
    for (const parent of Object.keys(order)) {
        if (isInside(parent, folder)) {
            delete order[parent];
        }
    }
    const parent = parentOf(folder);
    if (order[parent]) {
        order[parent] = order[parent].filter((key) => key !== "f:" + baseName(folder));
    }
    await saveOrder(order);
}
