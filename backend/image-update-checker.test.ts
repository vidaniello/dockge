import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { getRemoteDigest, isConnectionError, parseImageRef } from "./image-update-checker";
import { registryAuthHeader } from "./registry-auth";

/** Decode X-Registry-Auth like the daemon (URL-safe base64 with padding) */
function decodeAuthHeader(value : string) : Record<string, string> {
    return JSON.parse(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
}

/** A local port with nothing listening on it */
async function closedPort() : Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

describe("registryAuthHeader", () => {
    it("encodes credentials like the docker CLI", () => {
        assert.deepEqual(decodeAuthHeader(registryAuthHeader({ username: "u",
            password: "p" }, "ghcr.io")), { serveraddress: "ghcr.io",
            username: "u",
            password: "p" });
        assert.deepEqual(decodeAuthHeader(registryAuthHeader({ identityToken: "t" }, "docker.io")), { serveraddress: "https://index.docker.io/v1/",
            identitytoken: "t" });
        assert.deepEqual(decodeAuthHeader(registryAuthHeader(undefined, "https://registry.local:5000/")), { serveraddress: "registry.local:5000" });
    });

    it("is URL-safe base64 with padding", () => {
        const value = registryAuthHeader({ username: "??>>",
            password: "~~~" }, "a.b");
        assert.match(value, /^[A-Za-z0-9_-]+=*$/);
        assert.equal(value.length % 4, 0);
    });
});

describe("isConnectionError", () => {
    it("is true only when no HTTP answer came back", () => {
        assert.equal(isConnectionError(new TypeError("fetch failed")), true);
        const abort = new Error("aborted");
        abort.name = "AbortError";
        assert.equal(isConnectionError(abort), true);
        assert.equal(isConnectionError(new Error("Registry error (HTTP 500)")), false);
        assert.equal(isConnectionError(new Error("Tag not found on the registry")), false);
    });
});

describe("getRemoteDigest through the Docker daemon", () => {
    let dir : string;
    let daemon : http.Server;
    let requests : { url : string, auth? : Record<string, string> }[] = [];
    let daemonAnswer : (url : string) => { status : number, body : unknown } = () => ({ status: 500,
        body: {} });
    const previous = {
        DOCKER_HOST: process.env.DOCKER_HOST,
        DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    };

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-daemon-"));
        const socketPath = path.join(dir, "docker.sock");
        daemon = http.createServer((req, res) => {
            const header = req.headers["x-registry-auth"];
            requests.push({
                url: req.url ?? "",
                auth: typeof header === "string" ? decodeAuthHeader(header) : undefined,
            });
            const answer = daemonAnswer(req.url ?? "");
            res.writeHead(answer.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(answer.body));
        });
        await new Promise<void>((resolve) => daemon.listen(socketPath, resolve));
        process.env.DOCKER_HOST = "unix://" + socketPath;
        process.env.DOCKER_CONFIG = dir;
    });

    after(async () => {
        await new Promise<void>((resolve) => daemon.close(() => resolve()));
        fs.rmSync(dir, { recursive: true,
            force: true });
        for (const [ key, value ] of Object.entries(previous)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    it("asks the daemon, with the credentials, when the registry cannot be reached directly", async () => {
        const port = await closedPort();
        const registry = `127.0.0.1:${port}`;
        fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ auths: { [`https://${registry}/`]: { auth: Buffer.from("ci:secret").toString("base64") } } }));
        requests = [];
        daemonAnswer = () => ({ status: 200,
            body: { Descriptor: { mediaType: "application/vnd.oci.image.index.v1+json",
                digest: "sha256:abc",
                size: 1 },
            Platforms: [] } });

        const digest = await getRemoteDigest(parseImageRef(`${registry}/team/app:1.2`));
        assert.equal(digest, "sha256:abc");
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, `/distribution/${registry}/team/app:1.2/json`);
        assert.deepEqual(requests[0].auth, { serveraddress: registry,
            username: "ci",
            password: "secret" });
    });

    it("reports both errors when the daemon fails too", async () => {
        const port = await closedPort();
        fs.writeFileSync(path.join(dir, "config.json"), "{}");
        daemonAnswer = () => ({ status: 401,
            body: { message: "Head \"https://registry/v2/team/app/manifests/1\": unauthorized" } });

        await assert.rejects(getRemoteDigest(parseImageRef(`127.0.0.1:${port}/team/app:1`)), (e : Error) => {
            assert.match(e.message, /^Cannot reach the registry: ECONNREFUSED; through the Docker daemon: HTTP 401 Head/);
            assert.match(e.message, /no credentials for 127\.0\.0\.1:\d+ in /);
            return true;
        });
    });

    it("reports a daemon answer without digest", async () => {
        const port = await closedPort();
        daemonAnswer = () => ({ status: 200,
            body: {} });
        await assert.rejects(getRemoteDigest(parseImageRef(`127.0.0.1:${port}/team/app:1`)), /did not return a digest/);
    });
});
