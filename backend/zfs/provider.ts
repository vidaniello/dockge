import { TrueNasClient, TrueNasConnection } from "./truenas-client";
import { isTrueNasConfigured, ZfsSettings } from "./settings";

/**
 * How Dockge creates and reads datasets. `zfs create` run inside the Dockge container would mount the dataset in the
 * container only, so the work is done by the host: for now only through the TrueNAS API (docs/ZFS-DESIGN.md §3).
 */

/** Properties Dockge reads and compares with x-dockge.zfs */
export const READ_PROPERTIES = [ "recordsize", "compression", "atime", "quota", "acltype", "aclmode", "used", "available", "mountpoint" ];

export interface DatasetInfo {
    name : string;
    mountpoint : string | null;
    /** Displayed value (e.g. recordsize "128K") */
    properties : Record<string, string>;
    /** Raw value (e.g. recordsize "131072") */
    rawProperties : Record<string, string>;
    /** Where the value comes from: LOCAL, INHERITED, DEFAULT... */
    sources : Record<string, string>;
    userProperties : Record<string, string>;
}

export interface CreateDatasetOptions {
    recordsize? : string;
    compression? : string;
    atime? : "ON" | "OFF";
    /** Bytes */
    quota? : number;
    userProperties : Record<string, string>;
}

export interface ZfsProvider {
    readonly name : "truenas";
    /** Who the provider logs in as (to show it in the settings) */
    whoAmI() : Promise<string>;
    /** A dataset and, with children, all its descendants */
    getDatasets(name : string, children : boolean) : Promise<DatasetInfo[]>;
    createDataset(name : string, options : CreateDatasetOptions) : Promise<void>;
    /** Change properties of an existing dataset (quota 0 = no quota) */
    updateDataset(name : string, properties : DatasetProperties) : Promise<void>;
    /** Content of a folder of the host, and the datasets mounted in it (for the path picker) */
    listHostDirectory(dirPath : string, showFiles : boolean) : Promise<{ entries : HostEntry[], datasets : Map<string, string> }>;
}

export interface HostEntry {
    name : string;
    path : string;
    isDirectory : boolean;
}

export interface DatasetProperties {
    recordsize? : string;
    compression? : string;
    atime? : "ON" | "OFF";
    /** Bytes, 0 = none */
    quota? : number;
}

type RawProperty = { value? : unknown, rawvalue? : unknown, source? : unknown } | string | null | undefined;

function flatten(list : unknown[], result : Record<string, unknown>[] = []) : Record<string, unknown>[] {
    for (const item of list) {
        if (item && typeof item === "object") {
            const dataset = item as Record<string, unknown>;
            result.push(dataset);
            if (Array.isArray(dataset.children)) {
                flatten(dataset.children, result);
            }
        }
    }
    return result;
}

function toInfo(dataset : Record<string, unknown>) : DatasetInfo {
    const info : DatasetInfo = {
        name: String(dataset.name ?? dataset.id ?? ""),
        mountpoint: typeof dataset.mountpoint === "string" ? dataset.mountpoint : null,
        properties: {},
        rawProperties: {},
        sources: {},
        userProperties: {},
    };
    for (const property of READ_PROPERTIES) {
        if (property === "mountpoint") {
            continue;
        }
        const value = dataset[property] as RawProperty;
        if (value === undefined || value === null) {
            continue;
        }
        if (typeof value === "object") {
            info.properties[property] = String(value.value ?? "");
            info.rawProperties[property] = String(value.rawvalue ?? value.value ?? "");
            info.sources[property] = String(value.source ?? "");
        } else {
            info.properties[property] = String(value);
            info.rawProperties[property] = String(value);
        }
    }
    const userProperties = dataset.user_properties;
    if (userProperties && typeof userProperties === "object") {
        for (const [ key, value ] of Object.entries(userProperties as Record<string, RawProperty>)) {
            info.userProperties[key] = value && typeof value === "object" ? String(value.value ?? "") : String(value ?? "");
        }
    }
    return info;
}

export class TrueNasProvider implements ZfsProvider {
    readonly name = "truenas";

    constructor(private connection : TrueNasConnection) {
    }

    async whoAmI() : Promise<string> {
        return TrueNasClient.with(this.connection, async (client) => {
            const me = await client.call<{ pw_name? : string }>("auth.me");
            return me?.pw_name ?? this.connection.username;
        });
    }

    async getDatasets(name : string, children : boolean) : Promise<DatasetInfo[]> {
        return TrueNasClient.with(this.connection, async (client) => {
            const result = await client.call<unknown[]>("pool.dataset.query", [
                [[ "id", "=", name ]],
                {
                    extra: {
                        retrieve_children: children,
                        properties: READ_PROPERTIES,
                        retrieve_user_props: true,
                    },
                },
            ]);
            return flatten(Array.isArray(result) ? result : []).map(toInfo);
        });
    }

    async createDataset(name : string, options : CreateDatasetOptions) : Promise<void> {
        const payload : Record<string, unknown> = {
            name,
            type: "FILESYSTEM",
            // GENERIC: ACL type and mode are inherited from the parent (configure pool/stacks once)
            share_type: "GENERIC",
            user_properties: Object.entries(options.userProperties).map(([ key, value ]) => ({
                key,
                value,
            })),
        };
        if (options.recordsize) {
            payload.recordsize = options.recordsize;
        }
        if (options.compression) {
            payload.compression = options.compression;
        }
        if (options.atime) {
            payload.atime = options.atime;
        }
        if (options.quota) {
            payload.quota = options.quota;
        }
        await TrueNasClient.with(this.connection, (client) => client.call("pool.dataset.create", [ payload ]));
    }

    async listHostDirectory(dirPath : string, showFiles : boolean) : Promise<{ entries : HostEntry[], datasets : Map<string, string> }> {
        return TrueNasClient.with(this.connection, async (client) => {
            const list = await client.call<{ name : string, path : string, type : string }[]>("filesystem.listdir", [
                dirPath,
                showFiles ? [[ "type", "in", [ "DIRECTORY", "FILE" ]]] : [[ "type", "=", "DIRECTORY" ]],
                {
                    order_by: [ "name" ],
                    limit: 2000,
                },
            ]);
            const datasets = new Map<string, string>();
            const all = await client.call<unknown[]>("pool.dataset.query", [
                [],
                {
                    extra: {
                        retrieve_children: false,
                        properties: [ "mountpoint" ],
                        retrieve_user_props: false,
                    },
                },
            ]);
            for (const dataset of flatten(Array.isArray(all) ? all : [])) {
                if (typeof dataset.mountpoint === "string" && dataset.mountpoint) {
                    datasets.set(dataset.mountpoint, String(dataset.name ?? dataset.id));
                }
            }
            return {
                entries: (Array.isArray(list) ? list : []).map((entry) => ({
                    name: entry.name,
                    path: entry.path,
                    isDirectory: entry.type === "DIRECTORY",
                })),
                datasets,
            };
        });
    }

    async updateDataset(name : string, properties : DatasetProperties) : Promise<void> {
        const payload : Record<string, unknown> = {};
        for (const key of [ "recordsize", "compression", "atime", "quota" ] as const) {
            if (properties[key] !== undefined) {
                payload[key] = properties[key];
            }
        }
        if (Object.keys(payload).length === 0) {
            return;
        }
        await TrueNasClient.with(this.connection, (client) => client.call("pool.dataset.update", [ name, payload ]));
    }
}

export function getProvider(settings : ZfsSettings) : ZfsProvider | null {
    if (!isTrueNasConfigured(settings)) {
        return null;
    }
    return new TrueNasProvider({
        url: settings.truenasUrl,
        username: settings.truenasUsername,
        apiKey: settings.truenasApiKey,
        fingerprint: settings.truenasFingerprint,
    });
}
