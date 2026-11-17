<template>
    <div>
        <h4 class="mb-3">{{ $t("snapshots") }}</h4>
        <div class="shadow-box big-padding mb-3">
            <!-- New snapshot -->
            <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
                <input v-model="label" class="form-control form-control-sm label-input" :placeholder="$t('snapshotLabel')" :disabled="busy" @keyup.enter="create" />
                <button class="btn btn-primary btn-sm" :disabled="busy" @click="create">
                    <font-awesome-icon icon="camera" class="me-1" />
                    {{ $t("snapshotCreate") }}
                </button>
            </div>
            <div class="form-check mb-3">
                <input id="snapshot-stop-first" v-model="stopFirst" class="form-check-input" type="checkbox" :disabled="busy">
                <label class="form-check-label small" for="snapshot-stop-first">{{ $t("snapshotStopFirst") }}</label>
            </div>

            <div v-if="error" class="alert alert-danger py-2 small rounded-3">{{ error }}</div>
            <div v-if="loading && snapshots.length === 0" class="text-muted small">{{ $t("storageLoading") }}</div>
            <div v-else-if="snapshots.length === 0" class="text-muted small">{{ $t("snapshotNone") }}</div>

            <ul v-else class="list-group snapshot-list">
                <li v-for="snapshot in snapshots" :key="snapshot.id" class="list-group-item">
                    <div class="d-flex align-items-center flex-wrap gap-2">
                        <span class="date">{{ formatDate(snapshot.created) }}</span>
                        <span class="badge" :class="kindClass(snapshot.kind)">{{ $t("snapshotKind_" + snapshot.kind) }}</span>
                        <span v-if="snapshot.label" class="badge bg-secondary">{{ snapshot.label }}</span>
                        <span v-if="!snapshot.complete" class="badge bg-warning text-dark" :title="$t('snapshotIncompleteHint')">{{ $t("snapshotIncomplete") }}</span>
                        <span v-if="snapshot.used !== null" class="text-muted small ms-auto">{{ formatBytes(snapshot.used) }}</span>
                    </div>
                    <div class="d-flex align-items-center flex-wrap gap-2 mt-1">
                        <code class="name">{{ snapshot.name }}</code>
                        <div class="ms-auto btn-group btn-group-sm">
                            <button class="btn btn-normal" :disabled="busy" :title="$t('snapshotRollbackHint')" @click="openAction('rollback', snapshot)">{{ $t("snapshotRollback") }}</button>
                            <button class="btn btn-normal" :disabled="busy" :title="$t('snapshotCloneHint')" @click="openAction('clone', snapshot)">{{ $t("snapshotClone") }}</button>
                            <button class="btn btn-normal text-danger" :disabled="busy" @click="openAction('delete', snapshot)">
                                <font-awesome-icon icon="trash" />
                            </button>
                        </div>
                    </div>
                </li>
            </ul>
            <div class="form-text mt-2">{{ $t("snapshotFootnote") }}</div>
        </div>

        <!-- Rollback / clone / delete -->
        <BModal
            v-model="showAction"
            :title="actionTitle"
            :okTitle="actionTitle"
            :okVariant="action === 'clone' ? 'primary' : 'danger'"
            :cancelTitle="$t('cancel')"
            :okDisabled="!actionReady || busy"
            @ok="runAction"
        >
            <template v-if="target">
                <p><code>{{ target.name }}</code> — {{ formatDate(target.created) }}</p>

                <template v-if="action === 'rollback'">
                    <p>{{ $t("snapshotRollbackIntro") }}</p>
                    <div v-if="newerThanTarget.length > 0" class="alert alert-danger small rounded-3">
                        <div class="fw-bold">{{ $tc("snapshotRollbackDestroys", newerThanTarget.length) }}</div>
                        <div v-for="item in newerThanTarget" :key="item.id"><code>{{ item.name }}</code></div>
                    </div>
                    <div v-if="!target.complete" class="alert alert-warning small rounded-3">{{ $t("snapshotIncompleteHint") }}</div>
                </template>

                <template v-if="action === 'clone'">
                    <p>{{ $t("snapshotCloneIntro") }}</p>
                    <label class="form-label" for="clone-name">{{ $t("snapshotCloneName") }}</label>
                    <input id="clone-name" v-model="cloneName" class="form-control" :placeholder="`${stackName}-test`" />
                    <div class="form-text">{{ $t("snapshotCloneNote") }}</div>
                </template>

                <template v-if="action === 'delete'">
                    <p>{{ $t("snapshotDeleteIntro") }}</p>
                </template>

                <template v-if="action !== 'clone'">
                    <label class="form-label mt-2" for="snapshot-confirm">{{ $t("snapshotTypeName") }}</label>
                    <input id="snapshot-confirm" v-model="confirmText" class="form-control" autocomplete="off" />
                </template>
            </template>
        </BModal>
    </div>
</template>

<script>
import { BModal } from "bootstrap-vue-next";
import { formatBytes } from "../util-frontend";

/**
 * Snapshots of a stack that is a ZFS dataset: create, roll back, clone as a new stack, delete
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
    },
    emits: [ "rolled-back" ],
    data() {
        return {
            loading: false,
            busy: false,
            error: "",
            snapshots: [],
            label: "",
            stopFirst: false,
            showAction: false,
            action: "",
            target: null,
            confirmText: "",
            cloneName: "",
        };
    },
    computed: {
        actionTitle() {
            return {
                rollback: this.$t("snapshotRollback"),
                clone: this.$t("snapshotClone"),
                delete: this.$t("snapshotDelete"),
            }[this.action] ?? "";
        },
        newerThanTarget() {
            if (!this.target) {
                return [];
            }
            return this.snapshots.filter((item) => (item.created ?? 0) > (this.target.created ?? 0));
        },
        actionReady() {
            if (this.action === "clone") {
                return /^[a-z0-9_-]+$/.test(this.cloneName);
            }
            return this.target && this.confirmText === this.target.name;
        },
    },
    watch: {
        stackName() {
            this.load();
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        formatBytes,

        formatDate(value) {
            return value ? new Date(value).toLocaleString() : "-";
        },

        kindClass(kind) {
            return {
                manual: "bg-primary",
                auto: "bg-info text-dark",
                other: "bg-light text-dark",
            }[kind];
        },

        load() {
            this.loading = true;
            this.$root.emitAgent(this.endpoint, "listSnapshots", this.stackName, (res) => {
                this.loading = false;
                if (res.ok) {
                    this.snapshots = res.snapshots;
                    this.error = "";
                } else {
                    this.error = res.msg;
                }
            });
        },

        create() {
            this.busy = true;
            this.$root.emitAgent(this.endpoint, "createSnapshot", this.stackName, {
                label: this.label,
                stopFirst: this.stopFirst,
            }, (res) => {
                this.busy = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.label = "";
                    this.load();
                }
            });
        },

        openAction(action, snapshot) {
            this.action = action;
            this.target = snapshot;
            this.confirmText = "";
            this.cloneName = `${this.stackName}-${(snapshot.label || "clone")}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
            this.showAction = true;
        },

        runAction() {
            const target = this.target;
            const action = this.action;
            this.busy = true;
            const done = (res) => {
                this.busy = false;
                this.$root.toastRes(res);
                if (res.ok && Array.isArray(res.warnings)) {
                    for (const warning of res.warnings) {
                        this.$root.toastError(warning);
                    }
                }
                this.load();
                if (res.ok && action === "rollback") {
                    // compose.yaml and .env changed
                    this.$emit("rolled-back");
                }
                if (res.ok && action === "clone") {
                    this.$router.push(this.endpoint ? `/compose/${res.name}/${this.endpoint}` : `/compose/${res.name}`);
                }
            };
            if (action === "rollback") {
                this.$root.emitAgent(this.endpoint, "rollbackSnapshot", this.stackName, target.name, this.confirmText, done);
            } else if (action === "delete") {
                this.$root.emitAgent(this.endpoint, "deleteSnapshot", this.stackName, target.name, this.confirmText, done);
            } else if (action === "clone") {
                this.$root.emitAgent(this.endpoint, "cloneStack", this.stackName, target.name, this.cloneName, done);
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.label-input {
    flex: 1;
    min-width: 160px;
}

.snapshot-list {
    max-height: 420px;
    overflow-y: auto;
}

.date {
    font-weight: 600;
}

.name {
    font-size: 12px;
    word-break: break-all;
}
</style>
