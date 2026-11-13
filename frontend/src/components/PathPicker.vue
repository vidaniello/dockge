<template>
    <BModal
        v-model="show"
        :title="$t('pickHostPath')"
        :okTitle="$t('useThisPath')"
        :cancelTitle="$t('cancel')"
        :okDisabled="!selectedPath"
        size="lg"
        scrollable
        @ok="confirm"
    >
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
    </BModal>
</template>

<script>
import { BModal } from "bootstrap-vue-next";

const LAST_PATH_KEY = "dockge.pathPicker.lastPath";

/**
 * Dialog to browse the host folders mounted into Dockge and pick one.
 * Usage: this.$refs.picker.open(currentPath).then(path => ...)  (resolves to null when cancelled)
 */
export default {
    components: {
        BModal,
    },
    props: {
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
        };
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
        open(startPath = "") {
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
