<template>
    <BModal
        v-model="show"
        :title="stackTab ? $t('pickPath') : $t('pickHostPath')"
        :okTitle="$t('useThisPath')"
        :cancelTitle="$t('cancel')"
        :okDisabled="tab === 'stack' ? !stackResult : !selectedPath"
        size="lg"
        scrollable
        @ok="confirm"
    >
        <!-- Tabs: data of this stack (./name) or a folder of the host -->
        <ul v-if="stackTab" class="nav nav-pills mb-3">
            <li class="nav-item">
                <button type="button" class="nav-link" :class="{ active: tab === 'stack' }" @click="tab = 'stack'">{{ $t("pickerTabStack") }}</button>
            </li>
            <li class="nav-item">
                <button type="button" class="nav-link" :class="{ active: tab === 'host' }" @click="tab = 'host'">{{ $t("pickerTabHost") }}</button>
            </li>
        </ul>

        <div v-if="tab === 'stack'">
            <div class="list-group entry-list mb-3">
                <button
                    v-for="entry in stackEntries"
                    :key="entry.path"
                    type="button"
                    class="list-group-item list-group-item-action entry"
                    :class="{ active: stackSelected === entry.path && !newName }"
                    @click="stackSelected = entry.path; newName = ''"
                    @dblclick="stackSelected = entry.path; newName = ''; confirm()"
                >
                    <font-awesome-icon icon="folder" class="me-2 icon" />
                    <span class="name">{{ entry.path }}</span>
                    <span v-if="entry.dataset" class="badge bg-success ms-2" :title="entry.dataset">{{ $t("storageLabelDataset") }}</span>
                    <span v-else class="badge bg-secondary ms-2">{{ $t("storageLabelDirectory") }}</span>
                </button>
                <div v-if="!loading && stackEntries.length === 0" class="text-muted p-2">{{ $t("pickerStackEmpty") }}</div>
            </div>

            <h6>{{ $t("pickerNewVolume") }}</h6>
            <div class="row g-2 align-items-end">
                <div class="col-sm-4">
                    <label class="form-label small mb-1" for="picker-new-name">{{ $t("pickerNewVolumeName") }}</label>
                    <div class="input-group input-group-sm">
                        <span class="input-group-text">./</span>
                        <input id="picker-new-name" v-model="newName" class="form-control" placeholder="data" @input="stackSelected = ''" />
                    </div>
                </div>
                <div v-if="stackIsZfs" class="col-sm-4">
                    <label class="form-label small mb-1" for="picker-new-preset">{{ $t("pickerPreset") }}</label>
                    <select id="picker-new-preset" v-model="newPreset" class="form-select form-select-sm">
                        <option value="generic">{{ $t("pickerPresetGeneric") }}</option>
                        <option value="database">{{ $t("pickerPresetDatabase") }}</option>
                        <option value="large">{{ $t("pickerPresetLarge") }}</option>
                    </select>
                </div>
                <div class="col-sm-4">
                    <label class="form-label small mb-1" for="picker-new-owner">{{ $t("missingVolumesOwner") }}</label>
                    <input id="picker-new-owner" v-model="newOwner" class="form-control form-control-sm" placeholder="root" />
                </div>
            </div>
            <div v-if="newNameError" class="form-text text-danger">{{ newNameError }}</div>
            <div v-else class="form-text">{{ stackIsZfs ? $t("pickerNewVolumeHintZfs") : $t("pickerNewVolumeHint") }}</div>
        </div>

        <div v-show="tab === 'host'">
            <!-- Breadcrumb -->
            <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
                <button type="button" class="btn btn-sm btn-normal" :disabled="loading || listing.path === ''" @click="load('')">
                    <font-awesome-icon icon="home" />
                </button>
                <button type="button" class="btn btn-sm btn-normal" :disabled="loading || !listing.parent" @click="load(listing.parent)">
                    ..
                </button>
                <input
                    v-model="manualPath"
                    class="form-control form-control-sm path-input"
                    :placeholder="$t('pickHostPathPlaceholder')"
                    @keyup.enter="load(manualPath)"
                />
            </div>

            <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
            <div v-if="listing.remoteError" class="form-text text-warning mb-2">{{ $t("pickerRemoteError", [ listing.remoteError ]) }}</div>
            <div v-else-if="listing.source === 'truenas'" class="form-text mb-2">{{ $t("pickerSourceTrueNas") }}</div>

            <div v-if="!loading && listing.path === '' && listing.entries.length === 0" class="alert alert-warning">
                {{ $t("pickHostPathNoRoots") }}
            </div>

            <div class="list-group entry-list">
                <button
                    v-for="entry in listing.entries"
                    :key="entry.path"
                    type="button"
                    class="list-group-item list-group-item-action entry"
                    :class="{ active: selectedPath === entry.path }"
                    @click="selectedPath = entry.path"
                    @dblclick="entry.isDirectory ? load(entry.path) : confirmPath(entry.path)"
                >
                    <font-awesome-icon :icon="entry.isDirectory ? 'folder' : 'file'" class="me-2 icon" />
                    <span class="name">{{ listing.path === "" ? entry.path : entry.name }}</span>
                    <span v-if="entry.dataset" class="badge bg-success ms-2" :title="$t('storageLabelDataset')">{{ entry.dataset }}</span>
                    <span v-if="entry.stack && entry.stack === currentStack" class="badge bg-info text-dark ms-2" :title="$t('storagePickerThisStackHint')">{{ $t("storagePickerThisStack") }}</span>
                    <span v-else-if="entry.stack" class="badge bg-warning text-dark ms-2" :title="$t('storagePickerStackHint')">{{ $t("storagePickerStack", [ entry.stack ]) }}</span>
                    <font-awesome-icon v-if="entry.isDirectory" icon="chevron-right" class="ms-auto open" @click.stop="load(entry.path)" />
                </button>
                <div v-if="!loading && listing.path !== '' && listing.entries.length === 0" class="text-muted p-2">
                    {{ $t("pickHostPathEmpty") }}
                </div>
            </div>

            <div class="form-check mt-3">
                <input id="path-picker-files" v-model="showFiles" class="form-check-input" type="checkbox" @change="load(listing.path)">
                <label class="form-check-label" for="path-picker-files">{{ $t("pickHostPathShowFiles") }}</label>
            </div>

            <div class="mt-2 selected">
                {{ $t("pickHostPathSelected") }} <code>{{ selectedPath || "-" }}</code>
            </div>
        </div>
    </BModal>
</template>

<script>
import { BModal } from "bootstrap-vue-next";

const LAST_PATH_KEY = "dockge.pathPicker.lastPath";

/**
 * Dialog to browse the host folders mounted into Dockge and pick one.
 * Usage: this.$refs.picker.open(currentPath).then(path => ...)  (resolves to null when cancelled)
 *
 * With options.stackTab, a first tab offers the folders of the stack and a new volume: it resolves to
 * { relative: "./name", recipe? : { recordsize?, owner? } } instead of a string.
 */

const PRESETS = {
    generic: {},
    database: { recordsize: "16K" },
    large: { recordsize: "1M" },
};
export default {
    components: {
        BModal,
    },
    props: {
        /** Stack being edited: its own folders are marked "this stack" (and inserted as ./relative by the caller) */
        currentStack: {
            type: String,
            default: "",
        },
        /** Dockge agent endpoint, "" for the current instance */
        endpoint: {
            type: String,
            default: "",
        },
    },
    data() {
        return {
            show: false,
            loading: false,
            error: "",
            listing: {
                path: "",
                parent: null,
                entries: [],
            },
            manualPath: "",
            selectedPath: "",
            showFiles: false,
            resolver: null,
            stackTab: false,
            stackIsZfs: false,
            tab: "host",
            stackEntries: [],
            stackSelected: "",
            newName: "",
            newPreset: "generic",
            newOwner: "",
        };
    },
    computed: {
        newNameError() {
            const name = this.newName.trim().replace(/^\.\//, "");
            if (!name) {
                return "";
            }
            if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(name)) {
                return this.$t("pickerNewVolumeInvalid");
            }
            if (this.stackEntries.some((entry) => entry.path === "./" + name)) {
                return this.$t("pickerNewVolumeExists");
            }
            if (this.newOwner.trim() && !/^\d{1,10}(:\d{1,10})?$/.test(this.newOwner.trim())) {
                return this.$t("missingVolumesOwnerInvalid");
            }
            return "";
        },

        /** What the "stack" tab would return, null when nothing valid is chosen */
        stackResult() {
            const name = this.newName.trim().replace(/^\.\//, "");
            if (name) {
                if (this.newNameError) {
                    return null;
                }
                const recipe = {
                    ...(this.stackIsZfs ? PRESETS[this.newPreset] : {}),
                    ...(this.newOwner.trim() ? { owner: this.newOwner.trim() } : {}),
                };
                return {
                    relative: "./" + name,
                    recipe: Object.keys(recipe).length > 0 ? recipe : undefined,
                };
            }
            if (this.stackSelected) {
                return {
                    relative: this.stackSelected,
                };
            }
            return null;
        },
    },
    watch: {
        show(value) {
            // Closed without confirming
            if (!value && this.resolver) {
                this.resolver(null);
                this.resolver = null;
            }
        },
    },
    methods: {
        /**
         * Open the dialog
         * @param {string} startPath Path to start from (e.g. the current value of the field)
         * @returns {Promise<string|null>} The chosen path, or null
         */
        open(startPath = "", options = {}) {
            this.stackTab = options.stackTab === true && !!this.currentStack;
            this.stackIsZfs = options.zfs === true;
            this.tab = this.stackTab && (!startPath || startPath.startsWith(".")) ? "stack" : "host";
            this.stackEntries = [];
            this.stackSelected = "";
            this.newName = "";
            this.newPreset = "generic";
            this.newOwner = options.suggestedOwner ?? "";
            if (this.stackTab) {
                this.$root.emitAgent(this.endpoint, "listStackFolder", this.currentStack, (res) => {
                    if (res.ok) {
                        this.stackEntries = res.entries;
                        this.stackIsZfs = this.stackIsZfs || res.isDataset;
                    }
                });
            }

            let initial = startPath;
            if (!initial || !initial.startsWith("/")) {
                try {
                    initial = window.localStorage.getItem(LAST_PATH_KEY) || "";
                } catch (e) {
                    initial = "";
                }
            }

            this.error = "";
            this.selectedPath = "";
            this.show = true;
            this.load(initial, true);

            return new Promise((resolve) => {
                this.resolver = resolve;
            });
        },

        /**
         * Load a folder
         * @param {string} dirPath Folder, "" for the roots
         * @param {boolean} fallbackToRoots When the folder cannot be read, show the roots
         * @returns {void}
         */
        load(dirPath, fallbackToRoots = false) {
            this.loading = true;
            this.error = "";

            this.$root.emitAgent(this.endpoint, "listDirectory", dirPath || "", this.showFiles, (res) => {
                this.loading = false;

                if (!res.ok) {
                    if (fallbackToRoots && dirPath) {
                        this.load("");
                        return;
                    }
                    this.error = res.msg;
                    return;
                }

                this.listing = res;
                this.manualPath = res.path;
                this.selectedPath = res.path;
            });
        },

        confirm() {
            if (this.tab === "stack") {
                if (this.stackResult && this.resolver) {
                    this.resolver(this.stackResult);
                    this.resolver = null;
                }
                this.show = false;
                return;
            }
            this.confirmPath(this.selectedPath);
        },

        confirmPath(selected) {
            if (!selected) {
                return;
            }

            try {
                window.localStorage.setItem(LAST_PATH_KEY, this.listing.path || selected);
            } catch (e) {
                // ignore
            }

            if (this.resolver) {
                this.resolver(selected);
                this.resolver = null;
            }
            this.show = false;
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.path-input {
    flex: 1;
    min-width: 200px;
    font-family: 'JetBrains Mono', monospace;
}

.entry-list {
    max-height: 50vh;
    overflow-y: auto;
}

.entry {
    display: flex;
    align-items: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    user-select: none;

    .icon {
        color: $warning;
    }

    .open {
        opacity: 0.5;

        &:hover {
            opacity: 1;
        }
    }

    &.active {
        background-color: rgba($primary, 0.25);
        border-color: $primary;
        color: inherit;
    }
}

.selected {
    font-size: 14px;
}
</style>
