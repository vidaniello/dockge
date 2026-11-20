import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

/**
 * Registry credentials from the docker config file (docker login), read the way the docker CLI reads them:
 *
 * - $DOCKER_CONFIG/config.json, otherwise ~/.docker/config.json, read again every time (a "docker login"
 *   done after Dockge started works at once);
 * - the keys of "auths" are compared by host name only, like the CLI does: "https://ghcr.io/", "ghcr.io",
 *   "https://ghcr.io/v2/" and "ghcr.io/user" all match ghcr.io (the CLI strips the scheme and the path);
 * - an entry can hold "auth" (base64 of user:password), "username" + "password", "identitytoken" (OAuth
 *   refresh token) or "registrytoken" (bearer token);
 * - "credHelpers" (per registry) and "credsStore" (default) name a credential helper,
 *   docker-credential-<name>; if it is missing or knows nothing, "auths" is used.
 */

export interface RegistryCredentials {
    username? : string;
    password? : string;
    /** OAuth refresh token (docker login with a token based registry) */
    identityToken? : string;
    /** Bearer token, sent as is */
    registryToken? : string;
}

export interface RegistryAuthResult {
    credentials? : RegistryCredentials;
    /** Config file that was read */
    configPath : string;
    /** Where the credentials come from (for messages and logs, never the values) */
    source? : string;
    /** Problems met while looking (helper not found, invalid entry...) */
    warnings : string[];
}

export type CredentialHelperRunner = (helper : string, serverURL : string) => Promise<{ Username? : string, Secret? : string } | undefined>;

const DOCKER_HUB_HOSTS = [ "docker.io", "index.docker.io", "registry-1.docker.io" ];
const DOCKER_HUB_SERVER_URL = "https://index.docker.io/v1/";
const HELPER_TIMEOUT_MS = 10 * 1000;

export function dockerConfigPath() : string {
    const dir = process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");
    return path.join(dir, "config.json");
}

/**
 * Host name of a registry or of a key of "auths": "https://ghcr.io/" => "ghcr.io", "HTTPS://Index.Docker.io/v1/" => "index.docker.io"
 */
export function normalizeRegistryHost(value : string) : string {
    let host = value.trim().toLowerCase();
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    const slash = host.indexOf("/");
    if (slash >= 0) {
        host = host.slice(0, slash);
    }
    return host;
}

function isDockerHub(host : string) : boolean {
    return DOCKER_HUB_HOSTS.includes(host);
}

function sameRegistry(a : string, b : string) : boolean {
    const hostA = normalizeRegistryHost(a);
    const hostB = normalizeRegistryHost(b);
    return hostA === hostB || (isDockerHub(hostA) && isDockerHub(hostB));
}

/**
 * Credentials of one entry of "auths", or undefined if it has none
 */
export function credentialsFromEntry(entry : unknown) : RegistryCredentials | undefined {
    if (!entry || typeof entry !== "object") {
        return undefined;
    }
    const value = entry as Record<string, unknown>;
    const result : RegistryCredentials = {};

    if (typeof value.auth === "string" && value.auth) {
        const decoded = Buffer.from(value.auth, "base64").toString("utf-8");
        const colon = decoded.indexOf(":");
        if (colon > 0) {
            result.username = decoded.slice(0, colon);
            // Docker trims the password the same way (a trailing newline from "echo | base64")
            result.password = decoded.slice(colon + 1).replace(/[\r\n]+$/, "");
        }
    }
    if (!result.username && typeof value.username === "string" && value.username && typeof value.password === "string") {
        result.username = value.username;
        result.password = value.password;
    }
    if (typeof value.identitytoken === "string" && value.identitytoken) {
        result.identityToken = value.identitytoken;
    }
    if (typeof value.registrytoken === "string" && value.registrytoken) {
        result.registryToken = value.registrytoken;
    }

    return result.username || result.identityToken || result.registryToken ? result : undefined;
}

/**
 * Run docker-credential-<helper> get
 */
export const runCredentialHelper : CredentialHelperRunner = (helper, serverURL) => {
    return new Promise((resolve, reject) => {
        const child = spawn("docker-credential-" + helper, [ "get" ], {
            stdio: [ "pipe", "pipe", "pipe" ],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`docker-credential-${helper} did not answer`));
        }, HELPER_TIMEOUT_MS);

        child.stdout.on("data", (data) => stdout += data);
        child.stderr.on("data", (data) => stderr += data);
        child.on("error", (e : NodeJS.ErrnoException) => {
            clearTimeout(timer);
            reject(e.code === "ENOENT" ? new Error(`docker-credential-${helper} not found`) : e);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                // "credentials not found in native keychain": nothing stored for this registry
                if (/not found/i.test(stdout + stderr)) {
                    resolve(undefined);
                } else {
                    reject(new Error(`docker-credential-${helper} failed (exit code ${code})`));
                }
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(new Error(`docker-credential-${helper} returned an invalid answer`));
            }
        });
        child.stdin.end(serverURL);
    });
};

/**
 * Credentials of a registry
 * @param registry Registry host ("docker.io" for Docker Hub, "ghcr.io", "registry.example.com:5000"...)
 * @param options configPath and helper runner (tests)
 */
export async function getRegistryCredentials(registry : string, options : { configPath? : string, runHelper? : CredentialHelperRunner } = {}) : Promise<RegistryAuthResult> {
    const configPath = options.configPath ?? dockerConfigPath();
    const runHelper = options.runHelper ?? runCredentialHelper;
    const warnings : string[] = [];

    let config : Record<string, unknown>;
    try {
        config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            warnings.push(`${configPath} cannot be read: ${e instanceof Error ? e.message : e}`);
        }
        return {
            configPath,
            warnings,
        };
    }
    if (!config || typeof config !== "object") {
        return {
            configPath,
            warnings: [ `${configPath} is not a JSON object` ],
        };
    }

    const host = normalizeRegistryHost(registry);

    // 1. Credential helper: credHelpers for this registry, otherwise credsStore
    const credHelpers = (config.credHelpers && typeof config.credHelpers === "object" ? config.credHelpers : {}) as Record<string, unknown>;
    let helper : string | undefined;
    for (const [ key, value ] of Object.entries(credHelpers)) {
        if (typeof value === "string" && value && sameRegistry(key, host)) {
            helper = value;
            break;
        }
    }
    if (!helper && typeof config.credsStore === "string" && config.credsStore) {
        helper = config.credsStore;
    }
    if (helper) {
        if (!/^[A-Za-z0-9_.-]+$/.test(helper)) {
            warnings.push(`Invalid credential helper name "${helper}" in ${configPath}`);
        } else {
            // The CLI stores Docker Hub as https://index.docker.io/v1/ and the other registries by host name
            const serverURLs = isDockerHub(host) ? [ DOCKER_HUB_SERVER_URL, "index.docker.io", "docker.io" ] : [ host, "https://" + host ];
            try {
                for (const serverURL of serverURLs) {
                    const answer = await runHelper(helper, serverURL);
                    if (answer && answer.Secret) {
                        const credentials : RegistryCredentials = answer.Username === "<token>" || !answer.Username
                            ? { identityToken: answer.Secret }
                            : { username: answer.Username,
                                password: answer.Secret };
                        return {
                            credentials,
                            configPath,
                            source: `docker-credential-${helper}`,
                            warnings,
                        };
                    }
                }
            } catch (e) {
                warnings.push(e instanceof Error ? e.message : String(e));
            }
        }
    }

    // 2. "auths": a key written exactly as the host first (like the CLI), then the other matching keys
    const auths = (config.auths && typeof config.auths === "object" ? config.auths : {}) as Record<string, unknown>;
    const exact = (key : string) => Number(key.trim().toLowerCase() === host);
    const matches = Object.keys(auths)
        .filter((key) => sameRegistry(key, host))
        .sort((a, b) => exact(b) - exact(a));
    for (const key of matches) {
        const credentials = credentialsFromEntry(auths[key]);
        if (credentials) {
            return {
                credentials,
                configPath,
                source: `${configPath} (auths."${key}")`,
                warnings,
            };
        }
    }
    if (matches.length > 0 && !helper) {
        warnings.push(`The entry of ${host} in ${configPath} has no credentials`);
    }

    return {
        configPath,
        warnings,
    };
}

/**
 * Value of the X-Registry-Auth header of the Docker Engine API: JSON in URL-safe base64 with padding
 * (what the daemon decodes, like the docker CLI sends it)
 * @param credentials Credentials (undefined: anonymous)
 * @param registry Registry host ("docker.io" for Docker Hub)
 */
export function registryAuthHeader(credentials : RegistryCredentials | undefined, registry : string) : string {
    const host = normalizeRegistryHost(registry);
    const value : Record<string, string> = {
        serveraddress: isDockerHub(host) ? DOCKER_HUB_SERVER_URL : host,
    };
    if (credentials?.identityToken) {
        value.identitytoken = credentials.identityToken;
    } else if (credentials?.registryToken) {
        value.registrytoken = credentials.registryToken;
    } else if (credentials?.username) {
        value.username = credentials.username;
        value.password = credentials.password ?? "";
    }
    return Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}
