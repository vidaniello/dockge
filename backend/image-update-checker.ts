import fs from "fs";
import os from "os";
import path from "path";
import childProcessAsync from "promisify-child-process";
import { log } from "./log";
import { Settings } from "./settings";
import { Stack } from "./stack";
import { DockgeServer } from "./dockge-server";
import { LooseObject } from "../common/util-common";

/**
 * Checks whether newer versions of the images used by the stacks are available, without pulling anything.
 *
 * For every service, the digest of the image the container is running is compared with the digest the
 * registry currently serves for the same tag (an HTTP HEAD request on the manifest, which Docker Hub
 * does not count in its pull rate limit).
 *
 * Statuses:
 *   ok        up to date
 *   update    a newer image is available on the registry
 *   recreate  the newer image is already pulled but the container still runs the old one
 *   local     image built locally / not from a registry, cannot be checked
 *   pinned    image referenced by digest (image@sha256:...), never changes
 *   error     the registry could not be queried (see "error")
 */

export type ImageUpdateStatus = "ok" | "update" | "recreate" | "local" | "pinned" | "error";

export interface ServiceUpdateInfo {
    image : string;
    status : ImageUpdateStatus;
    error? : string;
}

export interface StackUpdateInfo {
    checkedAt : number;
    updates : number;
    services : Record<string, ServiceUpdateInfo>;
}

interface ImageRef {
    registry : string;
    repository : string;
    tag : string;
    digest? : string;
}

const CACHE_SETTING_KEY = "imageUpdateCache";
const LAST_CHECK_SETTING_KEY = "imageUpdateLastCheck";
export const INTERVAL_SETTING_KEY = "imageUpdateInterval";
export const DEFAULT_INTERVAL_HOURS = 12;
const REQUEST_TIMEOUT_MS = 20 * 1000;
const PARALLEL_REQUESTS = 4;

const MANIFEST_ACCEPT = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
].join(", ");

/**
 * "nginx" => docker.io/library/nginx:latest, "ghcr.io/a/b:1@sha256:..." => ...
 */
export function parseImageRef(ref : string) : ImageRef {
    let digest : string | undefined;
    let nameTag = ref.trim();

    const at = nameTag.indexOf("@");
    if (at >= 0) {
        digest = nameTag.slice(at + 1);
        nameTag = nameTag.slice(0, at);
    }

    let name = nameTag;
    let tag = "latest";
    const lastSlash = nameTag.lastIndexOf("/");
    const lastColon = nameTag.lastIndexOf(":");
    if (lastColon > lastSlash) {
        name = nameTag.slice(0, lastColon);
        tag = nameTag.slice(lastColon + 1);
    }

    let registry = "docker.io";
    let repository = name;
    const first = name.split("/")[0];
    if (name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) {
        registry = first;
        repository = name.slice(first.length + 1);
    }

    if (registry === "index.docker.io" || registry === "registry-1.docker.io") {
        registry = "docker.io";
    }

    if (registry === "docker.io" && !repository.includes("/")) {
        repository = "library/" + repository;
    }

    return {
        registry,
        repository,
        tag,
        digest,
    };
}

function registryHost(registry : string) : string {
    return registry === "docker.io" ? "registry-1.docker.io" : registry;
}

/**
 * Basic credentials of a registry from the docker config file (docker login), if any
 */
function getRegistryAuth(registry : string) : string | undefined {
    try {
        const dir = process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");
        const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8"));
        const auths = config.auths ?? {};
        const candidates = registry === "docker.io"
            ? [ "https://index.docker.io/v1/", "index.docker.io", "docker.io", "registry-1.docker.io" ]
            : [ registry, "https://" + registry, "https://" + registry + "/v1/", "https://" + registry + "/v2/" ];
        for (const key of candidates) {
            if (auths[key]?.auth) {
                return auths[key].auth;
            }
        }
    } catch (e) {
        // No docker config
    }
    return undefined;
}

async function fetchWithTimeout(url : string, init : RequestInit) : Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Get a bearer token from the "WWW-Authenticate: Bearer realm=...,service=...,scope=..." challenge
 */
async function getBearerToken(challenge : string, basicAuth? : string) : Promise<string | undefined> {
    const params : LooseObject = {};
    for (const match of challenge.matchAll(/(\w+)="([^"]*)"/g)) {
        params[match[1]] = match[2];
    }
    if (!params.realm) {
        return undefined;
    }

    const url = new URL(params.realm);
    if (params.service) {
        url.searchParams.set("service", params.service);
    }
    if (params.scope) {
        url.searchParams.set("scope", params.scope);
    }

    const headers : Record<string, string> = {};
    if (basicAuth) {
        headers.Authorization = "Basic " + basicAuth;
    }

    const res = await fetchWithTimeout(url.toString(), { headers });
    if (!res.ok) {
        throw new Error(`Registry authentication failed (HTTP ${res.status})`);
    }
    const body = await res.json();
    return body.token ?? body.access_token;
}

/**
 * Digest currently published by the registry for image:tag
 */
export async function getRemoteDigest(ref : ImageRef) : Promise<string> {
    const url = `https://${registryHost(ref.registry)}/v2/${ref.repository}/manifests/${ref.tag}`;
    const basicAuth = getRegistryAuth(ref.registry);
    const headers : Record<string, string> = {
        Accept: MANIFEST_ACCEPT,
    };

    let res = await fetchWithTimeout(url, {
        method: "HEAD",
        headers,
    });

    if (res.status === 401) {
        const challenge = res.headers.get("www-authenticate") ?? "";
        if (/^bearer/i.test(challenge)) {
            const token = await getBearerToken(challenge, basicAuth);
            if (token) {
                headers.Authorization = "Bearer " + token;
            }
        } else if (basicAuth) {
            headers.Authorization = "Basic " + basicAuth;
        }
        res = await fetchWithTimeout(url, {
            method: "HEAD",
            headers,
        });
    }

    if (res.status === 404) {
        throw new Error("Tag not found on the registry");
    }
    if (res.status === 429) {
        throw new Error("Registry rate limit reached, try later");
    }
    if (!res.ok) {
        throw new Error(`Registry error (HTTP ${res.status})`);
    }

    const digest = res.headers.get("docker-content-digest");
    if (!digest) {
        throw new Error("The registry did not return a digest");
    }
    return digest;
}

async function dockerJSON(args : string[], cwd? : string) : Promise<string> {
    const res = await childProcessAsync.spawn("docker", args, {
        cwd,
        encoding: "utf-8",
    });
    return res.stdout?.toString() ?? "";
}

/**
 * Digests (sha256:...) under which the image is known locally
 * @param imageIdOrRef Image ID or reference
 */
async function getLocalDigests(imageIdOrRef : string) : Promise<string[]> {
    try {
        const out = await dockerJSON([ "image", "inspect", "--format", "{{json .RepoDigests}}", imageIdOrRef ]);
        const list = JSON.parse(out.trim() || "[]") as string[] | null;
        return (list ?? []).map((item) => item.slice(item.indexOf("@") + 1));
    } catch (e) {
        return [];
    }
}

function describeError(e : unknown) : string {
    if (!(e instanceof Error)) {
        return String(e);
    }
    if (e.name === "AbortError") {
        return "Registry timeout";
    }
    // fetch() hides the real reason (DNS, TLS, connection refused...) in "cause"
    const cause = (e as Error & { cause? : { message? : string, code? : string } }).cause;
    if (e.message === "fetch failed" && cause) {
        return "Cannot reach the registry: " + (cause.code ?? cause.message ?? "unknown error");
    }
    return e.message;
}

class ImageUpdateChecker {
    protected server? : DockgeServer;
    protected results : Record<string, StackUpdateInfo> = {};
    protected running = false;
    protected interval? : NodeJS.Timeout;

    async init(server : DockgeServer) {
        this.server = server;

        try {
            const cached = await Settings.get(CACHE_SETTING_KEY);
            if (cached && typeof cached === "object") {
                this.results = cached;
            }
        } catch (e) {
            // ignore
        }

        // Check every 10 minutes whether a scheduled check is due
        this.interval = setInterval(() => this.runIfDue(), 10 * 60 * 1000);
        setTimeout(() => this.runIfDue(), 60 * 1000);
    }

    get(stackName : string) : StackUpdateInfo | undefined {
        return this.results[stackName];
    }

    get isRunning() {
        return this.running;
    }

    async runIfDue() {
        try {
            let hours = await Settings.get(INTERVAL_SETTING_KEY);
            if (hours === undefined || hours === null || hours === "") {
                hours = DEFAULT_INTERVAL_HOURS;
            }
            hours = Number(hours);
            if (!hours || hours <= 0) {
                return;
            }
            const last = Number(await Settings.get(LAST_CHECK_SETTING_KEY)) || 0;
            if (Date.now() - last >= hours * 3600 * 1000) {
                await this.checkAll();
            }
        } catch (e) {
            log.warn("image-update", "Scheduled check failed: " + (e instanceof Error ? e.message : e));
        }
    }

    /**
     * Check every stack managed by Dockge
     */
    async checkAll() : Promise<Record<string, StackUpdateInfo>> {
        if (!this.server) {
            throw new Error("Not initialized");
        }
        const stackList = await Stack.getStackList(this.server, true);
        const stacks = [ ...stackList.values() ].filter((stack) => stack.isManagedByDockge);
        await this.check(stacks);

        // Forget stacks that do not exist anymore
        for (const name of Object.keys(this.results)) {
            if (!stackList.has(name)) {
                delete this.results[name];
            }
        }

        await Settings.set(LAST_CHECK_SETTING_KEY, Date.now(), "imageUpdates");
        await this.save();
        return this.results;
    }

    /**
     * Check one stack
     */
    async checkStack(stackName : string) : Promise<StackUpdateInfo | undefined> {
        if (!this.server) {
            throw new Error("Not initialized");
        }
        const stack = await Stack.getStack(this.server, stackName);
        await this.check([ stack ]);
        await this.save();
        return this.results[stackName];
    }

    protected async save() {
        await Settings.set(CACHE_SETTING_KEY, this.results, "imageUpdates");
        this.server?.sendStackList(true);
    }

    protected async check(stacks : Stack[]) {
        if (this.running) {
            throw new Error("A check is already running, please wait");
        }
        this.running = true;
        const remoteCache = new Map<string, Promise<string>>();

        try {
            log.info("image-update", `Checking ${stacks.length} stack(s) for image updates`);

            // Limit the number of parallel registry requests
            const queue = [ ...stacks ];
            const workers = Array.from({ length: Math.min(PARALLEL_REQUESTS, queue.length) }, async () => {
                while (queue.length > 0) {
                    const stack = queue.shift() as Stack;
                    try {
                        this.results[stack.name] = await this.checkOne(stack, remoteCache);
                    } catch (e) {
                        log.warn("image-update", `${stack.name}: ${e instanceof Error ? e.message : e}`);
                    }
                }
            });
            await Promise.all(workers);
        } finally {
            this.running = false;
        }
    }

    protected async checkOne(stack : Stack, remoteCache : Map<string, Promise<string>>) : Promise<StackUpdateInfo> {
        const info : StackUpdateInfo = {
            checkedAt: Date.now(),
            updates: 0,
            services: {},
        };

        // Resolved configuration (variables from .env / global.env substituted)
        const configOut = await dockerJSON(stack.getComposeOptions("config", "--format", "json"), stack.path);
        const config = JSON.parse(configOut || "{}");

        if (config["x-dockge"]?.checkUpdates === false) {
            return info;
        }

        // Image ID of the running container of each service
        const containerImage = new Map<string, string>();
        try {
            const psOut = await dockerJSON(stack.getComposeOptions("ps", "--all", "--format", "json"), stack.path);
            const containers : LooseObject[] = [];
            for (const line of psOut.split("\n")) {
                if (!line.trim()) {
                    continue;
                }
                const parsed = JSON.parse(line);
                Array.isArray(parsed) ? containers.push(...parsed) : containers.push(parsed);
            }
            if (containers.length > 0) {
                const inspectOut = await dockerJSON([ "inspect", "--format", "{{.Name}} {{.Image}}", ...containers.map((c) => c.Name) ]);
                const imageByName = new Map(inspectOut.trim().split("\n").map((line) => {
                    const [ name, image ] = line.trim().split(" ");
                    return [ name.replace(/^\//, ""), image ];
                }));
                for (const container of containers) {
                    const image = imageByName.get(container.Name);
                    if (image && !containerImage.has(container.Service)) {
                        containerImage.set(container.Service, image);
                    }
                }
            }
        } catch (e) {
            // No containers
        }

        for (const [ serviceName, service ] of Object.entries(config.services ?? {}) as [string, LooseObject][]) {
            const image = service.image as string | undefined;
            if (!image) {
                info.services[serviceName] = {
                    image: "(build)",
                    status: "local",
                };
                continue;
            }

            const ref = parseImageRef(image);
            if (ref.digest) {
                info.services[serviceName] = {
                    image,
                    status: "pinned",
                };
                continue;
            }

            const runningImage = containerImage.get(serviceName);
            const runningDigests = await getLocalDigests(runningImage ?? image);
            if (runningDigests.length === 0) {
                // Built locally, or never pulled
                info.services[serviceName] = {
                    image,
                    status: "local",
                    error: service.build ? "Built locally" : "Not pulled yet",
                };
                continue;
            }

            const key = `${ref.registry}/${ref.repository}:${ref.tag}`;
            if (!remoteCache.has(key)) {
                remoteCache.set(key, getRemoteDigest(ref));
            }

            try {
                const remoteDigest = await (remoteCache.get(key) as Promise<string>);
                let status : ImageUpdateStatus = "ok";

                if (!runningDigests.includes(remoteDigest)) {
                    // The new image may already be pulled (docker compose pull) but the container not recreated
                    const tagDigests = runningImage ? await getLocalDigests(image) : runningDigests;
                    status = tagDigests.includes(remoteDigest) ? "recreate" : "update";
                }

                info.services[serviceName] = {
                    image,
                    status,
                };
                if (status !== "ok") {
                    info.updates++;
                }
            } catch (e) {
                info.services[serviceName] = {
                    image,
                    status: "error",
                    error: describeError(e),
                };
            }
        }

        return info;
    }
}

export const imageUpdateChecker = new ImageUpdateChecker();
