import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { credentialsFromEntry, getRegistryCredentials, normalizeRegistryHost, CredentialHelperRunner } from "./registry-auth";

const b64 = (value : string) => Buffer.from(value).toString("base64");

let dir : string;
let count = 0;

function writeConfig(config : unknown) : string {
    const file = path.join(dir, `config-${count++}.json`);
    fs.writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
    return file;
}

describe("normalizeRegistryHost", () => {
    it("keeps only the host name, like the docker CLI", () => {
        assert.equal(normalizeRegistryHost("ghcr.io"), "ghcr.io");
        assert.equal(normalizeRegistryHost("https://ghcr.io/"), "ghcr.io");
        assert.equal(normalizeRegistryHost("https://ghcr.io/v2/"), "ghcr.io");
        assert.equal(normalizeRegistryHost("ghcr.io/vidaniello"), "ghcr.io");
        assert.equal(normalizeRegistryHost("HTTP://Registry.Example.com:5000/v1/"), "registry.example.com:5000");
        assert.equal(normalizeRegistryHost(" https://index.docker.io/v1/ "), "index.docker.io");
    });
});

describe("credentialsFromEntry", () => {
    it("decodes auth", () => {
        assert.deepEqual(credentialsFromEntry({ auth: b64("user:pa:ss") }), { username: "user",
            password: "pa:ss" });
    });
    it("trims a trailing newline of the password", () => {
        assert.deepEqual(credentialsFromEntry({ auth: b64("user:token\n") }), { username: "user",
            password: "token" });
    });
    it("reads username and password", () => {
        assert.deepEqual(credentialsFromEntry({ username: "user",
            password: "secret" }), { username: "user",
            password: "secret" });
    });
    it("reads identitytoken and registrytoken", () => {
        assert.deepEqual(credentialsFromEntry({ identitytoken: "refresh" }), { identityToken: "refresh" });
        assert.deepEqual(credentialsFromEntry({ registrytoken: "bearer" }), { registryToken: "bearer" });
    });
    it("returns undefined without credentials", () => {
        assert.equal(credentialsFromEntry({}), undefined);
        assert.equal(credentialsFromEntry({ auth: "" }), undefined);
        assert.equal(credentialsFromEntry({ auth: b64("nocolon") }), undefined);
        assert.equal(credentialsFromEntry(null), undefined);
    });
});

describe("getRegistryCredentials", () => {
    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-registry-auth-"));
    });
    after(() => {
        fs.rmSync(dir, { recursive: true,
            force: true });
    });

    it("finds keys with scheme and trailing slash (docker login https://ghcr.io/)", async () => {
        const configPath = writeConfig({
            auths: {
                "https://gitlab-docker-registry.prod.dev/": { auth: b64("gitlab:one") },
                "https://ghcr.io/": { auth: b64("github:two") },
            },
        });
        const ghcr = await getRegistryCredentials("ghcr.io", { configPath });
        assert.deepEqual(ghcr.credentials, { username: "github",
            password: "two" });
        assert.match(ghcr.source ?? "", /auths\."https:\/\/ghcr\.io\/"/);
        const gitlab = await getRegistryCredentials("gitlab-docker-registry.prod.dev", { configPath });
        assert.deepEqual(gitlab.credentials, { username: "gitlab",
            password: "one" });
    });

    it("matches registries with a port and different case", async () => {
        const configPath = writeConfig({ auths: { "Registry.Example.com:5000": { username: "u",
            password: "p" } } });
        const result = await getRegistryCredentials("registry.example.com:5000", { configPath });
        assert.deepEqual(result.credentials, { username: "u",
            password: "p" });
        assert.equal((await getRegistryCredentials("registry.example.com", { configPath })).credentials, undefined);
    });

    it("finds Docker Hub under every name", async () => {
        for (const key of [ "https://index.docker.io/v1/", "index.docker.io", "docker.io", "registry-1.docker.io" ]) {
            const configPath = writeConfig({ auths: { [key]: { auth: b64("hub:secret") } } });
            const result = await getRegistryCredentials("docker.io", { configPath });
            assert.deepEqual(result.credentials, { username: "hub",
                password: "secret" }, key);
        }
    });

    it("prefers the exact host over another matching key", async () => {
        const configPath = writeConfig({
            auths: {
                "https://ghcr.io/v1/": { auth: b64("old:one") },
                "ghcr.io": { auth: b64("new:two") },
            },
        });
        const result = await getRegistryCredentials("ghcr.io", { configPath });
        assert.deepEqual(result.credentials, { username: "new",
            password: "two" });
    });

    it("skips entries without credentials", async () => {
        const configPath = writeConfig({
            auths: {
                "ghcr.io": {},
                "https://ghcr.io/": { identitytoken: "refresh" },
            },
        });
        const result = await getRegistryCredentials("ghcr.io", { configPath });
        assert.deepEqual(result.credentials, { identityToken: "refresh" });
    });

    it("uses credHelpers, then credsStore", async () => {
        const calls : string[] = [];
        const runHelper : CredentialHelperRunner = async (helper, serverURL) => {
            calls.push(`${helper} ${serverURL}`);
            if (helper === "ecr-login") {
                return { Username: "AWS",
                    Secret: "ecr-secret" };
            }
            if (helper === "pass" && serverURL === "https://index.docker.io/v1/") {
                return { Username: "<token>",
                    Secret: "refresh" };
            }
            return undefined;
        };
        const configPath = writeConfig({
            credsStore: "pass",
            credHelpers: { "123.dkr.ecr.eu-west-1.amazonaws.com": "ecr-login" },
            auths: { "https://ghcr.io/": { auth: b64("github:two") } },
        });

        const ecr = await getRegistryCredentials("123.dkr.ecr.eu-west-1.amazonaws.com", { configPath,
            runHelper });
        assert.deepEqual(ecr.credentials, { username: "AWS",
            password: "ecr-secret" });
        assert.equal(ecr.source, "docker-credential-ecr-login");

        const hub = await getRegistryCredentials("docker.io", { configPath,
            runHelper });
        assert.deepEqual(hub.credentials, { identityToken: "refresh" });

        // The store knows nothing about ghcr.io: auths is used
        const ghcr = await getRegistryCredentials("ghcr.io", { configPath,
            runHelper });
        assert.deepEqual(ghcr.credentials, { username: "github",
            password: "two" });
        assert.ok(calls.includes("pass ghcr.io"));
    });

    it("falls back to auths when the helper is missing, with a warning", async () => {
        const runHelper : CredentialHelperRunner = async (helper) => {
            throw new Error(`docker-credential-${helper} not found`);
        };
        const configPath = writeConfig({ credsStore: "desktop",
            auths: { "ghcr.io": { auth: b64("github:two") } } });
        const result = await getRegistryCredentials("ghcr.io", { configPath,
            runHelper });
        assert.deepEqual(result.credentials, { username: "github",
            password: "two" });
        assert.deepEqual(result.warnings, [ "docker-credential-desktop not found" ]);
    });

    it("rejects helper names that are not a plain name", async () => {
        let called = false;
        const runHelper : CredentialHelperRunner = async () => {
            called = true;
            return undefined;
        };
        const configPath = writeConfig({ credsStore: "../../bin/sh" });
        const result = await getRegistryCredentials("ghcr.io", { configPath,
            runHelper });
        assert.equal(called, false);
        assert.equal(result.credentials, undefined);
        assert.match(result.warnings[0], /Invalid credential helper/);
    });

    it("reports a missing or invalid config file", async () => {
        const missing = await getRegistryCredentials("ghcr.io", { configPath: path.join(dir, "missing.json") });
        assert.equal(missing.credentials, undefined);
        assert.deepEqual(missing.warnings, []);

        const invalid = await getRegistryCredentials("ghcr.io", { configPath: writeConfig("{ not json") });
        assert.equal(invalid.credentials, undefined);
        assert.match(invalid.warnings[0], /cannot be read/);
    });

    it("uses DOCKER_CONFIG and reads the file again every time", async () => {
        const configDir = fs.mkdtempSync(path.join(dir, "docker-config-"));
        const previous = process.env.DOCKER_CONFIG;
        process.env.DOCKER_CONFIG = configDir;
        try {
            assert.equal((await getRegistryCredentials("ghcr.io")).credentials, undefined);
            fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ auths: { "ghcr.io": { auth: b64("late:login") } } }));
            const result = await getRegistryCredentials("ghcr.io");
            assert.deepEqual(result.credentials, { username: "late",
                password: "login" });
            assert.equal(result.configPath, path.join(configDir, "config.json"));
        } finally {
            if (previous === undefined) {
                delete process.env.DOCKER_CONFIG;
            } else {
                process.env.DOCKER_CONFIG = previous;
            }
        }
    });
});
