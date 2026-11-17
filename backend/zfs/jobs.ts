import crypto from "crypto";
import { ValidationError } from "../util-server";
import { log } from "../log";

/**
 * Long ZFS operations (conversions, adoptions, recoveries) run as jobs: the call returns a job id at once, the UI
 * and the API follow the step and the progress. Jobs live in memory; an interrupted conversion is found again
 * through the dockge:migration user property of its dataset (see migrate.ts).
 *
 * While a job works on a stack, deploy / start / stop / rename / delete of that stack are refused.
 */

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface Job {
    id : string;
    type : string;
    stack : string;
    /** What is converted / adopted, e.g. "./library" */
    target : string;
    state : JobState;
    step : string;
    /** 0-100, null when unknown */
    progress : number | null;
    bytesTotal : number | null;
    bytesDone : number | null;
    log : string[];
    error : string | null;
    result : unknown;
    started : number;
    finished : number | null;
    cancelRequested : boolean;
}

const jobs = new Map<string, Job>();
const MAX_FINISHED = 50;

export class JobCancelledError extends Error {
    constructor() {
        super("Cancelled");
    }
}

export interface JobContext {
    job : Job;
    setStep(step : string, progress? : number | null) : void;
    setBytes(done : number | null, total? : number | null) : void;
    log(line : string) : void;
    /** Throws JobCancelledError when a cancellation was requested */
    checkCancelled() : void;
}

export function getJob(id : string) : Job | undefined {
    return jobs.get(id);
}

export function listJobs(stack? : string) : Job[] {
    return [ ...jobs.values() ]
        .filter((job) => !stack || job.stack === stack)
        .sort((a, b) => b.started - a.started);
}

/**
 * The job running on a stack, if any
 */
export function runningJob(stack : string) : Job | undefined {
    return [ ...jobs.values() ].find((job) => job.stack === stack && job.state === "running");
}

/**
 * Refuse an operation on a stack while a job works on it
 */
export function assertNoJob(stack : string, action : string) {
    const job = runningJob(stack);
    if (job) {
        throw new ValidationError(`Cannot ${action} the stack ${stack}: ${job.type} of ${job.target} is running (job ${job.id})`);
    }
}

export function cancelJob(id : string) : Job {
    const job = jobs.get(id);
    if (!job) {
        throw new ValidationError("Job not found");
    }
    if (job.state === "running") {
        job.cancelRequested = true;
        job.log.push("Cancellation requested");
    }
    return job;
}

function prune() {
    const finished = [ ...jobs.values() ].filter((job) => job.state !== "running").sort((a, b) => a.started - b.started);
    while (finished.length > MAX_FINISHED) {
        const job = finished.shift();
        if (job) {
            jobs.delete(job.id);
        }
    }
}

/**
 * Start a job. Only one job per stack at a time.
 * @returns The job (running)
 */
export function startJob(type : string, stack : string, target : string, run : (context : JobContext) => Promise<unknown>, onChange? : () => void) : Job {
    assertNoJob(stack, type);
    const job : Job = {
        id: crypto.randomUUID(),
        type,
        stack,
        target,
        state: "running",
        step: "starting",
        progress: 0,
        bytesTotal: null,
        bytesDone: null,
        log: [],
        error: null,
        result: null,
        started: Date.now(),
        finished: null,
        cancelRequested: false,
    };
    jobs.set(job.id, job);

    const context : JobContext = {
        job,
        setStep(step, progress) {
            job.step = step;
            if (progress !== undefined) {
                job.progress = progress;
            }
            job.log.push(`${new Date().toISOString()} ${step}`);
            log.info("zfs-job", `${type} ${stack} ${target}: ${step}`);
            onChange?.();
        },
        setBytes(done, total) {
            job.bytesDone = done;
            if (total !== undefined) {
                job.bytesTotal = total;
            }
            if (job.bytesTotal && done !== null) {
                job.progress = Math.min(99, Math.round(done / job.bytesTotal * 100));
            }
        },
        log(line) {
            job.log.push(line);
            if (job.log.length > 500) {
                job.log.splice(0, job.log.length - 500);
            }
        },
        checkCancelled() {
            if (job.cancelRequested) {
                throw new JobCancelledError();
            }
        },
    };

    run(context).then((result) => {
        job.state = "done";
        job.progress = 100;
        job.step = "done";
        job.result = result ?? null;
    }, (e) => {
        job.state = e instanceof JobCancelledError ? "cancelled" : "failed";
        job.error = e instanceof Error ? e.message : String(e);
        job.log.push(`${new Date().toISOString()} ${job.state}: ${job.error}`);
        log.warn("zfs-job", `${type} ${stack} ${target} ${job.state}: ${job.error}`);
    }).finally(() => {
        job.finished = Date.now();
        prune();
        onChange?.();
    });
    return job;
}

/**
 * Public view of a job (the log is long: only the last lines)
 */
export function jobSummary(job : Job, logLines = 30) {
    const { cancelRequested, log: lines, ...rest } = job;
    return {
        ...rest,
        cancelRequested,
        log: lines.slice(-logLines),
    };
}
