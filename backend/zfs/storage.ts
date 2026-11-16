import fs from "fs";
import path from "path";
import yaml from "yaml";
import childProcessAsync from "promisify-child-process";
import { DockgeServer } from "../dockge-server";
import { Stack } from "../stack";
import { dockerApiGet } from "../docker-api";
import { isInContainer } from "../host-ips";
import { hasVariable, splitShort } from "../bind-mounts";
import { log } from "../log";
import { getZfsSettings, isTrueNasConfigured } from "./settings";
import { DatasetInfo, getProvider } from "./provider";
import { TrueNasCertificateError } from "./truenas-client";
import { compareRecipe, parseRecipes, PropertyDifference, VolumeRecipe } from "./recipe";
import {
    datasetOf, findMount, getPropagation, getSpace, isInside, isZfsByStatfs, mountAt, MountEntry, Propagation, readMountInfo
} from "./mountinfo";

/**
 * Read-only view of the storage of the stacks folder and of the bind mounts of a stack: which paths are ZFS
 * datasets, which are plain folders, which are missing. See docs/ZFS-DESIGN.md (phase 1).
 *
 * Everything is detected from inside the Dockge container, without ZFS tools: /proc/self/mountinfo, statfs()
 * and GET /info of the Docker API.
 */

export type ProblemSeverity = "error" | "warning" | "info";

export interface StorageProblem {
    /** Stable identifier, also used by the UI to translate the message */
    code : string;
    severity : ProblemSeverity;
    message : string;
    /** How to fix it */
    remedy : string;
    params : Record<string, string>;
}

export interface Space {
    available : number;
    total : number;
}

export interface StorageStatus {
    stacksDir : string;
    /** The stacks folder is on ZFS */
    zfs : boolean;
    /** Filesystem type of the stacks folder (zfs, ext4, overlay, ...) */
    filesystem : string | null;
    /** Dataset that contains the stacks folder */
    dataset : string | null;
    /** The stacks folder is the root of its dataset (required to create the stacks as datasets) */
    stacksIsDatasetRoot : boolean;
    /** When the stacks folder is a plain folder inside a dataset: the name its own dataset would have */
    stacksFolderDataset : string | null;
    /** Dockge runs in a container: the propagation of the stacks folder mount matters */
    inContainer : boolean;
    /** Propagation of the mount of the stacks folder, null when not in a container or not on ZFS */
    propagation : Propagation | null;
    host : {
        truenas : boolean;
        kernelVersion : string | null;
        operatingSystem : string | null;
    };
    /** Provider able to create datasets: configured in Settings → Storage */
    provider : "truenas" | null;
    /** User the provider logs in as, when the connection works */
    providerUser : string | null;
    /** The stacks folder satisfies every requirement for the dataset features (dataset root, propagation) */
    ready : boolean;
    /** ready, a provider works, the stacks dataset is where Dockge sees it: stacks and volumes can be created as datasets */
    canCreate : boolean;
    space : Space | null;
    problems : StorageProblem[];
}

export type VolumeKind = "dataset" | "directory" | "file" | "missing" | "notVisible" | "unresolved";
export type VolumeLocation = "stack" | "otherStack" | "external";

export interface VolumeStorage {
    /** Services that mount it */
    services : string[];
    /** Bind source as written in compose.yaml (or as resolved by docker compose config) */
    source : string;
    /** Absolute path, null when it contains a variable that could not be resolved */
    hostPath : string | null;
    /** "./library" when inside the stack folder */
    relative : string | null;
    location : VolumeLocation | null;
    /** Name of the other stack, for location "otherStack" */
    otherStack : string | null;
    kind : VolumeKind;
    zfs : boolean;
    /** kind "dataset": the dataset mounted there; otherwise the dataset that contains the path */
    dataset : string | null;
    /** The path is the stack folder itself (".") */
    isStackFolder : boolean;
    space : Space | null;
    /** kind "dataset", read from the provider: recordsize, compression, atime, quota, acltype, aclmode, used, available */
    properties : Record<string, string> | null;
    /** The dataset was created by Dockge (user property dockge:managed) */
    managed : boolean | null;
    /** Entry of x-dockge.zfs for this path */
    recipe : VolumeRecipe | null;
    /** Differences between the dataset and x-dockge.zfs */
    differences : PropertyDifference[];
}

export interface StackStorage {
    stack : string;
    path : string;
    /** The stacks folder is on ZFS */
    zfs : boolean;
    /** The stack folder is a dataset of its own */
    isDataset : boolean;
    /** Dataset of the stack folder, or the one containing it */
    dataset : string | null;
    /** Where the bind mounts come from: the output of docker compose config, or compose.yaml read by Dockge */
    resolvedBy : "docker compose config" | "compose.yaml";
    volumes : VolumeStorage[];
    /** Datasets can be created for this stack (the stacks folder allows it and the stack is a dataset) */
    canCreateDatasets : boolean;
    /** Invalid entries of x-dockge.zfs */
    recipeErrors : string[];
    /** The provider could not be read: properties and differences are missing */
    providerError : string | null;
}

interface HostInfo {
    truenas : boolean;
    kernelVersion : string | null;
    operatingSystem : string | null;
}

const HOST_INFO_CACHE_MS = 10 * 60 * 1000;
let hostInfoCache : { time : number, info : HostInfo } | undefined;

async function getHostInfo() : Promise<HostInfo> {
    if (hostInfoCache && Date.now() - hostInfoCache.time < HOST_INFO_CACHE_MS) {
        return hostInfoCache.info;
    }
    let info : HostInfo = {
        truenas: false,
        kernelVersion: null,
        operatingSystem: null,
    };
    try {
        const res = await dockerApiGet<{ KernelVersion? : string, OperatingSystem? : string }>("/info");
        const kernelVersion = res.KernelVersion ?? null;
        info = {
            // e.g. "6.12.15-production+truenas"
            truenas: /truenas/i.test(kernelVersion ?? "") || /truenas/i.test(res.OperatingSystem ?? ""),
            kernelVersion,
            operatingSystem: res.OperatingSystem ?? null,
        };
    } catch (e) {
        log.debug("storage", "Cannot read the Docker host info: " + (e instanceof Error ? e.message : e));
    }
    hostInfoCache = {
        time: Date.now(),
        info,
    };
    return info;
}

function realPath(target : string) : string {
    try {
        return fs.realpathSync(target);
    } catch (e) {
        return path.resolve(target);
    }
}

/**
 * The deepest existing folder of a path (a missing path is on the filesystem of its first existing parent)
 */
function existingAncestor(target : string) : string {
    let current = target;
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return realPath(current);
}

function isZfsMount(entry : MountEntry | undefined) : entry is MountEntry {
    return entry !== undefined && entry.fsType === "zfs";
}

const PROPAGATION_SNIPPET = `volumes:
  - type: bind
    source: <stacks folder>
    target: <stacks folder>
    bind:
      propagation: rslave`;

export async function getStorageStatus(server : DockgeServer) : Promise<StorageStatus> {
    const stacksDir = realPath(server.stacksDir);
    const mounts = readMountInfo();
    const mount = findMount(mounts, stacksDir);
    const zfs = mount ? mount.fsType === "zfs" : isZfsByStatfs(stacksDir);
    const inContainer = isInContainer();
    const host = await getHostInfo();
    const problems : StorageProblem[] = [];

    let dataset : string | null = null;
    let stacksIsDatasetRoot = false;
    let stacksFolderDataset : string | null = null;
    let propagation : Propagation | null = null;

    if (zfs && mount) {
        const location = datasetOf(mount, stacksDir);
        dataset = location.dataset;
        stacksIsDatasetRoot = location.subPath === "";
        if (!stacksIsDatasetRoot) {
            stacksFolderDataset = `${location.dataset}/${location.subPath}`;
            problems.push({
                code: "stacksFolderNotDataset",
                severity: "warning",
                message: `The stacks folder is a plain folder inside the dataset ${location.dataset}. Stacks and volumes cannot be created as datasets. Do not create the dataset ${stacksFolderDataset} from TrueNAS or with zfs create: it would be mounted over the folder and hide all the stacks.`,
                remedy: `Move the stacks to a dataset ${stacksFolderDataset}: stop the stacks and Dockge, rename the folder, create the dataset, copy the content back, start again.`,
                params: {
                    dataset: location.dataset,
                    stacksFolderDataset,
                },
            });
        }

        if (inContainer) {
            propagation = getPropagation(mount);
            if (propagation === "private") {
                problems.push({
                    code: "mountPropagationPrivate",
                    severity: "warning",
                    message: "The stacks folder is mounted into Dockge without propagation: datasets mounted on the host after Dockge started are not visible inside Dockge, so it would see (and write into) the empty folder under them.",
                    remedy: "Mount the stacks folder with rslave propagation in the compose file of Dockge and recreate the Dockge container:\n" + PROPAGATION_SNIPPET,
                    params: {},
                });
            }
        }
    }

    const ready = zfs && stacksIsDatasetRoot && (!inContainer || propagation !== "private");
    const providerCheck = zfs && dataset && stacksIsDatasetRoot ? await checkProvider(dataset, stacksDir, host.truenas) : null;
    if (providerCheck) {
        problems.push(...providerCheck.problems);
    }

    return {
        stacksDir,
        zfs,
        filesystem: mount?.fsType ?? null,
        dataset,
        stacksIsDatasetRoot,
        stacksFolderDataset,
        inContainer,
        propagation,
        host,
        provider: providerCheck?.provider ?? null,
        providerUser: providerCheck?.user ?? null,
        ready,
        canCreate: ready && providerCheck?.ok === true,
        space: getSpace(stacksDir),
        problems,
    };
}

interface ProviderCheck {
    provider : "truenas" | null;
    user : string | null;
    ok : boolean;
    problems : StorageProblem[];
    stacksDataset : DatasetInfo | null;
}

const PROVIDER_CACHE_MS = 5 * 60 * 1000;
let providerCache : { key : string, time : number, check : ProviderCheck } | undefined;

/**
 * Forget the cached provider check (after the settings changed)
 */
export function resetProviderCache() {
    providerCache = undefined;
    datasetCache.clear();
}

/**
 * Connect to the provider and check the dataset of the stacks folder: it must be mounted where Dockge sees the
 * stacks folder, and its ACL must not prevent chmod. Cached, the result rarely changes.
 */
async function checkProvider(stacksDataset : string, stacksDir : string, truenasHost : boolean) : Promise<ProviderCheck> {
    const settings = await getZfsSettings();
    const result : ProviderCheck = {
        provider: null,
        user: null,
        ok: false,
        problems: [],
        stacksDataset: null,
    };

    if (!isTrueNasConfigured(settings)) {
        if (truenasHost) {
            result.problems.push({
                code: "truenasNotConfigured",
                severity: "info",
                message: "Dockge runs on TrueNAS: configure the TrueNAS API below to create stacks and volumes as datasets.",
                remedy: "Create an API key for a dedicated TrueNAS user and enter the URL, the user and the key.",
                params: {},
            });
        }
        return result;
    }
    result.provider = "truenas";

    const key = JSON.stringify([ stacksDataset, stacksDir, settings.truenasUrl, settings.truenasUsername, settings.truenasApiKey, settings.truenasFingerprint ]);
    if (providerCache && providerCache.key === key && Date.now() - providerCache.time < PROVIDER_CACHE_MS) {
        return providerCache.check;
    }

    const provider = getProvider(settings);
    try {
        if (!provider) {
            throw new Error("Not configured");
        }
        result.user = await provider.whoAmI();
        const [ info ] = await provider.getDatasets(stacksDataset, false);
        if (!info) {
            throw new Error(`The dataset ${stacksDataset} is not visible to the TrueNAS user ${settings.truenasUsername}`);
        }
        result.stacksDataset = info;
        result.ok = true;

        if (info.mountpoint && path.resolve(info.mountpoint) !== stacksDir) {
            result.ok = false;
            result.problems.push({
                code: "stacksMountpointMismatch",
                severity: "error",
                message: `On the host the dataset ${stacksDataset} is mounted at ${info.mountpoint}, but Dockge sees it at ${stacksDir}. Datasets would be created where Dockge does not expect them.`,
                remedy: "Mount the stacks folder into Dockge with the same path on both sides (source and target), and set DOCKGE_STACKS_DIR to that path.",
                params: {
                    dataset: stacksDataset,
                    mountpoint: info.mountpoint,
                    stacksDir,
                },
            });
        }

        if (info.properties.acltype?.toUpperCase() === "NFSV4" && info.properties.aclmode?.toUpperCase() === "RESTRICTED") {
            result.problems.push({
                code: "aclRestricted",
                severity: "warning",
                message: `The dataset ${stacksDataset} has NFSv4 ACLs with aclmode=restricted (typical of the SMB preset): new datasets inherit it, chmod fails with "Operation not permitted" and many containers crash at start.`,
                remedy: "In TrueNAS set the ACL mode of the stacks dataset to Passthrough (Edit dataset → Advanced → ACL Mode), or use POSIX ACLs.",
                params: {
                    dataset: stacksDataset,
                },
            });
        }
    } catch (e) {
        result.ok = false;
        const certificate = e instanceof TrueNasCertificateError ? e : null;
        result.problems.push({
            code: certificate ? "truenasCertificate" : "truenasConnection",
            severity: "error",
            message: `Cannot use the TrueNAS API: ${e instanceof Error ? e.message : e}`,
            remedy: certificate
                ? "Check the fingerprint against the certificate of TrueNAS (System → Certificates) and trust it in the TrueNAS section below."
                : "Check URL, user and API key below (Test connection), and that the user has the roles to read and create datasets.",
            params: {
                error: e instanceof Error ? e.message : String(e),
                fingerprint: certificate?.fingerprint ?? "",
            },
        });
    }

    providerCache = {
        key,
        time: Date.now(),
        check: result,
    };
    return result;
}

const DATASET_CACHE_MS = 30 * 1000;
const datasetCache = new Map<string, { time : number, list : DatasetInfo[] }>();

/**
 * Datasets of a stack (the stack dataset and its descendants), from the provider. null when there is no provider.
 */
async function getStackDatasets(stackDataset : string) : Promise<DatasetInfo[] | null> {
    const cached = datasetCache.get(stackDataset);
    if (cached && Date.now() - cached.time < DATASET_CACHE_MS) {
        return cached.list;
    }
    const provider = getProvider(await getZfsSettings());
    if (!provider) {
        return null;
    }
    const list = await provider.getDatasets(stackDataset, true);
    datasetCache.set(stackDataset, {
        time: Date.now(),
        list,
    });
    return list;
}

export function forgetStackDatasets(stackDataset : string) {
    datasetCache.delete(stackDataset);
}

/**
 * Short summary for get_info
 */
export async function getStorageSummary(server : DockgeServer) {
    const status = await getStorageStatus(server);
    return {
        zfs: status.zfs,
        dataset: status.dataset,
        stacksIsDatasetRoot: status.stacksIsDatasetRoot,
        truenas: status.host.truenas,
        ready: status.ready,
        provider: status.provider,
        canCreate: status.canCreate,
        problems: status.problems.map((problem) => problem.code),
    };
}

export interface BindSource {
    service : string;
    /** As written, or absolute when resolved by docker compose config */
    source : string;
}

/**
 * Bind mounts of services.*.volumes, from the compose file text
 */
export function bindSourcesFromYAML(content : string) : BindSource[] {
    let config;
    try {
        config = yaml.parse(content);
    } catch (e) {
        return [];
    }
    const services = config?.services;
    if (!services || typeof services !== "object") {
        return [];
    }
    const result : BindSource[] = [];
    for (const [ service, definition ] of Object.entries(services)) {
        const volumes = (definition as { volumes? : unknown } | null)?.volumes;
        if (!Array.isArray(volumes)) {
            continue;
        }
        for (const volume of volumes) {
            if (typeof volume === "string") {
                const parts = splitShort(volume);
                // "name:/data" is a named volume, a bind starts with "/", "." or "~" (or a variable)
                if (parts && /^[/.~$]/.test(parts.host)) {
                    result.push({
                        service,
                        source: parts.host,
                    });
                }
            } else if (volume && typeof volume === "object") {
                const { type, source } = volume as { type? : unknown, source? : unknown };
                if (type === "bind" && typeof source === "string") {
                    result.push({
                        service,
                        source,
                    });
                }
            }
        }
    }
    return result;
}

/**
 * The compose file as resolved by docker compose (absolute paths, variables replaced). Throws if it is invalid.
 */
export async function loadComposeConfig(stack : Stack) : Promise<Record<string, unknown>> {
    const res = await childProcessAsync.spawn("docker", stack.getComposeOptions("config", "--format", "json"), {
        cwd: stack.path,
        encoding: "utf-8",
        timeout: 30 * 1000,
        maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(res.stdout?.toString() ?? "");
}

/**
 * Bind mounts of a resolved compose config
 */
export function bindSourcesFromConfig(config : Record<string, unknown>) : BindSource[] {
    const result : BindSource[] = [];
    for (const [ service, definition ] of Object.entries((config?.services ?? {}) as Record<string, unknown>)) {
        const volumes = (definition as { volumes? : unknown } | null)?.volumes;
        if (!Array.isArray(volumes)) {
            continue;
        }
        for (const volume of volumes) {
            if (volume?.type === "bind" && typeof volume.source === "string") {
                result.push({
                    service,
                    source: volume.source,
                });
            }
        }
    }
    return result;
}

async function bindSourcesFromCompose(stack : Stack) : Promise<BindSource[]> {
    return bindSourcesFromConfig(await loadComposeConfig(stack));
}

function toRelative(target : string, stackDir : string) : string {
    const relative = path.relative(stackDir, target);
    return relative === "" ? "." : "./" + relative.split(path.sep).join("/");
}

/**
 * Describe one bind source
 * @param source As written (relative to the stack folder) or absolute
 * @param stackDir Absolute path of the stack folder (it may not exist yet)
 * @param stacksDir Absolute path of the stacks folder
 * @param mounts Content of mountinfo
 */
export function describeBindSource(source : string, stackDir : string, stacksDir : string, mounts : MountEntry[]) : Omit<VolumeStorage, "services"> {
    const base : Omit<VolumeStorage, "services"> = {
        source,
        hostPath: null,
        relative: null,
        location: null,
        otherStack: null,
        kind: "unresolved",
        zfs: false,
        dataset: null,
        isStackFolder: false,
        space: null,
        properties: null,
        managed: null,
        recipe: null,
        differences: [],
    };

    if (hasVariable(source) || source.startsWith("~")) {
        return base;
    }

    const hostPath = path.resolve(stackDir, source);
    let location : VolumeLocation = "external";
    let otherStack : string | null = null;
    if (isInside(hostPath, stackDir)) {
        location = "stack";
    } else if (isInside(hostPath, stacksDir) && hostPath !== stacksDir) {
        location = "otherStack";
        otherStack = path.relative(stacksDir, hostPath).split(path.sep)[0];
    }

    const result : Omit<VolumeStorage, "services"> = {
        ...base,
        hostPath,
        relative: location === "stack" ? toRelative(hostPath, stackDir) : null,
        location,
        otherStack,
        isStackFolder: hostPath === stackDir,
    };

    let stat : fs.Stats | undefined;
    try {
        stat = fs.statSync(hostPath);
    } catch (e) {
        // missing
    }

    const resolved = stat ? realPath(hostPath) : existingAncestor(hostPath);
    const mount = findMount(mounts, resolved);

    // A path outside the stacks folder that is on the root filesystem of the container is not mounted into
    // Dockge: what Dockge sees there is not what the host has
    if (location === "external" && isInContainer() && (!mount || mount.mountPoint === "/")) {
        result.kind = "notVisible";
        return result;
    }

    result.zfs = mount ? mount.fsType === "zfs" : isZfsByStatfs(resolved);
    result.space = getSpace(resolved);

    if (!stat) {
        result.kind = "missing";
    } else if (!stat.isDirectory()) {
        result.kind = "file";
    } else {
        const own = mountAt(mounts, resolved);
        result.kind = isZfsMount(own) && own.root === "/" ? "dataset" : "directory";
    }

    if (result.zfs && mount) {
        if (result.kind === "dataset") {
            result.dataset = mount.source;
        } else {
            // The dataset that contains the path: inside it, a missing path cannot be a dataset yet
            result.dataset = datasetOf(mount, resolved).dataset;
        }
    }
    return result;
}

/**
 * Storage of a stack and of its bind mounts.
 * @param server Dockge server
 * @param stackName Stack name
 * @param composeYAML Content to analyze instead of the saved compose.yaml (the draft of the editor)
 */
export async function getStackStorage(server : DockgeServer, stackName : string, composeYAML? : string) : Promise<StackStorage> {
    const stacksDir = realPath(server.stacksDir);
    const stackDir = path.join(stacksDir, stackName);
    const mounts = readMountInfo();

    let sources : BindSource[];
    let resolvedBy : StackStorage["resolvedBy"] = "compose.yaml";
    let content = composeYAML ?? "";

    if (composeYAML !== undefined) {
        sources = bindSourcesFromYAML(composeYAML);
    } else {
        const stack = await Stack.getStack(server, stackName);
        content = stack.composeYAML;
        try {
            sources = await bindSourcesFromCompose(stack);
            resolvedBy = "docker compose config";
        } catch (e) {
            log.debug("storage", `docker compose config failed for ${stackName}: ` + (e instanceof Error ? e.message : e));
            sources = bindSourcesFromYAML(stack.composeYAML);
        }
    }

    // One entry per path, with the services that mount it
    const byPath = new Map<string, VolumeStorage>();
    for (const { service, source } of sources) {
        const description = describeBindSource(source, stackDir, stacksDir, mounts);
        const key = description.hostPath ?? source;
        const existing = byPath.get(key);
        if (existing) {
            if (!existing.services.includes(service)) {
                existing.services.push(service);
            }
        } else {
            byPath.set(key, {
                services: [ service ],
                ...description,
            });
        }
    }

    const stackMount = fs.existsSync(stackDir) ? findMount(mounts, realPath(stackDir)) : findMount(mounts, existingAncestor(stackDir));
    const own = mountAt(mounts, stackDir);
    const zfs = stackMount ? stackMount.fsType === "zfs" : isZfsByStatfs(stacksDir);
    const isDataset = isZfsMount(own) && own.root === "/";
    const volumes = [ ...byPath.values() ];

    // x-dockge.zfs: recipe of each volume inside the stack
    const { recipes, errors: recipeErrors } = parseRecipes(content);
    for (const volume of volumes) {
        if (volume.location === "stack" && volume.relative && volume.relative !== ".") {
            volume.recipe = recipes.get(volume.relative.replace(/^\.\//, "")) ?? null;
        }
    }

    // Properties of the datasets of the stack, from the provider
    let providerError : string | null = null;
    if (isDataset && own) {
        try {
            const datasets = await getStackDatasets(own.source);
            if (datasets) {
                const byName = new Map(datasets.map((dataset) => [ dataset.name, dataset ]));
                for (const volume of volumes) {
                    const info = volume.kind === "dataset" && volume.dataset ? byName.get(volume.dataset) : undefined;
                    if (info) {
                        volume.properties = info.properties;
                        volume.managed = info.userProperties["dockge:managed"] === "true";
                        volume.differences = volume.recipe ? compareRecipe(volume.recipe, info) : [];
                    }
                }
            }
        } catch (e) {
            providerError = e instanceof Error ? e.message : String(e);
        }
    }

    let canCreateDatasets = false;
    if (isDataset) {
        canCreateDatasets = (await getStorageStatus(server)).canCreate;
    }

    return {
        stack: stackName,
        path: stackDir,
        zfs,
        isDataset,
        dataset: zfs && stackMount ? datasetOf(stackMount, stackDir).dataset : null,
        resolvedBy,
        volumes,
        canCreateDatasets,
        recipeErrors,
        providerError,
    };
}

const COMPOSE_FILE_NAMES = [ "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml" ];

/**
 * ZFS information for the entries of the host path picker
 * @param entries Absolute paths
 * @param stacksDir Absolute path of the stacks folder
 */
export function describeHostPaths(entries : string[], stacksDir : string) : Map<string, { dataset : string | null, stack : string | null }> {
    const mounts = readMountInfo();
    const stacks = realPath(stacksDir);
    const result = new Map<string, { dataset : string | null, stack : string | null }>();
    for (const entry of entries) {
        const own = mountAt(mounts, entry);
        let stack : string | null = null;
        if (isInside(entry, stacks) && entry !== stacks) {
            const name = path.relative(stacks, entry).split(path.sep)[0];
            // Only a real stack: a folder with a compose file
            if (COMPOSE_FILE_NAMES.some((file) => fs.existsSync(path.join(stacks, name, file)))) {
                stack = name;
            }
        }
        result.set(entry, {
            dataset: isZfsMount(own) && own.root === "/" ? own.source : null,
            stack,
        });
    }
    return result;
}
