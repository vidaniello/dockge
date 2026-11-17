import os from "os";
import path from "path";
import childProcessAsync from "promisify-child-process";
import { DockgeServer } from "../dockge-server";
import { ValidationError } from "../util-server";
import { apiName, dockerApiGet } from "../docker-api";
import { log } from "../log";
import { isInside, readMountInfo } from "./mountinfo";

/**
 * Data hidden under a mount (docs/ZFS-DESIGN.md §5.1): when a dataset is created over a folder that already has
 * content, that content stays on the parent filesystem, invisible under the mount, and still takes space.
 *
 * A bind mount that is NOT recursive shows a filesystem without what is mounted on it. Dockge starts its own image for a
 * moment (as for the host IPs) with a non-recursive bind of the parent folder of every dataset of the stacks folder,
 * and looks at what is under each mount point. To recover, the hidden content is moved (same filesystem, instant)
 * into a visible folder next to the mount point: <name>.dockge-hidden-<date>.
 */

export interface HiddenData {
    /** Mount point (path on the host, the same as in Dockge) */
    mountpoint : string;
    dataset : string;
    entries : number;
    bytes : number;
    /** Some names, to recognize the content */
    sample : string[];
}

const LIMIT = 20000;

/** Run in the helper container: report or move what is under each mount point */
const SCRIPT = `
const fs = require("fs"); const path = require("path");
const [ mode, json ] = process.argv.slice(1);
const items = JSON.parse(json);
const out = [];
for (const item of items) {
    const dir = path.join(item.bind, item.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { out.push({ id: item.id, entries: 0, bytes: 0, sample: [] }); continue; }
    if (mode === "recover") {
        if (names.length === 0) { out.push({ id: item.id, moved: 0 }); continue; }
        const target = path.join(item.bind, item.name + ".dockge-hidden-" + item.stamp);
        fs.mkdirSync(target);
        for (const name of names) fs.renameSync(path.join(dir, name), path.join(target, name));
        out.push({ id: item.id, moved: names.length, target: path.join(item.hostParent, path.basename(target)) });
        continue;
    }
    let entries = 0, bytes = 0;
    const walk = (p) => { if (entries > ${LIMIT}) return; for (const e of fs.readdirSync(p, { withFileTypes: true })) { entries++; const f = path.join(p, e.name);
        if (e.isDirectory()) walk(f); else if (e.isFile()) bytes += fs.lstatSync(f).size; } };
    try { walk(dir); } catch (e) {}
    out.push({ id: item.id, entries, bytes, sample: names.slice(0, 5) });
}
console.log(JSON.stringify(out));
`;

async function dockgeImage() : Promise<string> {
    try {
        const image = (await dockerApiGet<{ Image? : string }>(`/containers/${apiName(os.hostname())}/json`)).Image;
        if (image) {
            return image;
        }
    } catch (e) {
        // not in a container, or no access to the API
    }
    throw new ValidationError("Cannot find the image of the Dockge container: the search needs Dockge to run in a container");
}

function timestamp(date = new Date()) : string {
    const pad = (value : number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * The ZFS mount points of the stacks folder (it included), visible in Dockge
 */
function datasetMounts(stacksDir : string) {
    return readMountInfo()
        .filter((entry) => entry.fsType === "zfs" && entry.root === "/" && isInside(entry.mountPoint, stacksDir))
        .map((entry) => ({
            mountpoint: entry.mountPoint,
            dataset: entry.source,
        }));
}

async function runHelper(mode : "scan" | "recover", targets : { mountpoint : string, dataset : string }[]) {
    const image = await dockgeImage();
    // One non-recursive bind per parent folder
    const parents = [ ...new Set(targets.map((target) => path.dirname(target.mountpoint))) ];
    const args = [ "run", "--rm", "--network", "none", "--pull", "never", "--entrypoint", "node" ];
    parents.forEach((parent, index) => {
        args.push("--mount", `type=bind,source=${parent},target=/hidden/${index},bind-recursive=disabled${mode === "scan" ? ",readonly" : ""}`);
    });
    const stamp = timestamp();
    const items = targets.map((target, id) => ({
        id,
        bind: `/hidden/${parents.indexOf(path.dirname(target.mountpoint))}`,
        name: path.basename(target.mountpoint),
        hostParent: path.dirname(target.mountpoint),
        stamp,
    }));
    args.push(image, "-e", SCRIPT, mode, JSON.stringify(items));
    const res = await childProcessAsync.spawn("docker", args, {
        encoding: "utf-8",
        timeout: 5 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(res.stdout?.toString() ?? "[]") as Record<string, unknown>[];
}

/**
 * Look for data hidden under the datasets of the stacks folder
 */
export async function findHiddenData(server : DockgeServer) : Promise<HiddenData[]> {
    const mounts = datasetMounts(path.resolve(server.stacksDir));
    if (mounts.length === 0) {
        return [];
    }
    let output : Record<string, unknown>[];
    try {
        output = await runHelper("scan", mounts);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(`The search for hidden data failed (it needs Docker 25 or later for non-recursive bind mounts): ${message}`);
    }
    const result : HiddenData[] = [];
    for (const item of output) {
        const mount = mounts[Number(item.id)];
        if (mount && Number(item.entries) > 0) {
            result.push({
                ...mount,
                entries: Number(item.entries),
                bytes: Number(item.bytes),
                sample: Array.isArray(item.sample) ? item.sample.map(String) : [],
            });
        }
    }
    return result;
}

/**
 * Move the data hidden under a mount point into a visible folder next to it
 */
export async function recoverHiddenData(server : DockgeServer, mountpoint : string) {
    const mount = datasetMounts(path.resolve(server.stacksDir)).find((item) => item.mountpoint === mountpoint);
    if (!mount) {
        throw new ValidationError(`${mountpoint} is not a dataset of the stacks folder`);
    }
    const [ item ] = await runHelper("recover", [ mount ]);
    log.info("zfs", `Hidden data under ${mountpoint}: ${item?.moved ?? 0} entries moved to ${item?.target ?? "-"}`);
    return {
        ok: true,
        mountpoint,
        moved: Number(item?.moved ?? 0),
        folder: item?.target ?? null,
    };
}
