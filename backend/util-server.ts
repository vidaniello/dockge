import { Socket } from "socket.io";
import { Terminal } from "./terminal";
import { randomBytes } from "crypto";
import { log } from "./log";
import { ERROR_TYPE_VALIDATION } from "../common/util-common";
import { R } from "redbean-node";
import { verifyPassword } from "./password-hash";
import fs from "fs";
import { AgentManager } from "./agent-manager";

export interface JWTDecoded {
    username : string;
    h? : string;
}

export interface DockgeSocket extends Socket {
    userID: number;
    consoleTerminal? : Terminal;
    instanceManager : AgentManager;
    endpoint : string;
    emitAgent : (eventName : string, ...args : unknown[]) => void;
}

// For command line arguments, so they are nullable
export interface Arguments {
    sslKey? : string;
    sslCert? : string;
    sslKeyPassphrase? : string;
    port? : number;
    hostname? : string;
    dataDir? : string;
    stacksDir? : string;
    enableConsole? : boolean;
}

// Some config values are required
export interface Config extends Arguments {
    dataDir : string;
    stacksDir : string;
}

export function checkLogin(socket : DockgeSocket) {
    if (!socket.userID) {
        throw new Error("You are not logged in.");
    }
}

export class ValidationError extends Error {
    constructor(message : string) {
        super(message);
    }
}

/**
 * Readable message of an error. For a failed command (promisify-child-process), the message is only
 * "Process exited with code 1": add the end of what the command wrote on stderr, which says why.
 * @param error Error
 */
export function errorMessage(error : unknown) : string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    let message = error.message;
    const stderr = (error as Error & { stderr? : unknown }).stderr;
    if (stderr) {
        const text = stderr.toString().trim();
        if (text) {
            message += ": " + text.split("\n").slice(-3).join(" ").slice(0, 500);
        }
    }
    return message;
}

export function callbackError(error : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }

    // ValidationError extends Error, so it must be checked first
    if (error instanceof ValidationError) {
        callback({
            ok: false,
            type: ERROR_TYPE_VALIDATION,
            msg: error.message,
            msgi18n: true,
        });
    } else if (error instanceof Error) {
        const message = errorMessage(error);
        if (message !== error.message) {
            log.warn("console", message);
        }
        callback({
            ok: false,
            msg: message,
            // Command output is not a translation key (and "{{ }}" would break vue-i18n)
            msgi18n: message === error.message,
        });
    } else if (typeof(error) === "string") {
        // e.g. Terminal.exec() rejects with a string when another operation is running
        callback({
            ok: false,
            msg: error,
            msgi18n: true,
        });
    } else {
        log.debug("console", "Unknown error: " + error);
    }
}

export function callbackResult(result : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }
    callback(result);
}

export async function doubleCheckPassword(socket : DockgeSocket, currentPassword : unknown) {
    if (typeof currentPassword !== "string") {
        throw new Error("Wrong data type?");
    }

    let user = await R.findOne("user", " id = ? AND active = 1 ", [
        socket.userID,
    ]);

    if (!user || !verifyPassword(currentPassword, user.password)) {
        throw new Error("Incorrect current password");
    }

    return user;
}

export function fileExists(file : string) {
    return fs.promises.access(file, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false);
}
