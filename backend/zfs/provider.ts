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
    /** Mount point → dataset name, for all the datasets of the host */
    listMountpoints() : Promise<Map<string, string>>;
    /** Shares, tasks, apps... that use a dataset ([{ type, service, attachments }]) */
    getAttachments(name : string) : Promise<{ type : string, attachments : string[] }[]>;
    /** Rename a dataset (its children follow; with an inherited mountpoint it is mounted at the new path) */
    renameDataset(name : string, newName : string) : Promise<void>;
    /** Set or change user properties (key with ":") */
    setUserProperties(name : string, properties : Record<string, string>) : Promise<void>;
    /** Destroy a dataset; recursive: with its children (and the snapshots of all of them) */
    deleteDataset(name : string, recursive : boolean) : Promise<void>;
    /** Snapshots of these datasets */
    listSnapshots(datasets : string[]) : Promise<SnapshotInfo[]>;
    /** Recursive: the same snapshot of every child dataset, at the same instant */
    createSnapshot(dataset : string, name : string, recursive : boolean) : Promise<void>;
    deleteSnapshot(id : string, recursive : boolean) : Promise<void>;
    /** Roll back the dataset and its children that have this snapshot; newer snapshots are destroyed */
    rollbackSnapshot(id : string) : Promise<void>;
    /** New dataset from a snapshot (depends on it until promoted) */
    cloneSnapshot(id : string, target : string, userProperties : Record<string, string>) : Promise<void>;
}

export interface SnapshotInfo {
    /** dataset@name */
    id : string;
    dataset : string;
    name : string;
    /** Milliseconds since epoch, null if unknown */
    created : number | null;
    /** Bytes held only by this snapshot */
    used : number | null;
    referenced : number | null;
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

    async listMountpoints() : Promise<Map<string, string>> {
        return TrueNasClient.with(this.connection, async (client) => {
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
            const result = new Map<string, string>();
            for (const dataset of flatten(Array.isArray(all) ? all : [])) {
                if (typeof dataset.mountpoint === "string" && dataset.mountpoint) {
                    result.set(dataset.mountpoint, String(dataset.name ?? dataset.id));
                }
            }
            return result;
        });
    }

    async getAttachments(name : string) : Promise<{ type : string, attachments : string[] }[]> {
        return TrueNasClient.with(this.connection, async (client) => {
            const list = await client.call<{ type? : string, service? : string, attachments? : unknown[] }[]>("pool.dataset.attachments", [ name ]);
            return (Array.isArray(list) ? list : []).map((item) => ({
                type: String(item.type ?? item.service ?? "?"),
                attachments: (item.attachments ?? []).map(String),
            }));
        });
    }

    async renameDataset(name : string, newName : string) : Promise<void> {
        // TrueNAS 25.04 has no pool.dataset.rename: zfs.dataset.rename has no role, only a full administrator can call it
        await TrueNasClient.with(this.connection, (client) => client.call("zfs.dataset.rename", [ name, {
            new_name: newName,
        }]));
    }

    async setUserProperties(name : string, properties : Record<string, string>) : Promise<void> {
        await TrueNasClient.with(this.connection, (client) => client.call("pool.dataset.update", [ name, {
            user_properties_update: Object.entries(properties).map(([ key, value ]) => ({
                key,
                value,
            })),
        }]));
    }

    async deleteDataset(name : string, recursive : boolean) : Promise<void> {
        await TrueNasClient.with(this.connection, (client) => client.call("pool.dataset.delete", [ name, {
            recursive,
        }]));
    }

    async listSnapshots(datasets : string[]) : Promise<SnapshotInfo[]> {
        if (datasets.length === 0) {
            return [];
        }
        return TrueNasClient.with(this.connection, async (client) => {
            const list = await client.call<Record<string, unknown>[]>("zfs.snapshot.query", [
                [[ "dataset", "in", datasets ]],
                {
                    extra: {
                        properties: [ "creation", "used", "referenced" ],
                        holds: false,
                    },
                },
            ]);
            const number = (value : unknown) => {
                const raw = value && typeof value === "object" ? (value as { rawvalue? : unknown }).rawvalue : value;
                const parsed = Number(raw);
                return Number.isFinite(parsed) ? parsed : null;
            };
            return (Array.isArray(list) ? list : []).map((snapshot) => {
                const id = String(snapshot.id ?? snapshot.name ?? "");
                const properties = (snapshot.properties ?? {}) as Record<string, unknown>;
                const creation = number(properties.creation);
                return {
                    id,
                    dataset: String(snapshot.dataset ?? id.split("@")[0]),
                    name: String(snapshot.snapshot_name ?? id.split("@")[1] ?? ""),
                    created: creation === null ? null : creation * 1000,
                    used: number(properties.used),
                    referenced: number(properties.referenced),
                };
            });
        });
    }

    async createSnapshot(dataset : string, name : string, recursive : boolean) : Promise<void> {
        await TrueNasClient.with(this.connection, (client) => client.call("zfs.snapshot.create", [{
            dataset,
            name,
            recursive,
        }]));
    }

    async deleteSnapshot(id : string, recursive : boolean) : Promise<void> {
        await TrueNasClient.with(this.connection, (client) => client.call("zfs.snapshot.delete", [ id, {
            recursive,
        }]));
    }

    async rollbackSnapshot(id : string) : Promise<void> {
        await TrueNasClient.with(this.connection, (client) => client.call("zfs.snapshot.rollback", [ id, {
            // zfs rollback -r: destroy the newer snapshots (needed when it is not the latest)
            recursive: true,
            // the same snapshot of every child dataset
            recursive_rollback: true,
        }]));
    }

    async cloneSnapshot(id : string, target : string, userProperties : Record<string, string>) : Promise<void> {
        await TrueNasClient.with(this.connection, (client) => client.call("zfs.snapshot.clone", [{
            snapshot: id,
            dataset_dst: target,
            dataset_properties: userProperties,
        }]));
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
