<template>
    <div>
        <h4 class="mb-3">{{ $t("storage") }}</h4>
        <div class="shadow-box big-padding mb-3">
            <!-- The stack folder itself -->
            <div v-if="!storage.isDataset" class="d-flex align-items-center flex-wrap gap-2 mb-3">
                <span>{{ $t("stackStorageIsFolder") }}</span>
                <button v-if="canConvertStack" class="btn btn-sm btn-primary ms-auto" :disabled="busy" @click="openConvert(null)">
                    {{ $t("convertStackButton") }}
                </button>
            </div>
            <div v-if="storage.migration === 'copying' && !job" class="alert alert-warning small rounded-3">
                {{ $t("conversionInterrupted", [ stackName ]) }}
                <button class="btn btn-sm btn-normal ms-2" :disabled="busy" @click="abort(null)">{{ $t("conversionAbort") }}</button>
            </div>

            <!-- Running job -->
            <div v-if="job" class="job mb-3">
                <div class="d-flex align-items-center gap-2 mb-1">
                    <span class="fw-bold">{{ job.type }} {{ job.target }}</span>
                    <span class="small text-muted">{{ job.step }}</span>
                    <button v-if="job.state === 'running'" class="btn btn-sm btn-normal ms-auto" :disabled="job.cancelRequested" @click="cancel">{{ $t("cancel") }}</button>
                </div>
                <div class="progress" role="progressbar">
                    <div class="progress-bar" :class="{ 'bg-danger': job.state === 'failed' }" :style="{ width: (job.progress ?? 0) + '%' }"></div>
                </div>
                <div v-if="job.bytesTotal" class="small text-muted mt-1">{{ formatBytes(job.bytesDone ?? 0) }} / {{ formatBytes(job.bytesTotal) }}</div>
                <div v-if="job.error" class="small text-danger mt-1">{{ job.error }}</div>
            </div>

            <!-- Volumes -->
            <ul v-if="volumes.length > 0" class="list-group mb-2">
                <li v-for="volume in volumes" :key="volume.hostPath || volume.source" class="list-group-item d-flex align-items-center flex-wrap gap-2">
                    <code class="path">{{ volume.relative || volume.hostPath || volume.source }}</code>
                    <span class="badge" :class="kindClass(volume)" :title="volume.dataset || ''">{{ kindText(volume) }}</span>
                    <span v-if="volume.migration === 'copying' && !job" class="badge bg-warning text-dark">{{ $t("conversionInterruptedShort") }}</span>
                    <span class="ms-auto d-flex gap-1">
                        <button v-if="canConvertVolume(volume)" class="btn btn-sm btn-normal" :disabled="busy || !!job" :title="$t('convertVolumeHint')" @click="openConvert(volume.relative)">{{ $t("convertButton") }}</button>
                        <button v-if="canAdopt(volume)" class="btn btn-sm btn-normal" :disabled="busy || !!job" :title="$t('adoptHint')" @click="openAdopt(volume)">{{ $t("adoptButton") }}</button>
                        <button v-if="volume.migration === 'copying' && !job" class="btn btn-sm btn-normal" :disabled="busy" @click="abort(volume.relative)">{{ $t("conversionAbort") }}</button>
                    </span>
                </li>
            </ul>

            <!-- Copies kept by the conversions -->
            <div v-if="storage.backups && storage.backups.length > 0" class="mt-3">
                <div class="small fw-bold mb-1">{{ $t("conversionBackups") }}</div>
                <div v-for="backup in storage.backups" :key="backup.name" class="d-flex align-items-center gap-2 small mb-1">
                    <code class="path">{{ backup.name }}</code>
                    <button class="btn btn-sm btn-normal text-danger ms-auto" :disabled="busy || !!job" @click="askDeleteBackup(backup)">
                        <font-awesome-icon icon="trash" />
                    </button>
                </div>
                <div class="form-text">{{ $t("conversionBackupsHint") }}</div>
            </div>
        </div>

        <!-- Plan of a conversion / adoption / backup deletion -->
        <BModal
            v-model="showPlan"
            :title="planTitle"
            :okTitle="planTitle"
            :okVariant="planKind === 'deleteBackup' ? 'danger' : 'primary'"
            :cancelTitle="$t('cancel')"
            :okDisabled="!plan || busy || (planKind === 'deleteBackup' && confirmText !== plan.backup)"
            @ok="runPlan"
        >
            <div v-if="planError" class="alert alert-danger rounded-3">{{ planError }}</div>
            <div v-else-if="!plan" class="text-muted">{{ $t("storageLoading") }}</div>

            <template v-else-if="planKind === 'convert'">
                <p>{{ $t("convertIntro", [ plan.path, plan.dataset ]) }}</p>
                <ul class="small">
                    <li>{{ $t("convertSize", [ plan.files, plan.size ]) }}</li>
                    <li v-if="plan.available !== null">{{ $t("convertFree", [ formatBytes(plan.available) ]) }}</li>
                    <li v-if="plan.stopsAndStartsStack">{{ $t("convertStops") }}</li>
                    <li>{{ $t("convertSnapshot", [ plan.safetySnapshot ]) }}</li>
                    <li>{{ $t("convertBackup", [ plan.backup ]) }}</li>
                </ul>
                <div v-for="warning in plan.warnings" :key="warning" class="form-text text-warning">{{ warning }}</div>
            </template>

            <template v-else-if="planKind === 'adopt'">
                <label class="form-label" for="adopt-name">{{ $t("adoptName") }}</label>
                <div class="input-group mb-2">
                    <span class="input-group-text">./</span>
                    <input id="adopt-name" v-model="adoptName" class="form-control" @change="loadAdoptPlan" />
                </div>
                <p>{{ $t("adoptIntro", [ plan.source, plan.destination ]) }}</p>
                <ul class="small">
                    <li v-for="rewrite in plan.rewrites" :key="rewrite.from + rewrite.service"><code>{{ rewrite.from }}</code> → <code>{{ rewrite.to }}</code></li>
                    <li v-if="plan.stopsAndStartsStack">{{ $t("convertStops") }}</li>
                </ul>
                <div v-for="item in plan.attachments" :key="item.type" class="alert alert-warning small rounded-3 py-2">
                    {{ $t("adoptAttachment", [ item.type, item.attachments.join(", ") ]) }}
                </div>
                <div v-for="warning in plan.warnings" :key="warning" class="form-text text-warning">{{ warning }}</div>
            </template>

            <template v-else-if="planKind === 'deleteBackup'">
                <p>{{ $t("deleteBackupIntro", [ plan.backup, plan.files, plan.size ]) }}</p>
                <label class="form-label" for="backup-confirm">{{ $t("snapshotTypeName") }}</label>
                <input id="backup-confirm" v-model="confirmText" class="form-control" autocomplete="off" />
            </template>
        </BModal>
    </div>
</template>

<script>
import { BModal } from "bootstrap-vue-next";
import { formatBytes } from "../util-frontend";

/**
 * Storage of a stack on ZFS: its volumes with "convert to dataset" / "adopt", the conversion jobs, the copies kept
 */
export default {
    components: {
        BModal,
    },
    props: {
        endpoint: {
            type: String,
            default: "",
        },
        stackName: {
            type: String,
            required: true,
        },
        /** getStackStorage of the saved stack */
        storage: {
            type: Object,
            required: true,
        },
        /** getStorageStatus */
        status: {
            type: Object,
            required: true,
        },
    },
    emits: [ "changed" ],
    data() {
        return {
            busy: false,
            job: null,
            pollTimer: null,
            showPlan: false,
            planKind: "",
            plan: null,
            planError: "",
            planArgs: null,
            adoptName: "",
            confirmText: "",
        };
    },
    computed: {
        volumes() {
            return this.storage.volumes.filter((volume) => !volume.isStackFolder);
        },
        canConvertStack() {
            return !this.storage.isDataset && this.status.canCreate && this.status.stacksIsDatasetRoot && !this.job;
        },
        planTitle() {
            return {
                convert: this.$t("convertButton"),
                adopt: this.$t("adoptButton"),
                deleteBackup: this.$t("deleteBackupTitle"),
            }[this.planKind] ?? "";
        },
    },
    watch: {
        "storage.job": {
            handler(value) {
                if (value && (!this.job || this.job.id !== value.id)) {
                    this.follow(value.id);
                }
            },
            immediate: true,
        },
    },
    unmounted() {
        clearTimeout(this.pollTimer);
    },
    methods: {
        formatBytes,

        canConvertVolume(volume) {
            return this.storage.canCreateDatasets && volume.location === "stack" && volume.kind === "directory" && volume.zfs && !this.job;
        },
        canAdopt(volume) {
            return this.storage.canCreateDatasets && volume.location === "external" && volume.kind === "dataset" && !this.job;
        },
        kindText(volume) {
            if (volume.location === "otherStack") {
                return this.$t("storageLabelOtherStack", [ volume.otherStack ]);
            }
            return {
                dataset: volume.location === "external" ? this.$t("storageLabelExternalDataset") : this.$t("storageLabelDataset"),
                directory: this.$t("storageLabelDirectory"),
                file: this.$t("storageLabelFile"),
                missing: this.$t("storageLabelMissing"),
                notVisible: this.$t("storageLabelNotVisible"),
                unresolved: "?",
            }[volume.kind] ?? volume.kind;
        },
        kindClass(volume) {
            if (volume.kind === "dataset") {
                return volume.location === "external" ? "bg-primary" : "bg-success";
            }
            return volume.kind === "missing" ? "bg-warning text-dark" : "bg-secondary";
        },

        openConvert(relative) {
            this.planKind = "convert";
            this.planArgs = relative;
            this.plan = null;
            this.planError = "";
            this.showPlan = true;
            this.$root.emitAgent(this.endpoint, "convertToDataset", this.stackName, relative ?? "", true, (res) => {
                if (res.ok) {
                    this.plan = res;
                } else {
                    this.planError = res.msg;
                }
            });
        },

        openAdopt(volume) {
            this.planKind = "adopt";
            this.planArgs = volume;
            this.adoptName = (volume.dataset ?? "").split("/").pop();
            this.plan = null;
            this.planError = "";
            this.showPlan = true;
            this.loadAdoptPlan();
        },

        loadAdoptPlan() {
            this.plan = null;
            this.planError = "";
            this.$root.emitAgent(this.endpoint, "adoptDataset", this.stackName, this.planArgs.dataset, "./" + this.adoptName, true, (res) => {
                if (res.ok) {
                    this.plan = res;
                } else {
                    this.planError = res.msg;
                }
            });
        },

        askDeleteBackup(backup) {
            this.planKind = "deleteBackup";
            this.plan = null;
            this.planError = "";
            this.confirmText = "";
            this.showPlan = true;
            this.$root.emitAgent(this.endpoint, "deleteMigrationBackup", this.stackName, backup.name, { dryRun: true }, (res) => {
                if (res.ok) {
                    this.plan = res;
                } else {
                    this.planError = res.msg;
                }
            });
        },

        runPlan() {
            this.busy = true;
            const done = (res) => {
                this.busy = false;
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                if (res.job) {
                    this.follow(res.job);
                } else {
                    this.$root.toastRes({
                        ok: true,
                        msg: "Saved",
                        msgi18n: true,
                    });
                    this.$emit("changed");
                }
            };
            if (this.planKind === "convert") {
                this.$root.emitAgent(this.endpoint, "convertToDataset", this.stackName, this.planArgs ?? "", false, done);
            } else if (this.planKind === "adopt") {
                this.$root.emitAgent(this.endpoint, "adoptDataset", this.stackName, this.planArgs.dataset, "./" + this.adoptName, false, done);
            } else if (this.planKind === "deleteBackup") {
                this.$root.emitAgent(this.endpoint, "deleteMigrationBackup", this.stackName, this.plan.backup, {}, done);
            }
        },

        /**
         * Follow a job until it ends
         * @param {string} id Job id
         * @returns {void}
         */
        follow(id) {
            clearTimeout(this.pollTimer);
            this.$root.emitAgent(this.endpoint, "getZfsJob", id, (res) => {
                if (!res.ok) {
                    this.job = null;
                    return;
                }
                this.job = res.job;
                if (res.job.state === "running") {
                    this.pollTimer = setTimeout(() => this.follow(id), 1500);
                    return;
                }
                if (res.job.state === "done") {
                    this.$root.toastRes({
                        ok: true,
                        msg: "zfsJobDone",
                        msgi18n: true,
                    });
                    this.job = null;
                } else {
                    this.$root.toastError(res.job.error || res.job.state);
                    setTimeout(() => {
                        this.job = null;
                    }, 15000);
                }
                this.$emit("changed");
            });
        },

        cancel() {
            this.$root.emitAgent(this.endpoint, "cancelZfsJob", this.job.id, (res) => {
                if (res.ok) {
                    this.job = res.job;
                }
            });
        },

        abort(relative) {
            if (!window.confirm(this.$t("conversionAbortConfirm"))) {
                return;
            }
            this.busy = true;
            this.$root.emitAgent(this.endpoint, "abortConversion", this.stackName, relative ?? "", (res) => {
                this.busy = false;
                this.$root.toastRes(res);
                this.$emit("changed");
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.path {
    word-break: break-all;
}

.progress {
    height: 8px;
}
</style>
