import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { R } from "redbean-node";
import { ValidationError } from "../util-server";

/**
 * API keys look like "dk_<prefix>_<secret>". Only SHA-256(key) is stored, the full key is shown once.
 * Keys are long random strings, so a fast hash is enough (no need for bcrypt).
 */

export type ApiPermission = "read" | "write";

export interface ApiKeyInfo {
    id : number;
    name : string;
    prefix : string;
    permission : ApiPermission;
    active : boolean;
    createdAt : number;
    expiresAt : number | null;
    lastUsedAt : number | null;
    lastUsedIp : string | null;
}

function hashKey(key : string) : string {
    return createHash("sha256").update(key).digest("hex");
}

function toInfo(bean : Record<string, unknown>) : ApiKeyInfo {
    return {
        id: Number(bean.id),
        name: String(bean.name),
        prefix: String(bean.prefix),
        permission: bean.permission === "write" ? "write" : "read",
        active: !!bean.active,
        createdAt: Number(bean.created_at),
        expiresAt: bean.expires_at ? Number(bean.expires_at) : null,
        lastUsedAt: bean.last_used_at ? Number(bean.last_used_at) : null,
        lastUsedIp: (bean.last_used_ip as string) ?? null,
    };
}

export async function listApiKeys() : Promise<ApiKeyInfo[]> {
    const list = await R.getAll("SELECT * FROM api_key ORDER BY id DESC");
    return list.map(toInfo);
}

/**
 * @returns The key (to show once) and its info
 */
export async function createApiKey(name : string, permission : string, expiresInDays : number | null) : Promise<{ key : string, info : ApiKeyInfo }> {
    name = name.trim();
    if (!name || name.length > 100) {
        throw new ValidationError("The name is required (max 100 characters)");
    }
    if (permission !== "read" && permission !== "write") {
        throw new ValidationError("Permission must be read or write");
    }

    const prefix = randomBytes(6).toString("hex");
    const secret = randomBytes(24).toString("base64url");
    const key = `dk_${prefix}_${secret}`;

    const bean = R.dispense("api_key");
    bean.name = name;
    bean.prefix = prefix;
    bean.key_hash = hashKey(key);
    bean.permission = permission;
    bean.active = true;
    bean.created_at = Date.now();
    bean.expires_at = expiresInDays && expiresInDays > 0 ? Date.now() + expiresInDays * 24 * 3600 * 1000 : null;
    await R.store(bean);

    return {
        key,
        info: toInfo(bean as unknown as Record<string, unknown>),
    };
}

export async function deleteApiKey(id : number) {
    await R.exec("DELETE FROM api_key WHERE id = ?", [ id ]);
}

export async function setApiKeyActive(id : number, active : boolean) {
    await R.exec("UPDATE api_key SET active = ? WHERE id = ?", [ active ? 1 : 0, id ]);
}

/**
 * Check a key sent by a client
 * @returns The key info, or null if invalid / disabled / expired
 */
export async function verifyApiKey(key : string, ip : string) : Promise<ApiKeyInfo | null> {
    const match = /^dk_([0-9a-f]{12})_[A-Za-z0-9_-]{20,}$/.exec(key);
    if (!match) {
        return null;
    }

    const bean = await R.findOne("api_key", " prefix = ? ", [ match[1] ]);
    if (!bean) {
        return null;
    }

    const expected = Buffer.from(String(bean.key_hash), "hex");
    const actual = Buffer.from(hashKey(key), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return null;
    }

    const info = toInfo(bean as unknown as Record<string, unknown>);
    if (!info.active || (info.expiresAt && info.expiresAt < Date.now())) {
        return null;
    }

    // Do not write to the database on every request
    if (!info.lastUsedAt || Date.now() - info.lastUsedAt > 60 * 1000 || info.lastUsedIp !== ip) {
        await R.exec("UPDATE api_key SET last_used_at = ?, last_used_ip = ? WHERE id = ?", [ Date.now(), ip.slice(0, 64), info.id ]);
    }
    return info;
}
