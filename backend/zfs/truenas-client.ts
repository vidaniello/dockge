import crypto from "crypto";
import tls from "tls";
import WebSocket from "ws";
import { ValidationError } from "../util-server";

/**
 * Minimal client of the TrueNAS SCALE API: JSON-RPC 2.0 over WebSocket (25.04 and later: wss://<host>/api/current).
 *
 * Security rules:
 * - Only wss:// is accepted. TrueNAS revokes an API key that is sent over a connection it does not consider secure
 *   (plain ws:// from another IP), and the key would travel in clear text.
 * - The certificate must be valid for a public CA, or match the SHA-256 fingerprint the user trusted (TrueNAS uses a
 *   self-signed certificate by default). The key is sent only after the certificate was checked.
 * - One connection per operation: connect, log in, run the calls, close.
 */

export interface TrueNasConnection {
    url : string;
    username : string;
    apiKey : string;
    /** SHA-256 fingerprint of the certificate trusted by the user, "AB:CD:..." (empty: verify with the system CAs) */
    fingerprint : string;
}

export class TrueNasError extends Error {
    constructor(message : string, public code? : string, public data? : unknown) {
        super(message);
    }
}

/** The certificate is not trusted: the user can trust this fingerprint */
export class TrueNasCertificateError extends TrueNasError {
    constructor(message : string, public fingerprint : string, public subject : string) {
        super(message, "certificate");
    }
}

const CONNECT_TIMEOUT_MS = 15 * 1000;
const CALL_TIMEOUT_MS = 60 * 1000;

export function normalizeTrueNasUrl(value : string) : string {
    let url : URL;
    try {
        url = new URL(value.trim());
    } catch (e) {
        throw new ValidationError("Invalid TrueNAS URL");
    }
    if (url.protocol === "https:") {
        url.protocol = "wss:";
    }
    if (url.protocol !== "wss:") {
        throw new ValidationError("The TrueNAS URL must start with wss:// (or https://): TrueNAS revokes an API key sent over an unencrypted connection");
    }
    if (url.pathname === "/" || url.pathname === "") {
        url.pathname = "/api/current";
    }
    url.hash = "";
    return url.toString();
}

function fingerprintOf(socket : tls.TLSSocket) : { fingerprint : string, subject : string } {
    const certificate = socket.getPeerCertificate();
    return {
        fingerprint: certificate?.fingerprint256 ?? "",
        subject: certificate?.subject ? Object.entries(certificate.subject).map(([ key, value ]) => `${key}=${value}`).join(", ") : "",
    };
}

function sameFingerprint(a : string, b : string) : boolean {
    const clean = (value : string) => value.replace(/[^0-9a-f]/gi, "").toUpperCase();
    const left = Buffer.from(clean(a));
    const right = Buffer.from(clean(b));
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export class TrueNasClient {
    private socket? : WebSocket;
    private nextId = 1;
    private pending = new Map<number, { resolve : (value : unknown) => void, reject : (error : Error) => void, timer : NodeJS.Timeout }>();

    constructor(private connection : TrueNasConnection) {
    }

    /**
     * Read the certificate of the server without sending anything (to show the fingerprint to trust)
     */
    static async probeCertificate(url : string) : Promise<{ fingerprint : string, subject : string, trustedByCA : boolean }> {
        const target = new URL(normalizeTrueNasUrl(url));
        return new Promise((resolve, reject) => {
            const socket = tls.connect({
                host: target.hostname,
                port: Number(target.port) || 443,
                servername: /^[\d.:]+$/.test(target.hostname) ? undefined : target.hostname,
                rejectUnauthorized: false,
                timeout: CONNECT_TIMEOUT_MS,
            }, () => {
                const info = fingerprintOf(socket);
                resolve({
                    ...info,
                    trustedByCA: socket.authorized,
                });
                socket.end();
            });
            socket.on("timeout", () => socket.destroy(new Error("Connection timeout")));
            socket.on("error", (e) => reject(new TrueNasError(`Cannot connect to ${target.host}: ${e.message}`)));
        });
    }

    async connect() : Promise<void> {
        const url = normalizeTrueNasUrl(this.connection.url);
        const pinned = this.connection.fingerprint;

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            // While the certificate is read for the error message, "close" must not settle with a generic error
            let probing = false;
            const fail = (error : Error) => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
                socket.terminate();
            };

            const socket = new WebSocket(url, {
                // With a pinned fingerprint the CA check is replaced by the fingerprint check below
                rejectUnauthorized: !pinned,
                handshakeTimeout: CONNECT_TIMEOUT_MS,
                maxPayload: 64 * 1024 * 1024,
            });
            this.socket = socket;

            // Before the WebSocket is open, nothing has been sent but the HTTP upgrade request
            socket.on("upgrade", (response) => {
                const tlsSocket = response.socket as tls.TLSSocket;
                if (pinned) {
                    const { fingerprint, subject } = fingerprintOf(tlsSocket);
                    if (!sameFingerprint(fingerprint, pinned)) {
                        fail(new TrueNasCertificateError("The certificate of TrueNAS changed: it does not match the trusted fingerprint", fingerprint, subject));
                    }
                }
            });

            socket.on("open", () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            });

            socket.on("message", (data) => this.onMessage(data.toString()));

            socket.on("error", (error : Error & { code? : string }) => {
                const certificateCodes = [ "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ];
                if (error.code && certificateCodes.includes(error.code)) {
                    probing = true;
                    TrueNasClient.probeCertificate(url).then((info) => {
                        fail(new TrueNasCertificateError(`The certificate of TrueNAS is not trusted (${error.code})`, info.fingerprint, info.subject));
                    }, () => fail(new TrueNasError(error.message, "certificate")));
                    return;
                }
                fail(new TrueNasError(`Cannot connect to TrueNAS: ${error.message}`));
            });

            socket.on("close", () => {
                for (const [ id, call ] of this.pending) {
                    clearTimeout(call.timer);
                    call.reject(new TrueNasError("Connection to TrueNAS closed"));
                    this.pending.delete(id);
                }
                if (!probing) {
                    fail(new TrueNasError("Connection to TrueNAS closed"));
                }
            });
        });

        const result = await this.call<{ response_type : string }>("auth.login_ex", [{
            mechanism: "API_KEY_PLAIN",
            username: this.connection.username,
            api_key: this.connection.apiKey,
            login_options: {
                user_info: false,
            },
        }]);
        if (result?.response_type !== "SUCCESS") {
            this.close();
            if (result?.response_type === "EXPIRED") {
                throw new TrueNasError("TrueNAS refused the API key: it is expired or was revoked", "auth");
            }
            throw new TrueNasError(`TrueNAS refused the login (${result?.response_type ?? "no response"}): check the user name and the API key`, "auth");
        }
    }

    private onMessage(text : string) {
        let message;
        try {
            message = JSON.parse(text);
        } catch (e) {
            return;
        }
        if (typeof message?.id !== "number") {
            // Notifications (events) are not used
            return;
        }
        const call = this.pending.get(message.id);
        if (!call) {
            return;
        }
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) {
            const data = message.error.data;
            const reason = data?.reason ?? data?.error ?? message.error.message ?? "TrueNAS error";
            const extra = Array.isArray(data?.extra) ? data.extra.map((item : unknown[]) => item.slice(0, 2).join(": ")).join("; ") : "";
            call.reject(new TrueNasError(extra ? `${reason} (${extra})` : String(reason), data?.errname, data));
        } else {
            call.resolve(message.result);
        }
    }

    call<T = unknown>(method : string, params : unknown[] = []) : Promise<T> {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new TrueNasError("Not connected to TrueNAS"));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new TrueNasError(`TrueNAS did not answer ${method} in time`));
            }, CALL_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: resolve as (value : unknown) => void,
                reject,
                timer,
            });
            socket.send(JSON.stringify({
                jsonrpc: "2.0",
                id,
                method,
                params,
            }));
        });
    }

    close() {
        this.socket?.close();
        this.socket = undefined;
    }

    /**
     * Connect, run, close
     */
    static async with<T>(connection : TrueNasConnection, run : (client : TrueNasClient) => Promise<T>) : Promise<T> {
        const client = new TrueNasClient(connection);
        await client.connect();
        try {
            return await run(client);
        } finally {
            client.close();
        }
    }
}
