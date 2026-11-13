import yaml, { isMap, isScalar, Pair, YAMLMap } from "yaml";

/**
 * Small, surgical edits of a YAML file that keep everything else byte for byte
 * (comments, flow arrays, quotes, line breaks...). yaml.Document#toString() re-formats the whole file,
 * which users do not want when Dockge only adds a "folder:" or a volume "name:".
 *
 * Every edit is verified by parsing the result; if the text edit is not possible or does not give the
 * expected value, it falls back to a full re-serialization of the document.
 */

type Path = (string | number)[];

const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

/**
 * Format a string as a YAML scalar: plain when it is safe, double quoted otherwise
 */
export function formatScalar(value : string) : string {
    if (/^[A-Za-z_][A-Za-z0-9_./-]*$/.test(value) && !RESERVED.test(value)) {
        return value;
    }
    return JSON.stringify(value);
}

function lineStart(content : string, offset : number) : number {
    return content.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(content : string, offset : number) : number {
    const end = content.indexOf("\n", offset);
    return end === -1 ? content.length : end;
}

/**
 * "key:" with nothing after it
 */
function isEmptyValue(value : unknown) : boolean {
    return value === null || value === undefined || (isScalar(value) && value.value === null && !(value.source ?? "").toString().trim());
}

function findPair(map : YAMLMap, key : string) : Pair | undefined {
    return map.items.find((item) => isScalar(item.key) && item.key.value === key) as Pair | undefined;
}

/**
 * Set a string value at path (e.g. ["x-dockge", "folder"]), creating the missing maps.
 */
export function setStringIn(content : string, path : Path, value : string) : string {
    let result : string | undefined;
    try {
        result = textSetStringIn(content, path, value);
    } catch (e) {
        result = undefined;
    }

    if (result !== undefined && verify(result, path, value)) {
        return result;
    }
    return fallback(content, (doc) => {
        // Turn empty or scalar intermediate values ("data:") into maps
        for (let i = 1; i < path.length; i++) {
            const prefix = path.slice(0, i);
            if (!isMap(doc.getIn(prefix, true))) {
                doc.setIn(prefix, doc.createNode({}));
            }
        }
        doc.setIn(path, value);
    });
}

/**
 * Delete the entry at path. If its parent map becomes empty, the parent is deleted too.
 */
export function deleteIn(content : string, path : Path) : string {
    let result : string | undefined;
    try {
        result = textDeleteIn(content, path);
    } catch (e) {
        result = undefined;
    }

    if (result !== undefined && verify(result, path, undefined)) {
        return result;
    }
    return fallback(content, (doc) => {
        doc.deleteIn(path);
        const parentPath = path.slice(0, -1);
        const parent = parentPath.length ? doc.getIn(parentPath) : undefined;
        if (parent && isMap(parent) && parent.items.length === 0) {
            doc.deleteIn(parentPath);
        }
    });
}

function verify(content : string, path : Path, expected : string | undefined) : boolean {
    const doc = yaml.parseDocument(content);
    if (doc.errors.length > 0) {
        return false;
    }
    return doc.getIn(path) === expected;
}

function fallback(content : string, edit : (doc : yaml.Document) => void) : string {
    const doc = yaml.parseDocument(content);
    edit(doc);
    return doc.toString({ lineWidth: 0 });
}

function textSetStringIn(content : string, path : Path, value : string) : string | undefined {
    const doc = yaml.parseDocument(content, { keepSourceTokens: true });
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
        return undefined;
    }

    let map = doc.contents as YAMLMap;

    for (let i = 0; i < path.length; i++) {
        const key = String(path[i]);
        const last = i === path.length - 1;
        const pair = findPair(map, key);

        if (pair && last) {
            // Replace an existing scalar value
            if (isScalar(pair.value) && pair.value.range && !isEmptyValue(pair.value)) {
                const [ start, end ] = pair.value.range;
                return content.slice(0, start) + formatScalar(value) + content.slice(end);
            }
            if (isEmptyValue(pair.value) && isScalar(pair.key) && pair.key.range) {
                // "key:" without value
                const end = lineEnd(content, pair.key.range[1]);
                const keyEnd = content.indexOf(":", pair.key.range[1]) + 1;
                return content.slice(0, keyEnd) + " " + formatScalar(value) + content.slice(Math.min(end, keyEnd));
            }
            return undefined;
        }

        if (pair && isMap(pair.value) && !pair.value.flow) {
            map = pair.value;
            continue;
        }

        if (pair) {
            // "key:" with an empty value: turn it into a map
            if (isEmptyValue(pair.value) && isScalar(pair.key) && pair.key.range) {
                const keyLineStart = lineStart(content, pair.key.range[0]);
                const indent = " ".repeat(pair.key.range[0] - keyLineStart + 2);
                const insertAt = lineEnd(content, pair.key.range[1]);
                return content.slice(0, insertAt) + "\n" + buildBlock(path.slice(i + 1), value, indent) + content.slice(insertAt);
            }
            return undefined;
        }

        // The key does not exist in this map: add it with the rest of the path
        const remaining = path.slice(i);
        if (map === doc.contents) {
            // Top level: append at the end of the file
            const separator = content.endsWith("\n") || content === "" ? "" : "\n";
            return content + separator + buildBlock(remaining, value, "") + "\n";
        }

        // Nested block map: insert before its first item, with the same indentation
        const firstKey = map.items[0]?.key;
        if (isScalar(firstKey) && firstKey.range) {
            const start = lineStart(content, firstKey.range[0]);
            const indent = " ".repeat(firstKey.range[0] - start);
            return content.slice(0, start) + buildBlock(remaining, value, indent) + "\n" + content.slice(start);
        }

        return undefined;
    }

    return undefined;
}

/**
 * ["a", "b"], "v", "  " => "  a:\n    b: v"
 */
function buildBlock(path : Path, value : string, indent : string) : string {
    const lines : string[] = [];
    path.forEach((key, index) => {
        const pad = indent + "  ".repeat(index);
        const last = index === path.length - 1;
        lines.push(pad + formatScalar(String(key)) + ":" + (last ? " " + formatScalar(value) : ""));
    });
    return lines.join("\n");
}

function textDeleteIn(content : string, path : Path) : string | undefined {
    const doc = yaml.parseDocument(content, { keepSourceTokens: true });
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
        return undefined;
    }

    let map = doc.contents as YAMLMap;
    let parent : { map : YAMLMap, pair : Pair } | undefined;

    for (let i = 0; i < path.length - 1; i++) {
        const pair = findPair(map, String(path[i]));
        if (!pair || !isMap(pair.value) || pair.value.flow) {
            return pair ? undefined : content;
        }
        parent = {
            map,
            pair,
        };
        map = pair.value;
    }

    const pair = findPair(map, String(path[path.length - 1]));
    if (!pair) {
        return content;
    }

    // Delete the whole parent entry if this was its only item
    const target = map.items.length === 1 && parent ? parent.pair : pair;
    const key = target.key;
    if (!isScalar(key) || !key.range) {
        return undefined;
    }

    const start = lineStart(content, key.range[0]);
    let end : number;
    const valueNode = target.value as { range? : [number, number, number] } | null;
    if (valueNode && valueNode.range && !isEmptyValue(valueNode)) {
        end = lineEnd(content, valueNode.range[1]);
    } else {
        end = lineEnd(content, key.range[1]);
    }

    // Also remove the line break
    if (end < content.length) {
        end++;
    }
    return content.slice(0, start) + content.slice(end);
}
