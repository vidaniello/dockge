<template>
    <div>
        <h4 class="mb-3">{{ $t("files") }}</h4>
        <div
            class="shadow-box big-padding mb-3 files-box"
            :class="{ dragging }"
            @dragover.prevent="dragging = writable"
            @dragleave.prevent="dragging = false"
            @drop.prevent="onDrop"
        >
            <!-- Where we are -->
            <div class="d-flex flex-wrap align-items-center gap-1 mb-2">
                <button class="btn btn-sm" :class="isStackPath ? 'btn-primary' : 'btn-normal'" @click="open('.')">
                    <font-awesome-icon icon="folder" class="me-1" />{{ stackName }}
                </button>
                <button
                    v-for="root in roots"
                    :key="root"
                    class="btn btn-sm"
                    :class="current.startsWith(root) ? 'btn-primary' : 'btn-normal'"
                    :title="root"
                    @click="open(root)"
                >
                    <font-awesome-icon icon="hard-drive" class="me-1" />{{ shortName(root) }}
                </button>
            </div>
            <div class="d-flex flex-wrap align-items-center gap-1 mb-2 crumbs">
                <template v-for="(crumb, index) in crumbs" :key="crumb.path">
                    <span v-if="index > 0" class="text-muted">/</span>
                    <a href="#" @click.prevent="open(crumb.path)">{{ crumb.name }}</a>
                </template>
                <span v-if="!writable" class="badge bg-secondary ms-2">{{ $t("filesReadOnly") }}</span>
            </div>

            <!-- Actions -->
            <div class="d-flex flex-wrap gap-1 mb-2">
                <button class="btn btn-sm btn-normal" :disabled="!writable || busy" @click="askName('newFile')">
                    <font-awesome-icon icon="file" class="me-1" />{{ $t("filesNewFile") }}
                </button>
                <button class="btn btn-sm btn-normal" :disabled="!writable || busy" @click="askName('newFolder')">
                    <font-awesome-icon icon="folder-plus" class="me-1" />{{ $t("filesNewFolder") }}
                </button>
                <label class="btn btn-sm btn-normal mb-0" :class="{ disabled: !writable || busy }">
                    <font-awesome-icon icon="upload" class="me-1" />{{ $t("filesUpload") }}
                    <input type="file" multiple hidden :disabled="!writable || busy" @change="onPick">
                </label>
                <button class="btn btn-sm btn-normal ms-auto" :disabled="busy" :title="$t('storageRefresh')" @click="load">
                    <font-awesome-icon icon="arrows-rotate" />
                </button>
            </div>

            <div v-if="uploadText" class="small mb-2">{{ uploadText }}</div>
            <div v-if="error" class="alert alert-danger small py-2 rounded-3">{{ error }}</div>

            <ul class="list-group file-list">
                <li v-if="parentPath !== null" class="list-group-item entry" @click="open(parentPath)">
                    <font-awesome-icon icon="folder" class="me-2 icon" /> ..
                </li>
                <li v-for="entry in entries" :key="entry.path" class="list-group-item entry" @click="activate(entry)">
                    <font-awesome-icon :icon="entry.type === 'directory' ? 'folder' : 'file'" class="me-2 icon" :class="{ link: entry.type === 'symlink' }" />
                    <span class="name">{{ entry.name }}</span>
                    <span v-if="entry.type === 'symlink'" class="text-muted small ms-1">→ {{ entry.target }}</span>
                    <span v-if="entry.dataset" class="badge bg-success ms-2" :title="entry.dataset">{{ $t("storageLabelDataset") }}</span>
                    <span class="ms-auto meta small text-muted">
                        <span v-if="entry.type === 'file'">{{ formatBytes(entry.size) }}</span>
                        <span class="d-none d-md-inline ms-2" :title="`uid ${entry.uid}, gid ${entry.gid}`">{{ entry.mode }} {{ entry.uid }}:{{ entry.gid }}</span>
                    </span>
                    <span class="actions ms-2" @click.stop>
                        <button v-if="entry.type === 'file'" class="btn btn-sm btn-link p-0 me-2" :title="$t('filesDownload')" @click="download(entry)">
                            <font-awesome-icon icon="cloud-arrow-down" />
                        </button>
                        <button v-if="writable" class="btn btn-sm btn-link p-0 me-2" :title="$t('renameStack')" @click="askName('rename', entry)">
                            <font-awesome-icon icon="pen" />
                        </button>
                        <button v-if="writable && !entry.dataset" class="btn btn-sm btn-link p-0 text-danger" :title="$t('filesDelete')" @click="remove(entry)">
                            <font-awesome-icon icon="trash" />
                        </button>
                    </span>
                </li>
                <li v-if="!loading && entries.length === 0" class="list-group-item text-muted small">{{ $t("filesEmpty") }}</li>
            </ul>
            <div class="form-text mt-2">{{ writable ? $t("filesDropHint") : $t("filesReadOnlyHint") }}</div>
        </div>

        <!-- Name of a new file / folder, or new name -->
        <BModal v-model="showName" :title="nameTitle" :okTitle="$t('filesOk')" :cancelTitle="$t('cancel')" :okDisabled="!validName" @ok="confirmName">
            <input ref="nameInput" v-model="nameValue" class="form-control" @keyup.enter="validName && confirmName()" />
            <div class="form-text">{{ $t("filesNameHint") }}</div>
        </BModal>

        <!-- Editor -->
        <BModal v-model="showEditor" :title="editor.path" size="xl" scrollable :hideFooter="true">
            <div class="d-flex flex-wrap align-items-center gap-2 mb-2 small">
                <span v-if="editor.isNew" class="badge bg-info text-dark">{{ $t("filesNew") }}</span>
                <span v-else class="text-muted">{{ formatBytes(editor.size) }}</span>
                <span class="text-muted">{{ $t("filesLineEnding") }}:</span>
                <select v-model="editor.saveLineEnding" class="form-select form-select-sm w-auto">
                    <option value="keep">{{ $t("filesKeep") }}{{ editor.lineEnding && editor.lineEnding !== "none" ? ` (${editor.lineEnding})` : "" }}</option>
                    <option value="lf">LF (Linux)</option>
                    <option value="crlf">CRLF (Windows)</option>
                </select>
                <div class="form-check mb-0">
                    <input id="file-executable" v-model="editor.executable" class="form-check-input" type="checkbox" :disabled="!editor.writable">
                    <label class="form-check-label" for="file-executable">{{ $t("filesExecutable") }}</label>
                </div>
                <span v-if="!editor.writable" class="badge bg-secondary">{{ $t("filesReadOnly") }}</span>
            </div>
            <div v-if="editor.crlfWarning" class="alert alert-warning small py-2 rounded-3">{{ $t("filesCrlfWarning") }}</div>
            <div v-if="editor.bom" class="form-text mb-1">{{ $t("filesBom") }}</div>
            <div class="editor-box">
                <code-mirror v-model="editor.content" :extensions="editorExtensions" :dark="$root.isDark" wrap="true" tab="true" :disabled="!editor.writable" />
            </div>
            <div class="d-flex flex-wrap gap-2 mt-3">
                <button class="btn btn-primary" :disabled="!editor.writable || busy" @click="save(false)">
                    <font-awesome-icon icon="save" class="me-1" />{{ $t("Save") }}
                </button>
                <template v-if="services.length > 0">
                    <select v-model="editor.restartService" class="form-select w-auto">
                        <option v-for="service in services" :key="service" :value="service">{{ service }}</option>
                    </select>
                    <button class="btn btn-normal" :disabled="!editor.writable || busy || !editor.restartService" @click="save(true)">
                        <font-awesome-icon icon="rotate" class="me-1" />{{ $t("filesSaveRestart") }}
                    </button>
                </template>
                <button class="btn btn-normal ms-auto" @click="showEditor = false">{{ $t("filesClose") }}</button>
            </div>
        </BModal>
    </div>
</template>

<script>
import { BModal } from "bootstrap-vue-next";
import CodeMirror from "vue-codemirror6";
import { yaml } from "@codemirror/lang-yaml";
import { python } from "@codemirror/lang-python";
import { lineNumbers } from "@codemirror/view";
import { dracula as editorThemeDark, tomorrow as editorThemeLight } from "thememirror";
import { formatBytes } from "../util-frontend";

const CHUNK = 512 * 1024;
/** Text files where Windows line endings break things (scripts, env files, configuration) */
const LF_FILES = /\.(sh|bash|env|ya?ml|conf|cfg|ini|toml|properties|py|pl|rb|lua)$|^\.env/i;

/**
 * Files of a stack (and of the volumes it mounts with absolute paths): browse, edit, upload, download, rename, delete.
 * Same backend as the API (backend/files.ts).
 */
export default {
    components: {
        BModal,
        CodeMirror,
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
        /** Services of the stack, for "save and restart" */
        services: {
            type: Array,
            default: () => [],
        },
        /** Absolute host folders of the bind mounts outside the stack */
        volumeRoots: {
            type: Array,
            default: () => [],
        },
    },
    data() {
        return {
            current: ".",
            // Volumes usable besides the stack folder, as decided by the server (null until the first answer)
            serverRoots: null,
            entries: [],
            writable: false,
            loading: false,
            busy: false,
            error: "",
            dragging: false,
            uploadText: "",
            showName: false,
            nameMode: "",
            nameTarget: null,
            nameValue: "",
            showEditor: false,
            editor: {
                path: "",
                content: "",
                size: 0,
                isNew: false,
                writable: true,
                lineEnding: null,
                saveLineEnding: "keep",
                executable: false,
                crlfWarning: false,
                bom: false,
                restartService: "",
            },
        };
    },
    computed: {
        roots() {
            return this.serverRoots ?? this.volumeRoots;
        },
        isStackPath() {
            return this.current === "." || this.current.startsWith("./");
        },
        /** Folder of the current path, null at the top of a root */
        parentPath() {
            if (this.current === ".") {
                return null;
            }
            if (this.isStackPath) {
                const parts = this.current.split("/");
                parts.pop();
                return parts.length <= 1 ? "." : parts.join("/");
            }
            if (this.roots.includes(this.current)) {
                return null;
            }
            return this.current.replace(/\/[^/]+$/, "") || "/";
        },
        crumbs() {
            if (this.isStackPath) {
                const parts = this.current === "." ? [] : this.current.slice(2).split("/");
                return [{
                    name: this.stackName,
                    path: ".",
                }, ...parts.map((name, index) => ({
                    name,
                    path: "./" + parts.slice(0, index + 1).join("/"),
                })) ];
            }
            const root = this.roots.find((item) => this.current.startsWith(item)) ?? this.current;
            const rest = this.current.slice(root.length).split("/").filter((part) => part);
            return [{
                name: root,
                path: root,
            }, ...rest.map((name, index) => ({
                name,
                path: root + "/" + rest.slice(0, index + 1).join("/"),
            })) ];
        },
        nameTitle() {
            return {
                newFile: this.$t("filesNewFile"),
                newFolder: this.$t("filesNewFolder"),
                rename: this.$t("renameStack"),
            }[this.nameMode] ?? "";
        },
        validName() {
            const name = this.nameValue.trim();
            return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
        },
        editorExtensions() {
            const extensions = [ this.$root.isDark ? editorThemeDark : editorThemeLight, lineNumbers() ];
            const name = this.editor.path.split("/").pop() ?? "";
            if (/\.ya?ml$/i.test(name)) {
                extensions.push(yaml());
            } else if (/\.(py|sh|bash|env|conf|cfg|ini|toml)$|^\.env/i.test(name)) {
                extensions.push(python());
            }
            return extensions;
        },
    },
    watch: {
        stackName() {
            this.open(".");
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        formatBytes,

        shortName(root) {
            return root.split("/").filter((part) => part).slice(-2).join("/");
        },

        join(name) {
            if (this.current === ".") {
                return "./" + name;
            }
            return this.current.replace(/\/$/, "") + "/" + name;
        },

        emit(event, ...args) {
            return new Promise((resolve) => {
                this.$root.emitAgent(this.endpoint, event, this.stackName, ...args, (res) => resolve(res));
            });
        },

        async open(target) {
            this.current = target;
            await this.load();
        },

        async load() {
            this.loading = true;
            const res = await this.emit("fsList", this.current);
            this.loading = false;
            if (res.ok) {
                this.error = "";
                this.entries = res.result.entries;
                this.writable = res.result.writable;
                this.current = res.result.path;
                if (Array.isArray(res.result.volumeRoots)) {
                    this.serverRoots = res.result.volumeRoots;
                }
            } else {
                this.error = res.msg;
                this.entries = [];
            }
        },

        async activate(entry) {
            if (entry.type === "directory") {
                this.open(entry.path);
                return;
            }
            if (entry.type === "symlink") {
                // A link to a folder is opened, a link to a file is edited
                const res = await this.emit("fsList", entry.path);
                if (res.ok) {
                    this.current = res.result.path;
                    this.entries = res.result.entries;
                    this.writable = res.result.writable;
                    return;
                }
            }
            this.openEditor(entry.path);
        },

        async openEditor(filePath) {
            const res = await this.emit("fsRead", filePath, "utf8");
            if (!res.ok) {
                this.$root.toastRes(res);
                return;
            }
            const file = res.result;
            const name = filePath.split("/").pop();
            const crlf = file.lineEnding === "CRLF" || file.lineEnding === "mixed";
            this.editor = {
                path: file.path,
                content: file.content,
                size: file.size,
                isNew: false,
                writable: file.writable,
                lineEnding: file.lineEnding,
                // Scripts and configuration with Windows line endings: propose LF
                saveLineEnding: crlf && LF_FILES.test(name) ? "lf" : "keep",
                executable: (parseInt(file.mode, 8) & 0o111) !== 0,
                crlfWarning: crlf && LF_FILES.test(name),
                bom: file.bom,
                restartService: this.services[0] ?? "",
            };
            this.showEditor = true;
        },

        async save(restart) {
            this.busy = true;
            const res = await this.emit("fsWrite", this.editor.path, {
                content: this.editor.content,
                lineEnding: this.editor.saveLineEnding,
                executable: this.editor.executable,
                createOnly: this.editor.isNew,
            });
            this.busy = false;
            if (!res.ok) {
                this.$root.toastRes(res);
                return;
            }
            this.editor.isNew = false;
            this.$root.toastRes({
                ok: true,
                msg: "Saved",
                msgi18n: true,
            });
            this.load();
            if (restart && this.editor.restartService) {
                this.$root.emitAgent(this.endpoint, "restartService", this.stackName, this.editor.restartService, (restartRes) => {
                    this.$root.toastRes(restartRes);
                });
            }
        },

        askName(mode, entry = null) {
            this.nameMode = mode;
            this.nameTarget = entry;
            this.nameValue = entry ? entry.name : "";
            this.showName = true;
            this.$nextTick(() => this.$refs.nameInput?.focus());
        },

        async confirmName() {
            this.showName = false;
            const name = this.nameValue.trim();
            if (this.nameMode === "newFolder") {
                const res = await this.emit("fsMkdir", this.join(name));
                this.$root.toastRes(res.ok ? {
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                } : res);
                this.load();
            } else if (this.nameMode === "newFile") {
                this.editor = {
                    path: this.join(name),
                    content: "",
                    size: 0,
                    isNew: true,
                    writable: true,
                    lineEnding: null,
                    saveLineEnding: "lf",
                    executable: /\.sh$/i.test(name),
                    crlfWarning: false,
                    bom: false,
                    restartService: this.services[0] ?? "",
                };
                this.showEditor = true;
            } else if (this.nameMode === "rename" && this.nameTarget && name !== this.nameTarget.name) {
                const res = await this.emit("fsMove", this.nameTarget.path, this.join(name));
                if (!res.ok) {
                    this.$root.toastRes(res);
                }
                this.load();
            }
        },

        async remove(entry) {
            const message = entry.type === "directory" ? this.$t("filesDeleteFolderConfirm", [ entry.path ]) : this.$t("filesDeleteConfirm", [ entry.path ]);
            if (!window.confirm(message)) {
                return;
            }
            const res = await this.emit("fsDelete", entry.path, entry.type === "directory");
            if (!res.ok) {
                this.$root.toastRes(res);
            }
            this.load();
        },

        async download(entry) {
            const res = await this.emit("fsRead", entry.path, "base64");
            if (!res.ok) {
                this.$root.toastRes(res);
                return;
            }
            const bytes = Uint8Array.from(atob(res.result.content), (char) => char.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([ bytes ]));
            const link = document.createElement("a");
            link.href = url;
            link.download = entry.name;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        },

        onPick(event) {
            this.upload([ ...event.target.files ]);
            event.target.value = "";
        },

        onDrop(event) {
            this.dragging = false;
            if (this.writable) {
                this.upload([ ...event.dataTransfer.files ]);
            }
        },

        async upload(files) {
            if (files.length === 0) {
                return;
            }
            this.busy = true;
            for (const file of files) {
                const target = this.join(file.name);
                const exists = this.entries.some((entry) => entry.name === file.name);
                if (exists && !window.confirm(this.$t("filesOverwriteConfirm", [ file.name ]))) {
                    continue;
                }
                const id = (crypto.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, "");
                let offset = 0;
                let failed = false;
                do {
                    const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
                    let binary = "";
                    for (let i = 0; i < chunk.length; i += 0x8000) {
                        binary += String.fromCharCode(...chunk.subarray(i, i + 0x8000));
                    }
                    const last = offset + chunk.length >= file.size;
                    this.uploadText = this.$t("filesUploading", [ file.name, Math.round((offset + chunk.length) / Math.max(1, file.size) * 100) ]);
                    const res = await this.emit("fsUploadChunk", target, id, offset, btoa(binary), last, exists);
                    if (!res.ok) {
                        this.$root.toastRes(res);
                        failed = true;
                        break;
                    }
                    offset += chunk.length;
                } while (offset < file.size);
                if (!failed && LF_FILES.test(file.name) && file.size < 2 * 1024 * 1024) {
                    // Windows line endings in a script or configuration file: propose the conversion
                    const read = await this.emit("fsRead", target, "utf8");
                    if (read.ok && (read.result.lineEnding === "CRLF" || read.result.lineEnding === "mixed") && window.confirm(this.$t("filesConvertConfirm", [ file.name ]))) {
                        const write = await this.emit("fsWrite", target, {
                            content: read.result.content,
                            lineEnding: "lf",
                        });
                        this.$root.toastRes(write.ok ? {
                            ok: true,
                            msg: "Saved",
                            msgi18n: true,
                        } : write);
                    }
                }
            }
            this.uploadText = "";
            this.busy = false;
            this.load();
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.files-box.dragging {
    outline: 2px dashed $primary;
}

.file-list {
    max-height: 420px;
    overflow-y: auto;
}

.entry {
    display: flex;
    align-items: center;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;

    .icon {
        color: $warning;

        &.link {
            opacity: 0.6;
        }
    }

    .name {
        word-break: break-all;
    }

    .actions {
        white-space: nowrap;
    }
}

.crumbs {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    word-break: break-all;
}

.editor-box {
    border-radius: 10px;
    overflow: hidden;
    max-height: 65vh;
    overflow-y: auto;
}
</style>
