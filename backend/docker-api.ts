import http from "http";
import { LooseObject } from "../common/util-common";

/**
 * Minimal read-only client of the Docker Engine API (through the socket), used instead of the docker CLI
 * for a few reads.
 *
 * Why: the docker CLI 29 parses some fields strictly. On a daemon where a network was created with a gateway
 * written with its prefix length (e.g. "fd86:dd34:ddc5:d::1/64", seen on TrueNAS SCALE), "docker network ls"
 * and "docker inspect" fail with: ParseAddr("...::1/64"): unexpected character. Reading the JSON ourselves
 * avoids that.
 *
 * Supports DOCKER_HOST=unix://... (default /var/run/docker.sock) and tcp:// without TLS. Anything else throws,
 * and callers fall back to the CLI.
 */

interface Target {
    socketPath? : string;
    host? : string;
    port? : number;
}

function getTarget() : Target {
    const dockerHost = process.env.DOCKER_HOST;
    if (!dockerHost) {
        if (process.platform === "win32") {
            throw new Error("Docker API over named pipe is not supported");
        }
        return {
            socketPath: "/var/run/docker.sock",
        };
    }
    if (dockerHost.startsWith("unix://")) {
        return {
            socketPath: dockerHost.slice("unix://".length),
        };
    }
    if (dockerHost.startsWith("tcp://") && process.env.DOCKER_TLS_VERIFY !== "1" && !process.env.DOCKER_CERT_PATH) {
        const url = new URL(dockerHost.replace(/^tcp:/, "http:"));
        return {
            host: url.hostname,
            port: Number(url.port) || 2375,
        };
    }
    throw new Error("Unsupported DOCKER_HOST for the Docker API client");
}

/**
 * GET a Docker Engine API path, e.g. "/networks"
 * @param path API path (without version prefix: the daemon uses its own version)
 * @returns Parsed JSON
 */
export function dockerApiGet<T = LooseObject>(path : string) : Promise<T> {
    return new Promise((resolve, reject) => {
        let target : Target;
        try {
            target = getTarget();
        } catch (e) {
            reject(e);
            return;
        }

        const request = http.request({
            ...target,
            path,
            method: "GET",
            headers: {
                Accept: "application/json",
            },
            timeout: 15 * 1000,
        }, (response) => {
            const chunks : Buffer[] = [];
            response.on("data", (chunk : Buffer) => chunks.push(chunk));
            response.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf-8");
                if (!response.statusCode || response.statusCode >= 400) {
                    let message = body;
                    try {
                        message = JSON.parse(body).message ?? body;
                    } catch (e) {
                        // not JSON
                    }
                    reject(new Error(`Docker API ${path}: HTTP ${response.statusCode} ${message}`.trim()));
                    return;
                }
                try {
                    resolve(JSON.parse(body) as T);
                } catch (e) {
                    reject(new Error(`Docker API ${path}: invalid JSON`));
                }
            });
        });
        request.on("timeout", () => request.destroy(new Error(`Docker API ${path}: timeout`)));
        request.on("error", reject);
        request.end();
    });
}

/**
 * Image or container references may contain "/" and ":" (ghcr.io/a/b:1), which the API accepts as is.
 * Only escape what would break the URL.
 * @param name Name or ID
 */
export function apiName(name : string) : string {
    return name.replace(/[?#%\s]/g, (char) => encodeURIComponent(char));
}
