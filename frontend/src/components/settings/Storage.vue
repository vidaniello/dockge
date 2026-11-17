<template>
    <div class="my-4">
        <div v-if="$root.agentCount > 1" class="mb-4">
            <label class="form-label" for="storage-endpoint">{{ $t("dockgeAgent") }}</label>
            <select id="storage-endpoint" v-model="endpoint" class="form-select" @change="load">
                <option v-for="(agent, agentEndpoint) in $root.agentList" :key="agentEndpoint" :value="agentEndpoint" :disabled="$root.agentStatusList[agentEndpoint] != 'online'">
                    {{ (agent.name !== '') ? agent.name : agent.url || $t("Current") }}
                </option>
            </select>
        </div>

        <div v-if="loading" class="text-muted">{{ $t("storageLoading") }}</div>
        <div v-else-if="error" class="alert alert-danger">{{ error }}</div>

        <template v-else-if="status">
            <table class="table storage-table">
                <tbody>
                    <tr>
                        <th>{{ $t("storageStacksDir") }}</th>
                        <td><code>{{ status.stacksDir }}</code></td>
                    </tr>
                    <tr>
                        <th>{{ $t("storageFilesystem") }}</th>
                        <td>
                            <span v-if="status.zfs" class="badge bg-primary">ZFS</span>
                            <span v-else>{{ status.filesystem || "-" }}</span>
                        </td>
                    </tr>
                    <tr v-if="status.zfs">
                        <th>{{ $t("storageDataset") }}</th>
                        <td>
                            <code>{{ status.dataset }}</code>
                            <span v-if="status.stacksIsDatasetRoot" class="badge bg-success ms-2">{{ $t("storageDatasetRoot") }}</span>
                            <span v-else class="badge bg-warning text-dark ms-2">{{ $t("storageDatasetSubfolder") }}</span>
                        </td>
                    </tr>
                    <tr v-if="status.zfs && status.inContainer">
                        <th>{{ $t("storagePropagation") }}</th>
                        <td>
                            <code>{{ status.propagation }}</code>
                            <span v-if="status.propagation === 'private'" class="badge bg-warning text-dark ms-2">{{ $t("storageNotPropagated") }}</span>
                        </td>
                    </tr>
                    <tr>
                        <th>{{ $t("storageHost") }}</th>
                        <td>
                            <span v-if="status.host.truenas" class="badge bg-info text-dark me-2">TrueNAS</span>
                            <span class="text-muted">{{ status.host.operatingSystem || "" }} {{ status.host.kernelVersion || "" }}</span>
                        </td>
                    </tr>
                    <tr v-if="status.space">
                        <th>{{ $t("storageSpace") }}</th>
                        <td>{{ $t("storageSpaceValue", [ formatBytes(status.space.available), formatBytes(status.space.total) ]) }}</td>
                    </tr>
                </tbody>
            </table>

            <div v-if="!status.zfs" class="alert alert-secondary">{{ $t("storageNotZfs") }}</div>
            <div v-else-if="status.canCreate" class="alert alert-success">{{ $t("storageCanCreate", [ status.providerUser ]) }}</div>
            <div v-else-if="status.ready" class="alert alert-secondary">{{ $t("storageReady") }}</div>

            <div v-for="problem in status.problems" :key="problem.code" class="alert" :class="problemClass(problem)">
                <div class="fw-bold mb-1">{{ problemText(problem, "storageProblem") }}</div>
                <div class="remedy">{{ problemText(problem, "storageRemedy") }}</div>
                <pre v-if="problem.code === 'mountPropagationPrivate'" class="mt-2 mb-0 snippet">{{ propagationSnippet }}</pre>
                <template v-if="problem.code === 'truenasCertificate' && problem.params.fingerprint">
                    <div class="mt-2 small">{{ $t("truenasFingerprint") }}</div>
                    <code class="fingerprint">{{ problem.params.fingerprint }}</code>
                    <div class="mt-2">
                        <button class="btn btn-sm btn-primary" :disabled="saving" @click="save({ truenasFingerprint: problem.params.fingerprint })">
                            {{ $t("truenasTrustCertificate") }}
                        </button>
                    </div>
                </template>
            </div>

            <!-- TrueNAS API -->
            <template v-if="status.zfs && status.stacksIsDatasetRoot && settings">
                <h5 class="mt-4 mb-3">{{ $t("truenasApi") }}</h5>
                <div class="mb-3">
                    <label class="form-label" for="truenas-url">{{ $t("truenasUrl") }}</label>
                    <input id="truenas-url" v-model="form.truenasUrl" class="form-control" placeholder="wss://192.168.1.10/api/current" autocomplete="off" />
                    <div class="form-text">{{ $t("truenasUrlHint") }}</div>
                </div>
                <div class="row g-3 mb-3">
                    <div class="col-md-5">
                        <label class="form-label" for="truenas-user">{{ $t("truenasUser") }}</label>
                        <input id="truenas-user" v-model="form.truenasUsername" class="form-control" placeholder="dockge" autocomplete="off" />
                    </div>
                    <div class="col-md-7">
                        <label class="form-label" for="truenas-key">{{ $t("truenasApiKey") }}</label>
                        <input
                            id="truenas-key"
                            v-model="form.truenasApiKey"
                            type="password"
                            class="form-control"
                            :placeholder="settings.truenasApiKeySet ? $t('truenasApiKeySaved') : ''"
                            autocomplete="new-password"
                        />
                    </div>
                </div>
                <div class="form-text mb-3">{{ $t("truenasRolesHint") }}</div>
                <div v-if="settings.truenasFingerprint" class="mb-3 small">
                    {{ $t("truenasTrustedFingerprint") }} <code class="fingerprint">{{ settings.truenasFingerprint }}</code>
                    <button class="btn btn-sm btn-link" :disabled="saving" @click="save({ truenasFingerprint: '' })">{{ $t("truenasForgetFingerprint") }}</button>
                </div>
                <div class="d-flex gap-2 flex-wrap">
                    <button class="btn btn-primary btn-sm" :disabled="saving" @click="saveConnection">
                        {{ $t("truenasSaveAndTest") }}
                    </button>
                    <button v-if="settings.truenasApiKeySet" class="btn btn-normal btn-sm" :disabled="saving" @click="save({ truenasApiKey: null })">
                        {{ $t("truenasRemoveKey") }}
                    </button>
                </div>

                <!-- Behaviour -->
                <h5 class="mt-4 mb-3">{{ $t("zfsBehaviour") }}</h5>
                <div class="form-check mb-3">
                    <input id="new-stacks-dataset" v-model="form.newStacksAsDatasets" class="form-check-input" type="checkbox" :disabled="saving" @change="save({ newStacksAsDatasets: form.newStacksAsDatasets })">
                    <label class="form-check-label" for="new-stacks-dataset">{{ $t("zfsNewStacksAsDatasets") }}</label>
                </div>
                <div class="mb-3">
                    <label class="form-label" for="missing-volumes">{{ $t("zfsMissingVolumes") }}</label>
                    <select id="missing-volumes" v-model="form.missingVolumes" class="form-select" :disabled="saving" @change="save({ missingVolumes: form.missingVolumes })">
                        <option value="ask">{{ $t("zfsMissingVolumesAsk") }}</option>
                        <option value="dataset">{{ $t("zfsMissingVolumesDataset") }}</option>
                        <option value="directory">{{ $t("zfsMissingVolumesDirectory") }}</option>
                    </select>
                    <div class="form-text">{{ $t("zfsMissingVolumesHint") }}</div>
                </div>

                <!-- Snapshots -->
                <h5 class="mt-4 mb-3">{{ $t("snapshots") }}</h5>
                <div class="form-check mb-2">
                    <input id="auto-snapshot" v-model="form.autoSnapshotBeforeUpdate" class="form-check-input" type="checkbox" :disabled="saving" @change="save({ autoSnapshotBeforeUpdate: form.autoSnapshotBeforeUpdate })">
                    <label class="form-check-label" for="auto-snapshot">{{ $t("zfsAutoSnapshot") }}</label>
                </div>
                <div class="mb-3 d-flex align-items-center gap-2">
                    <label class="form-label mb-0" for="auto-snapshot-keep">{{ $t("zfsAutoSnapshotKeep") }}</label>
                    <input id="auto-snapshot-keep" v-model.number="form.autoSnapshotKeep" type="number" min="1" max="100" class="form-control keep-input" :disabled="saving || !form.autoSnapshotBeforeUpdate" @change="save({ autoSnapshotKeep: form.autoSnapshotKeep })">
                </div>
                <div class="form-check mb-2">
                    <input id="destructive-api" v-model="form.destructiveApi" class="form-check-input" type="checkbox" :disabled="saving" @change="save({ destructiveApi: form.destructiveApi })">
                    <label class="form-check-label" for="destructive-api">{{ $t("zfsDestructiveApi") }}</label>
                </div>
                <div class="form-text">{{ $t("zfsSnapshotRolesHint") }}</div>
            </template>
        </template>

        <button class="btn btn-normal btn-sm mt-3" :disabled="loading" @click="load(true)">
            <font-awesome-icon icon="arrows-rotate" class="me-1" />
            {{ $t("storageRefresh") }}
        </button>
    </div>
</template>

<script>
import { formatBytes, storageProblemText } from "../../util-frontend";

export default {
    data() {
        return {
            endpoint: "",
            loading: false,
            error: "",
            status: null,
            settings: null,
            saving: false,
            form: {
                truenasUrl: "",
                truenasUsername: "",
                truenasApiKey: "",
                newStacksAsDatasets: true,
                missingVolumes: "ask",
                autoSnapshotBeforeUpdate: true,
                autoSnapshotKeep: 5,
                destructiveApi: false,
            },
        };
    },
    computed: {
        propagationSnippet() {
            const dir = this.status?.stacksDir ?? "<stacks folder>";
            return `volumes:
  - type: bind
    source: ${dir}
    target: ${dir}
    bind:
      propagation: rslave`;
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        formatBytes,

        problemText(problem, prefix) {
            return storageProblemText(this.$t, this.$te, problem, prefix);
        },

        problemClass(problem) {
            if (problem.severity === "error") {
                return "alert-danger";
            }
            return problem.severity === "info" ? "alert-secondary" : "alert-warning";
        },

        /**
         * @param {boolean} refresh Connect to TrueNAS again instead of using the cached check
         * @returns {void}
         */
        load(refresh = false) {
            this.loading = true;
            this.error = "";
            this.$root.emitAgent(this.endpoint, "getStorageStatus", { refresh }, (res) => {
                this.loading = false;
                if (res.ok) {
                    this.status = res.status;
                } else {
                    this.error = res.msg;
                }
            });
            this.$root.emitAgent(this.endpoint, "getZfsSettings", (res) => {
                if (res.ok) {
                    this.applySettings(res.settings);
                }
            });
        },

        applySettings(settings) {
            this.settings = settings;
            this.form = {
                truenasUrl: settings.truenasUrl,
                truenasUsername: settings.truenasUsername,
                truenasApiKey: "",
                newStacksAsDatasets: settings.newStacksAsDatasets,
                missingVolumes: settings.missingVolumes,
                autoSnapshotBeforeUpdate: settings.autoSnapshotBeforeUpdate,
                autoSnapshotKeep: settings.autoSnapshotKeep,
                destructiveApi: settings.destructiveApi,
            };
        },

        saveConnection() {
            this.save({
                truenasUrl: this.form.truenasUrl,
                truenasUsername: this.form.truenasUsername,
                truenasApiKey: this.form.truenasApiKey,
            });
        },

        /**
         * Save some settings; the answer contains the storage status checked again
         * @param {object} changes Settings to change
         * @returns {void}
         */
        save(changes) {
            this.saving = true;
            this.$root.emitAgent(this.endpoint, "setZfsSettings", changes, (res) => {
                this.saving = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.applySettings(res.settings);
                    this.status = res.status;
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../styles/vars.scss";

.storage-table {
    th {
        width: 30%;
        font-weight: 600;
    }

    .dark & {
        color: $dark-font-color;

        th, td {
            background-color: transparent;
            color: inherit;
            border-color: $dark-border-color;
        }
    }
}

// The global $border-radius turns multi-line alerts into ovals (see docs/BACKLOG.md, 8)
.alert {
    border-radius: 10px;
}

.keep-input {
    width: 100px;
}

.fingerprint {
    word-break: break-all;
}

.remedy {
    white-space: pre-line;
}

.snippet {
    white-space: pre;
    overflow-x: auto;
}
</style>
