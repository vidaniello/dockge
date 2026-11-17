import { Settings } from "../settings";
import { ValidationError } from "../util-server";
import { log } from "../log";

/**
 * Public address of the API, when it is reached through a reverse proxy with another name and port than the ones
 * Dockge sees (e.g. https://dockge-api.example.com in front of the API port 5002). Only used to show the right
 * addresses (REST, OpenAPI, MCP) in Settings -> API keys: the server accepts any Host.
 *
 * DOCKGE_API_PUBLIC_URL, when set, wins over the value saved in the settings.
 */

const KEY = "apiPublicUrl";

export function normalizePublicUrl(value : string) : string {
    const text = value.trim();
    if (!text) {
        return "";
    }
    let url : URL;
    try {
        url = new URL(text);
    } catch (e) {
        throw new ValidationError("Invalid address: write it as https://name[:port][/path]");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && process.env.DOCKGE_API_ALLOW_HTTP === "true")) {
        throw new ValidationError("The public address of the API must start with https:// (http:// only with DOCKGE_API_ALLOW_HTTP=true)");
    }
    if (url.search || url.hash || url.username || url.password) {
        throw new ValidationError("The address must not contain ?query, #fragment or credentials");
    }
    const pathname = url.pathname.replace(/\/+$/, "");
    if (/\/(api\/v1|api|mcp)$/i.test(pathname)) {
        throw new ValidationError("Write the base address only: /api/v1 and /mcp are added by Dockge");
    }
    return `${url.protocol}//${url.host}${pathname}`;
}

export async function getApiPublicUrl() : Promise<{ url : string | null, fromEnv : boolean }> {
    const env = process.env.DOCKGE_API_PUBLIC_URL;
    if (env && env.trim()) {
        try {
            return {
                url: normalizePublicUrl(env),
                fromEnv: true,
            };
        } catch (e) {
            log.warn("api", `DOCKGE_API_PUBLIC_URL is invalid and ignored: ${e instanceof Error ? e.message : e}`);
            return {
                url: null,
                fromEnv: true,
            };
        }
    }
    let stored : unknown;
    try {
        stored = await Settings.get(KEY);
    } catch (e) {
        stored = null;
    }
    return {
        url: typeof stored === "string" && stored ? stored : null,
        fromEnv: false,
    };
}

export async function setApiPublicUrl(value : unknown) : Promise<string | null> {
    if (process.env.DOCKGE_API_PUBLIC_URL && process.env.DOCKGE_API_PUBLIC_URL.trim()) {
        throw new ValidationError("The public address is set by DOCKGE_API_PUBLIC_URL: change it there");
    }
    if (value !== null && typeof value !== "string") {
        throw new ValidationError("Invalid address");
    }
    const url = value ? normalizePublicUrl(value) : "";
    await Settings.set(KEY, url);
    return url || null;
}
