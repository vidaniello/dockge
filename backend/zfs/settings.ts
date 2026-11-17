import { Settings } from "../settings";
import { ValidationError } from "../util-server";
import { normalizeTrueNasUrl } from "./truenas-client";

/**
 * ZFS settings of this Dockge instance (each agent has its own: they are different hosts).
 * The API key of TrueNAS is never sent back to a client: only whether it is set.
 */

export type MissingVolumesRule = "ask" | "dataset" | "directory";

export interface ZfsSettings {
    truenasUrl : string;
    truenasUsername : string;
    truenasApiKey : string;
    /** SHA-256 fingerprint of the trusted TrueNAS certificate, empty = verify with the system CAs */
    truenasFingerprint : string;
    /** Default of "create as dataset" for new stacks */
    newStacksAsDatasets : boolean;
    /** What to do with the missing ./xxx bind mounts before a deploy */
    missingVolumes : MissingVolumesRule;
    /** Recursive snapshot of the stack before "Update" recreates the containers */
    autoSnapshotBeforeUpdate : boolean;
    /** How many dockge-auto-* snapshots to keep per stack */
    autoSnapshotKeep : number;
    /** Rollback and deletion of snapshots through the external API (REST / MCP) */
    destructiveApi : boolean;
}

export type PublicZfsSettings = Omit<ZfsSettings, "truenasApiKey"> & { truenasApiKeySet : boolean };

const KEY = "zfs";

const DEFAULTS : ZfsSettings = {
    truenasUrl: "",
    truenasUsername: "",
    truenasApiKey: "",
    truenasFingerprint: "",
    newStacksAsDatasets: true,
    missingVolumes: "ask",
    autoSnapshotBeforeUpdate: true,
    autoSnapshotKeep: 5,
    destructiveApi: false,
};

export async function getZfsSettings() : Promise<ZfsSettings> {
    let stored : Partial<ZfsSettings> = {};
    try {
        const value = await Settings.get(KEY);
        if (value && typeof value === "object") {
            stored = value;
        }
    } catch (e) {
        // Not stored yet
    }
    return {
        ...DEFAULTS,
        ...stored,
    };
}

export function toPublic(settings : ZfsSettings) : PublicZfsSettings {
    const { truenasApiKey, ...rest } = settings;
    return {
        ...rest,
        truenasApiKeySet: truenasApiKey !== "",
    };
}

export function isTrueNasConfigured(settings : ZfsSettings) : boolean {
    return settings.truenasUrl !== "" && settings.truenasUsername !== "" && settings.truenasApiKey !== "";
}

/**
 * Change some settings.
 * truenasApiKey: a string replaces the key, "" (or absent) keeps it, null removes it.
 * Changing the URL forgets the trusted fingerprint (unless a new one is given).
 */
export async function updateZfsSettings(changes : Record<string, unknown>) : Promise<ZfsSettings> {
    const current = await getZfsSettings();
    const next : ZfsSettings = { ...current };

    if (typeof changes.truenasUrl === "string") {
        next.truenasUrl = changes.truenasUrl.trim() ? normalizeTrueNasUrl(changes.truenasUrl) : "";
        if (next.truenasUrl !== current.truenasUrl) {
            next.truenasFingerprint = "";
        }
    }
    if (typeof changes.truenasUsername === "string") {
        const username = changes.truenasUsername.trim();
        if (username && !/^[A-Za-z0-9_.@-][A-Za-z0-9_.@$-]{0,63}$/.test(username)) {
            throw new ValidationError("Invalid TrueNAS user name");
        }
        next.truenasUsername = username;
    }
    if (changes.truenasApiKey === null) {
        next.truenasApiKey = "";
    } else if (typeof changes.truenasApiKey === "string" && changes.truenasApiKey.trim()) {
        next.truenasApiKey = changes.truenasApiKey.trim();
    }
    if (typeof changes.truenasFingerprint === "string") {
        const fingerprint = changes.truenasFingerprint.trim().toUpperCase();
        if (fingerprint && !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) {
            throw new ValidationError("Invalid certificate fingerprint");
        }
        next.truenasFingerprint = fingerprint;
    }
    if (typeof changes.newStacksAsDatasets === "boolean") {
        next.newStacksAsDatasets = changes.newStacksAsDatasets;
    }
    if (typeof changes.missingVolumes === "string") {
        if (![ "ask", "dataset", "directory" ].includes(changes.missingVolumes)) {
            throw new ValidationError("missingVolumes must be ask, dataset or directory");
        }
        next.missingVolumes = changes.missingVolumes as MissingVolumesRule;
    }

    if (typeof changes.autoSnapshotBeforeUpdate === "boolean") {
        next.autoSnapshotBeforeUpdate = changes.autoSnapshotBeforeUpdate;
    }
    if (changes.autoSnapshotKeep !== undefined) {
        const keep = Number(changes.autoSnapshotKeep);
        if (!Number.isInteger(keep) || keep < 1 || keep > 100) {
            throw new ValidationError("autoSnapshotKeep must be between 1 and 100");
        }
        next.autoSnapshotKeep = keep;
    }
    if (typeof changes.destructiveApi === "boolean") {
        next.destructiveApi = changes.destructiveApi;
    }

    await Settings.set(KEY, next as unknown as object);
    return next;
}
