import express, { NextFunction, Request, Response, Router as ExpressRouter } from "express";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { ValidationError } from "../util-server";
import { LooseObject } from "../../common/util-common";
import { ApiKeyInfo, verifyApiKey } from "./api-keys";
import { JSONSchema, Operation, operations } from "./operations";
import packageJSON from "../../package.json";

/**
 * External API of Dockge:
 *   /api/v1/...              REST endpoints
 *   /api/v1/openapi.json     OpenAPI 3.1 description (no key needed)
 *   /mcp                     Model Context Protocol endpoint (Streamable HTTP, JSON responses)
 *
 * Authentication: "Authorization: Bearer <key>" or "X-API-Key: <key>" (Settings > API keys).
 * Only HTTPS requests are accepted: Dockge's own TLS (DOCKGE_SSL_* / DOCKGE_API_SSL_*), or a reverse proxy
 * listed in DOCKGE_TRUST_PROXY that sends "X-Forwarded-Proto: https".
 * DOCKGE_API_ALLOW_HTTP=true disables this check (not recommended).
 */

const MCP_PROTOCOL_VERSIONS = [ "2025-06-18", "2025-03-26", "2024-11-05" ];

const MCP_INSTRUCTIONS = `Dockge manages Docker Compose stacks on this server.
- A stack is a folder <stacks dir>/<name> with compose.yaml (and .env). Names: lowercase letters, digits, - and _.
- Start with list_stacks / get_stack. Change files with create_stack or update_stack_files, then deploy_stack.
- Prefer absolute host paths for bind mounts (list_host_paths) and IP:HOST:CONTAINER to publish a port on one IP (list_host_ips).
- list_image_updates / check_image_updates tell which images have a newer version; update_stack pulls and recreates.
- delete_stack removes the stack folder: always ask the user before calling it.`;

// Failed authentications per IP, to slow down brute force
const failures = new Map<string, { count : number, until : number }>();

function clientIP(req : Request) : string {
    return req.ip ?? req.socket.remoteAddress ?? "";
}

function isAllowedHTTP() : boolean {
    return process.env.DOCKGE_API_ALLOW_HTTP === "true";
}

class HttpError extends Error {
    constructor(public status : number, message : string) {
        super(message);
    }
}

async function authenticate(req : Request) : Promise<ApiKeyInfo> {
    if (!req.secure && !isAllowedHTTP()) {
        throw new HttpError(403, "HTTPS is required. Serve Dockge over TLS (DOCKGE_SSL_KEY / DOCKGE_SSL_CERT) or behind a reverse proxy listed in DOCKGE_TRUST_PROXY.");
    }

    const ip = clientIP(req);
    const failure = failures.get(ip);
    if (failure && failure.count >= 10 && failure.until > Date.now()) {
        throw new HttpError(429, "Too many failed attempts, try again later");
    }

    let key = "";
    const authorization = req.headers.authorization;
    if (authorization && /^bearer\s+/i.test(authorization)) {
        key = authorization.replace(/^bearer\s+/i, "").trim();
    } else if (typeof(req.headers["x-api-key"]) === "string") {
        key = req.headers["x-api-key"].trim();
    }

    const info = key ? await verifyApiKey(key, ip) : null;
    if (!info) {
        const entry = failures.get(ip) ?? {
            count: 0,
            until: 0,
        };
        entry.count = entry.until < Date.now() ? 1 : entry.count + 1;
        entry.until = Date.now() + 60 * 1000;
        failures.set(ip, entry);
        throw new HttpError(401, "Missing or invalid API key");
    }
    failures.delete(ip);
    return info;
}

function checkPermission(op : Operation, key : ApiKeyInfo) {
    if (op.permission === "write" && key.permission !== "write") {
        throw new HttpError(403, `The API key "${key.name}" is read-only`);
    }
}

function errorStatus(e : unknown) : number {
    if (e instanceof HttpError) {
        return e.status;
    }
    if (e instanceof Error && /not found/i.test(e.message)) {
        return 404;
    }
    if (e instanceof ValidationError) {
        return 400;
    }
    return 500;
}

function errorMessage(e : unknown) : string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Convert query string values to the types declared in the schema
 */
function coerce(value : unknown, schema? : JSONSchema) : unknown {
    if (typeof(value) !== "string" || !schema) {
        return value;
    }
    if (schema.type === "integer" || schema.type === "number") {
        return value === "" ? undefined : Number(value);
    }
    if (schema.type === "boolean") {
        return value === "true" || value === "1";
    }
    return value;
}

function pathParams(path : string) : string[] {
    return [ ...path.matchAll(/:(\w+)/g) ].map((m) => m[1]);
}

async function runOperation(op : Operation, args : LooseObject, server : DockgeServer, key : ApiKeyInfo) : Promise<unknown> {
    checkPermission(op, key);
    for (const name of op.required ?? []) {
        if (args[name] === undefined || args[name] === null || args[name] === "") {
            throw new ValidationError(`Missing parameter: ${name}`);
        }
    }
    log.info("api", `${key.name} (${key.prefix}): ${op.id} ${JSON.stringify(args.name ?? "")}`);
    return op.handler(args, server);
}

export function buildOpenAPI(server : DockgeServer) : LooseObject {
    const paths : LooseObject = {};

    for (const op of operations) {
        const openapiPath = op.path.replace(/:(\w+)/g, "{$1}");
        const inPath = pathParams(op.path);
        const hasBody = op.method === "post" || op.method === "put";
        const parameters : LooseObject[] = [];
        const bodyProperties : Record<string, JSONSchema> = {};
        const bodyRequired : string[] = [];

        for (const [ name, schema ] of Object.entries(op.params)) {
            const required = (op.required ?? []).includes(name);
            if (inPath.includes(name)) {
                parameters.push({
                    name,
                    in: "path",
                    required: true,
                    schema,
                });
            } else if (hasBody) {
                bodyProperties[name] = schema;
                if (required) {
                    bodyRequired.push(name);
                }
            } else {
                parameters.push({
                    name,
                    in: "query",
                    required,
                    schema,
                });
            }
        }

        paths[openapiPath] ??= {};
        paths[openapiPath][op.method] = {
            operationId: op.id,
            summary: op.summary,
            ...(op.description ? { description: op.description } : {}),
            tags: [ op.tag ],
            "x-dockge-permission": op.permission,
            parameters,
            ...(hasBody && Object.keys(bodyProperties).length > 0 ? {
                requestBody: {
                    required: bodyRequired.length > 0,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: bodyProperties,
                                ...(bodyRequired.length ? { required: bodyRequired } : {}),
                            },
                        },
                    },
                },
            } : {}),
            responses: {
                "200": {
                    description: "OK",
                    content: {
                        "application/json": {
                            schema: {},
                        },
                    },
                },
                "400": { description: "Invalid parameters" },
                "401": { description: "Missing or invalid API key" },
                "403": { description: "Read-only key, or HTTPS required" },
                "404": { description: "Stack not found" },
            },
        };
    }

    return {
        openapi: "3.1.0",
        info: {
            title: "Dockge API",
            version: packageJSON.version,
            description: "Manage the Docker Compose stacks of this Dockge instance. Keys are created in Settings > API keys. "
                + "The same operations are available as MCP tools at /mcp.",
        },
        servers: [
            {
                url: "/api/v1",
            },
        ],
        security: [
            {
                bearerAuth: [],
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                },
                apiKeyHeader: {
                    type: "apiKey",
                    in: "header",
                    name: "X-API-Key",
                },
            },
        },
        paths,
        "x-stacks-dir": server.stacksDir,
    };
}

/**
 * MCP (JSON-RPC 2.0) message handler
 */
async function handleMcpMessage(message : LooseObject, server : DockgeServer, key : ApiKeyInfo) : Promise<LooseObject | null> {
    const id = message.id;
    const isNotification = id === undefined || id === null;

    const reply = (result : unknown) => ({
        jsonrpc: "2.0",
        id,
        result,
    });
    const fail = (code : number, msg : string) => ({
        jsonrpc: "2.0",
        id: id ?? null,
        error: {
            code,
            message: msg,
        },
    });

    if (message.jsonrpc !== "2.0" || typeof(message.method) !== "string") {
        return isNotification ? null : fail(-32600, "Invalid request");
    }

    switch (message.method) {
        case "initialize": {
            const requested = message.params?.protocolVersion;
            return reply({
                protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
                capabilities: {
                    tools: {
                        listChanged: false,
                    },
                },
                serverInfo: {
                    name: "dockge",
                    title: "Dockge",
                    version: packageJSON.version,
                },
                instructions: MCP_INSTRUCTIONS,
            });
        }

        case "ping":
            return isNotification ? null : reply({});

        case "tools/list":
            return reply({
                tools: operations
                    // A read-only key only sees the read-only tools
                    .filter((op) => op.permission === "read" || key.permission === "write")
                    .map((op) => ({
                        name: op.id,
                        description: op.summary + (op.description ? "\n" + op.description : ""),
                        inputSchema: {
                            type: "object",
                            properties: op.params,
                            ...(op.required?.length ? { required: op.required } : {}),
                        },
                        annotations: {
                            title: op.summary,
                            readOnlyHint: !!op.readOnly,
                            destructiveHint: !!op.destructive,
                            idempotentHint: !!op.readOnly,
                            openWorldHint: false,
                        },
                    })),
            });

        case "tools/call": {
            const name = message.params?.name;
            const op = operations.find((item) => item.id === name);
            if (!op) {
                return fail(-32602, `Unknown tool: ${name}`);
            }
            try {
                const result = await runOperation(op, message.params?.arguments ?? {}, server, key);
                const failed = !!(result && typeof(result) === "object" && (result as LooseObject).ok === false);
                return reply({
                    content: [
                        {
                            type: "text",
                            text: typeof(result) === "string" ? result : JSON.stringify(result, null, 2),
                        },
                    ],
                    isError: failed,
                });
            } catch (e) {
                // Tool errors are returned as results, so the model can read them
                return reply({
                    content: [
                        {
                            type: "text",
                            text: "Error: " + errorMessage(e),
                        },
                    ],
                    isError: true,
                });
            }
        }

        default:
            if (message.method.startsWith("notifications/") || isNotification) {
                return null;
            }
            return fail(-32601, `Method not found: ${message.method}`);
    }
}

export function createApiRouter(server : DockgeServer) : ExpressRouter {
    const router = express.Router();
    const json = express.json({ limit: "5mb" });

    // OpenAPI document, public: it describes the API, it does not give access to anything
    router.get("/api/v1/openapi.json", (_req, res) => {
        res.json(buildOpenAPI(server));
    });

    // REST endpoints
    for (const op of operations) {
        router[op.method]("/api/v1" + op.path, json, async (req : Request, res : Response) => {
            try {
                const key = await authenticate(req);
                const args : LooseObject = {};
                for (const [ name, value ] of Object.entries(req.query)) {
                    args[name] = coerce(value, op.params[name]);
                }
                if (req.body && typeof(req.body) === "object" && !Array.isArray(req.body)) {
                    Object.assign(args, req.body);
                }
                Object.assign(args, req.params);
                res.json(await runOperation(op, args, server, key));
            } catch (e) {
                res.status(errorStatus(e)).json({
                    ok: false,
                    error: errorMessage(e),
                });
            }
        });
    }

    // Unknown API paths: JSON 404 instead of the web UI
    router.all("/api/*", (_req, res) => {
        res.status(404).json({
            ok: false,
            error: "Unknown API endpoint, see /api/v1/openapi.json",
        });
    });

    // MCP endpoint (Streamable HTTP transport, without server-sent events)
    router.post("/mcp", json, async (req : Request, res : Response) => {
        let key : ApiKeyInfo;
        try {
            key = await authenticate(req);
        } catch (e) {
            res.status(errorStatus(e)).json({
                jsonrpc: "2.0",
                id: null,
                error: {
                    code: -32001,
                    message: errorMessage(e),
                },
            });
            return;
        }

        const body = req.body;
        const messages = Array.isArray(body) ? body : [ body ];
        const responses : LooseObject[] = [];
        for (const message of messages) {
            if (!message || typeof(message) !== "object") {
                continue;
            }
            const response = await handleMcpMessage(message, server, key);
            if (response) {
                responses.push(response);
            }
        }

        if (responses.length === 0) {
            res.status(202).end();
        } else {
            res.json(Array.isArray(body) ? responses : responses[0]);
        }
    });

    router.all("/mcp", (_req, res) => {
        res.status(405).set("Allow", "POST").json({
            jsonrpc: "2.0",
            id: null,
            error: {
                code: -32000,
                message: "Use POST (this server does not open server-sent event streams)",
            },
        });
    });

    // Invalid JSON
    router.use((err : Error & { type? : string }, _req : Request, res : Response, next : NextFunction) => {
        if (err.type === "entity.parse.failed") {
            res.status(400).json({
                ok: false,
                error: "Invalid JSON body",
            });
            return;
        }
        next(err);
    });

    return router;
}
