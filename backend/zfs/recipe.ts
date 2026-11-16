import yaml from "yaml";
import { ValidationError } from "../util-server";
import { CreateDatasetOptions, DatasetInfo } from "./provider";

/**
 * x-dockge.zfs in compose.yaml: how to create the datasets of the volumes (docs/ZFS-DESIGN.md §8).
 *
 * x-dockge:
 *   zfs:
 *     library: { recordsize: 1M }
 *     pgdata:  { recordsize: 16K, owner: "999:999", mode: "0700" }
 *
 * Keys are paths relative to the stack folder. ZFS says what exists, the compose file says how to create it:
 * existing datasets are never changed, only compared.
 */

export interface VolumeRecipe {
    recordsize? : string;
    compression? : string;
    atime? : "ON" | "OFF";
    /** Bytes */
    quota? : number;
    /** uid:gid (numbers) */
    owner? : string;
    /** Octal, e.g. "0750" */
    mode? : string;
}

const RECORD_SIZES = [ "512", "1K", "2K", "4K", "8K", "16K", "32K", "64K", "128K", "256K", "512K", "1M", "2M", "4M", "8M", "16M" ];
const COMPRESSION = /^(ON|OFF|LZ4|GZIP(-[1-9])?|ZSTD(-([1-9]|1[0-9]))?|ZSTD-FAST(-\d{1,4})?|ZLE|LZJB)$/;

/**
 * "./data/db/" → "data/db". Throws for paths that leave the stack folder.
 */
export function normalizeVolumePath(value : string) : string {
    const clean = value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
    const parts = clean.split("/");
    if (!clean || parts.some((part) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) || part === "..")) {
        throw new ValidationError(`Invalid volume path "${value}": use letters, digits, ".", "-" and "_", relative to the stack folder (e.g. ./data)`);
    }
    return parts.join("/");
}

export function parseSize(value : unknown) : number | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return Math.floor(value);
    }
    const match = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)i?B?$/i.exec(String(value).trim());
    if (!match) {
        throw new ValidationError(`Invalid size "${value}" (e.g. 10G)`);
    }
    const power = " KMGTP".indexOf(match[2].toUpperCase() || " ");
    return Math.floor(Number(match[1]) * 1024 ** power);
}

/**
 * Normalize "1m" → "1M", "131072" → "128K"
 */
export function normalizeRecordSize(value : unknown) : string {
    let text = String(value).trim().toUpperCase().replace(/B$/, "").replace(/I$/, "");
    if (/^\d+$/.test(text)) {
        const bytes = Number(text);
        text = bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0 ? `${bytes / 1024 / 1024}M` : bytes >= 1024 && bytes % 1024 === 0 ? `${bytes / 1024}K` : text;
    }
    if (!RECORD_SIZES.includes(text)) {
        throw new ValidationError(`Invalid recordsize "${value}": one of ${RECORD_SIZES.join(", ")}`);
    }
    return text;
}

export function validateRecipe(raw : Record<string, unknown>, where : string) : VolumeRecipe {
    const recipe : VolumeRecipe = {};
    for (const [ key, value ] of Object.entries(raw)) {
        if (value === undefined || value === null || value === "") {
            continue;
        }
        switch (key) {
            case "recordsize":
                recipe.recordsize = normalizeRecordSize(value);
                break;
            case "compression": {
                const text = String(value).trim().toUpperCase();
                if (!COMPRESSION.test(text)) {
                    throw new ValidationError(`${where}: invalid compression "${value}"`);
                }
                recipe.compression = text;
                break;
            }
            case "atime": {
                const text = typeof value === "boolean" ? (value ? "ON" : "OFF") : String(value).trim().toUpperCase();
                if (text !== "ON" && text !== "OFF") {
                    throw new ValidationError(`${where}: atime must be on or off`);
                }
                recipe.atime = text;
                break;
            }
            case "quota": {
                const bytes = parseSize(value);
                if (bytes !== undefined && bytes !== 0 && bytes < 1024 ** 3) {
                    throw new ValidationError(`${where}: the quota must be at least 1G (TrueNAS limit)`);
                }
                recipe.quota = bytes || undefined;
                break;
            }
            case "owner": {
                const text = String(value).trim();
                if (!/^\d{1,10}(:\d{1,10})?$/.test(text)) {
                    throw new ValidationError(`${where}: owner must be "uid" or "uid:gid" (numbers)`);
                }
                recipe.owner = text;
                break;
            }
            case "mode": {
                const text = String(value).trim();
                if (!/^0?[0-7]{3,4}$/.test(text)) {
                    throw new ValidationError(`${where}: mode must be octal, e.g. "0750"`);
                }
                recipe.mode = text;
                break;
            }
            default:
                throw new ValidationError(`${where}: unknown property "${key}" (allowed: recordsize, compression, atime, quota, owner, mode)`);
        }
    }
    return recipe;
}

export interface RecipeParseResult {
    recipes : Map<string, VolumeRecipe>;
    errors : string[];
}

/**
 * Read x-dockge.zfs. Invalid entries are reported, not thrown: a typo must not hide the rest.
 */
export function parseRecipes(composeYAML : string) : RecipeParseResult {
    const result : RecipeParseResult = {
        recipes: new Map(),
        errors: [],
    };
    let config;
    try {
        config = yaml.parse(composeYAML);
    } catch (e) {
        return result;
    }
    const zfs = config?.["x-dockge"]?.zfs;
    if (!zfs || typeof zfs !== "object" || Array.isArray(zfs)) {
        return result;
    }
    for (const [ key, value ] of Object.entries(zfs)) {
        try {
            const path = normalizeVolumePath(key);
            if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
                throw new ValidationError(`x-dockge.zfs.${key} must be a map of properties`);
            }
            result.recipes.set(path, validateRecipe((value ?? {}) as Record<string, unknown>, `x-dockge.zfs.${key}`));
        } catch (e) {
            result.errors.push(e instanceof Error ? e.message : String(e));
        }
    }
    return result;
}

export function recipeToCreateOptions(recipe : VolumeRecipe | undefined, userProperties : Record<string, string>) : CreateDatasetOptions {
    return {
        recordsize: recipe?.recordsize,
        compression: recipe?.compression,
        atime: recipe?.atime,
        quota: recipe?.quota,
        userProperties,
    };
}

export interface PropertyDifference {
    property : string;
    /** On the dataset */
    actual : string;
    /** In x-dockge.zfs */
    expected : string;
}

/**
 * Differences between a dataset and its recipe (owner and mode are not ZFS properties: not compared here)
 */
export function compareRecipe(recipe : VolumeRecipe, dataset : DatasetInfo) : PropertyDifference[] {
    const differences : PropertyDifference[] = [];
    if (recipe.recordsize && dataset.rawProperties.recordsize) {
        let actual = dataset.properties.recordsize;
        try {
            actual = normalizeRecordSize(dataset.rawProperties.recordsize);
        } catch (e) {
            // keep the displayed value
        }
        if (actual !== recipe.recordsize) {
            differences.push({
                property: "recordsize",
                actual,
                expected: recipe.recordsize,
            });
        }
    }
    if (recipe.compression && dataset.properties.compression && dataset.properties.compression.toUpperCase() !== recipe.compression) {
        differences.push({
            property: "compression",
            actual: dataset.properties.compression.toUpperCase(),
            expected: recipe.compression,
        });
    }
    if (recipe.atime && dataset.properties.atime && dataset.properties.atime.toUpperCase() !== recipe.atime) {
        differences.push({
            property: "atime",
            actual: dataset.properties.atime.toUpperCase(),
            expected: recipe.atime,
        });
    }
    if (recipe.quota !== undefined) {
        const actual = Number(dataset.rawProperties.quota || 0);
        if (actual !== recipe.quota) {
            differences.push({
                property: "quota",
                actual: dataset.properties.quota || "none",
                expected: String(recipe.quota),
            });
        }
    }
    return differences;
}

/**
 * Properties to change on an existing dataset. quota: "none" or 0 removes it.
 */
export function parseDatasetProperties(raw : Record<string, unknown>) : { recordsize? : string, compression? : string, atime? : "ON" | "OFF", quota? : number } {
    const { quota, ...rest } = raw;
    const recipe = validateRecipe(rest, "properties");
    if (recipe.owner || recipe.mode) {
        throw new ValidationError("owner and mode are not dataset properties: use set_volume_permissions");
    }
    const result : { recordsize? : string, compression? : string, atime? : "ON" | "OFF", quota? : number } = {
        recordsize: recipe.recordsize,
        compression: recipe.compression,
        atime: recipe.atime,
    };
    if (quota !== undefined && quota !== null && quota !== "") {
        if (String(quota).trim().toLowerCase() === "none") {
            result.quota = 0;
        } else {
            const bytes = parseSize(quota) ?? 0;
            if (bytes !== 0 && bytes < 1024 ** 3) {
                throw new ValidationError("The quota must be at least 1G (TrueNAS limit), or none");
            }
            result.quota = bytes;
        }
    }
    return result;
}
