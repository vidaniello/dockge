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
            <div v-else-if="status.ready" class="alert alert-success">{{ $t("storageReady") }}</div>

            <div v-for="problem in status.problems" :key="problem.code" class="alert" :class="problem.severity === 'error' ? 'alert-danger' : 'alert-warning'">
                <div class="fw-bold mb-1">{{ problemText(problem, "storageProblem") }}</div>
                <div class="remedy">{{ problemText(problem, "storageRemedy") }}</div>
                <pre v-if="problem.code === 'mountPropagationPrivate'" class="mt-2 mb-0 snippet">{{ propagationSnippet }}</pre>
            </div>

            <div class="form-text">{{ $t("storageReadOnlyNote") }}</div>
        </template>

        <button class="btn btn-normal btn-sm mt-3" :disabled="loading" @click="load">
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

        load() {
            this.loading = true;
            this.error = "";
            this.$root.emitAgent(this.endpoint, "getStorageStatus", (res) => {
                this.loading = false;
                if (res.ok) {
                    this.status = res.status;
                } else {
                    this.error = res.msg;
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

.remedy {
    white-space: pre-line;
}

.snippet {
    white-space: pre;
    overflow-x: auto;
}
</style>
