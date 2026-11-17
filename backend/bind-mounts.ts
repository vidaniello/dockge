import path from "path";
import yaml from "yaml";
import { setStringIn } from "./yaml-text-edit";

/**
 * Bind mounts that point into a stack's own folder with an absolute path.
 * When the stack folder is renamed, these paths must follow it, otherwise Docker creates the old
 * path again as an empty folder and the stack starts without its data.
 */

export interface BindMountRewrite {
    service : string;
    /** Path of the value in the compose file, e.g. ["services", "app", "volumes", 0] or [..., 0, "source"] */
    path : (string | number)[];
    /** Bind source as written */
    from : string;
    /** New bind source (relative to the stack folder) */
    to : string;
    /** New value of the YAML scalar at path */
    value : string;
}

export interface BindMountSkipped {
    service : string;
    source : string;
}

export interface BindMountAnalysis {
    rewrites : BindMountRewrite[];
    /** Sources with variable interpolation: they cannot be checked and are left as they are */
    skipped : BindMountSkipped[];
}

/**
 * Same check as isInside() in file-browser.ts
 */
function isInside(child : string, parent : string) : boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * "$$" is an escaped dollar sign, anything else with "$" is interpolated by compose
 */
export function hasVariable(value : string) : boolean {
    return value.replace(/\$\$/g, "").includes("$");
}

/**
 * The equivalent path relative to the stack folder ("./library", or "." for the folder itself)
 */
function toRelative(source : string, stackDir : string) : string {
    const relative = path.relative(stackDir, source);
    return relative === "" ? "." : "./" + relative.split(path.sep).join("/");
}

/**
 * Split a short syntax volume "HOST:CONTAINER[:mode]" into its host part and the rest (":CONTAINER[:mode]")
 */
export function splitShort(volume : string) : { host : string, rest : string } | undefined {
    // The first ":" that is not inside a "${VAR:-default}"
    let index = -1;
    let depth = 0;
    for (let i = 0; i < volume.length; i++) {
        if (volume[i] === "$" && volume[i + 1] === "{") {
            depth++;
            i++;
        } else if (volume[i] === "}" && depth > 0) {
            depth--;
        } else if (volume[i] === ":" && depth === 0) {
            index = i;
            break;
        }
    }
    if (index <= 0) {
        return undefined;
    }
    return {
        host: volume.slice(0, index),
        rest: volume.slice(index),
    };
}

/**
 * Find the bind mounts of services.*.volumes that use an absolute path inside stackDir
 * @param content Compose file content
 * @param stackDir Absolute path of the stack folder (before the rename)
 */
export function analyzeBindMounts(content : string, stackDir : string) : BindMountAnalysis {
    return analyzeBindMountsUnder(content, stackDir, ".");
}

/**
 * Find the bind mounts with an absolute path inside oldDir, and the value they get when oldDir becomes
 * newRelative (a path relative to the stack folder: "." for the stack folder itself, "./library" for a volume)
 */
export function analyzeBindMountsUnder(content : string, oldDir : string, newRelative : string) : BindMountAnalysis {
    const stackDir = oldDir;
    const result : BindMountAnalysis = {
        rewrites: [],
        skipped: [],
    };

    let config;
    try {
        config = yaml.parse(content);
    } catch (e) {
        return result;
    }
    const services = config?.services;
    if (!services || typeof services !== "object") {
        return result;
    }

    const dir = path.resolve(stackDir);

    const check = (service : string, source : string, valuePath : (string | number)[], toValue : (newSource : string) => string) => {
        if (hasVariable(source)) {
            // Relative paths follow the stack folder whatever the variable is
            if (!source.startsWith(".")) {
                result.skipped.push({
                    service,
                    source,
                });
            }
            return;
        }
        if (!path.isAbsolute(source) || !isInside(path.resolve(source), dir)) {
            return;
        }
        const inner = toRelative(path.resolve(source), dir);
        const to = newRelative === "." ? inner : (inner === "." ? newRelative : newRelative.replace(/\/+$/, "") + inner.slice(1));
        result.rewrites.push({
            service,
            path: valuePath,
            from: source,
            to,
            value: toValue(to),
        });
    };

    for (const [ service, definition ] of Object.entries(services)) {
        const volumes = (definition as { volumes? : unknown } | null)?.volumes;
        if (!Array.isArray(volumes)) {
            continue;
        }
        volumes.forEach((volume : unknown, index : number) => {
            if (typeof volume === "string") {
                const parts = splitShort(volume);
                if (parts) {
                    check(service, parts.host, [ "services", service, "volumes", index ], (to) => to + parts.rest);
                }
            } else if (volume && typeof volume === "object") {
                const { type, source } = volume as { type? : unknown, source? : unknown };
                if (type === "bind" && typeof source === "string") {
                    check(service, source, [ "services", service, "volumes", index, "source" ], (to) => to);
                }
            }
        });
    }

    return result;
}

/**
 * Apply the rewrites of analyzeBindMounts(), keeping the rest of the file as written
 */
export function rewriteBindMounts(content : string, rewrites : BindMountRewrite[]) : string {
    for (const rewrite of rewrites) {
        content = setStringIn(content, rewrite.path, rewrite.value);
    }
    return content;
}

/**
 * Human readable warning for the bind sources that were not checked
 */
export function bindMountWarnings(skipped : BindMountSkipped[]) : string[] {
    return skipped.map((item) => `Bind mount "${item.source}" of service "${item.service}" uses a variable and was not changed: if it points into the stack folder, update it to the new folder name`);
}
