import fs from "fs";
import os from "os";
import childProcessAsync from "promisify-child-process";
import { log } from "./log";
import { apiName, dockerApiGet } from "./docker-api";

/**
 * IP addresses of the host, for the "bind this port to IP" dropdown of the port fields.
 *
 * Inside a container (bridge network) os.networkInterfaces() only returns the container's own addresses.
 * In that case Dockge starts its own image for a moment with "--network host" (through the docker socket,
 * nothing is downloaded) and reads the interfaces from there.
 *
 * DOCKGE_HOST_IPS (comma separated, e.g. "192.168.1.10,10.0.0.5") replaces the detection.
 */

export interface HostIP {
    address : string;
    family : "IPv4" | "IPv6";
    interface : string;
}

const CACHE_MS = 5 * 60 * 1000;
let cache : { time : number, list : HostIP[] } | undefined;

// Virtual interfaces that are never useful to bind a published port to
const IGNORED_INTERFACES = /^(veth|docker|br-|virbr|kube|cni|flannel|cali|vxlan)/;

const SCRIPT = "console.log(JSON.stringify(require('os').networkInterfaces()))";

function fromInterfaces(interfaces : NodeJS.Dict<os.NetworkInterfaceInfo[]>) : HostIP[] {
    const list : HostIP[] = [];
    for (const [ name, addresses ] of Object.entries(interfaces)) {
        if (!addresses || IGNORED_INTERFACES.test(name)) {
            continue;
        }
        for (const address of addresses) {
            // Link-local IPv6 addresses cannot be used in a port mapping
            if (address.family === "IPv6" && address.address.toLowerCase().startsWith("fe80")) {
                continue;
            }
            list.push({
                address: address.address,
                family: address.family === "IPv6" ? "IPv6" : "IPv4",
                interface: name,
            });
        }
    }
    // IPv4 first, loopback last
    return list.sort((a, b) => {
        const rank = (ip : HostIP) => (ip.family === "IPv4" ? 0 : 2) + (ip.interface === "lo" ? 1 : 0);
        return rank(a) - rank(b);
    });
}

function isInContainer() : boolean {
    return fs.existsSync("/.dockerenv") || process.env.DOCKGE_IS_CONTAINER === "1";
}

async function detectFromHostNetwork() : Promise<HostIP[]> {
    // The container ID is the default hostname of a container
    let image : string | undefined;
    try {
        image = (await dockerApiGet<{ Image? : string }>(`/containers/${apiName(os.hostname())}/json`)).Image;
    } catch (e) {
        const inspect = await childProcessAsync.spawn("docker", [ "inspect", "--format", "{{.Image}}", os.hostname() ], {
            encoding: "utf-8",
            timeout: 10 * 1000,
        });
        image = inspect.stdout?.toString().trim();
    }
    if (!image) {
        throw new Error("Cannot find the image of the Dockge container");
    }

    const res = await childProcessAsync.spawn("docker", [
        "run", "--rm", "--network", "host", "--pull", "never", "--entrypoint", "node", image, "-e", SCRIPT,
    ], {
        encoding: "utf-8",
        timeout: 30 * 1000,
    });
    return fromInterfaces(JSON.parse(res.stdout?.toString() ?? "{}"));
}

export async function getHostIPs() : Promise<{ list : HostIP[], source : string }> {
    const manual = process.env.DOCKGE_HOST_IPS;
    if (manual) {
        return {
            source: "DOCKGE_HOST_IPS",
            list: manual.split(",").map((ip) => ip.trim()).filter((ip) => ip).map((address) => ({
                address,
                family: address.includes(":") ? "IPv6" : "IPv4",
                interface: "",
            })),
        };
    }

    if (cache && Date.now() - cache.time < CACHE_MS) {
        return {
            source: "cache",
            list: cache.list,
        };
    }

    let list : HostIP[];
    let source = "local";
    if (isInContainer()) {
        try {
            list = await detectFromHostNetwork();
            source = "host network";
        } catch (e) {
            log.warn("host-ips", "Cannot read the host interfaces, showing the container ones: " + (e instanceof Error ? e.message : e));
            list = fromInterfaces(os.networkInterfaces());
            source = "container";
        }
    } else {
        list = fromInterfaces(os.networkInterfaces());
    }

    cache = {
        time: Date.now(),
        list,
    };
    return {
        source,
        list,
    };
}
