<template>
    <div>
        <div v-if="valid">
            <ul v-if="isArrayInited" class="list-group">
                <li v-for="(value, index) in array" :key="index" class="list-group-item">
                    <select
                        v-if="ipPicker"
                        class="form-select form-select-sm ip-select me-2"
                        :value="splitHostIp(array[index]).ip"
                        :title="$t('bindToIP')"
                        @change="setHostIp(index, $event.target.value)"
                    >
                        <option value="">{{ $t("allIPs") }}</option>
                        <option v-for="ip in ipOptions(array[index])" :key="ip.address" :value="ip.address">
                            {{ ip.address }}{{ ip.interface ? ` (${ip.interface})` : "" }}
                        </option>
                    </select>
                    <input v-model="array[index]" type="text" class="no-bg domain-input" :placeholder="placeholder" />
                    <template v-if="browse && volumeLabel(array[index])">
                        <button
                            v-if="volumeLabel(array[index]).relative"
                            type="button"
                            class="badge bg-info text-dark border-0 ms-2 volume-label"
                            :title="$t('storageUseRelativeHint', [ volumeLabel(array[index]).relative ])"
                            @click="useRelative(index, volumeLabel(array[index]).relative)"
                        >
                            {{ volumeLabel(array[index]).relative }}
                        </button>
                        <span class="badge ms-2 volume-label" :class="volumeLabel(array[index]).class" :title="volumeLabel(array[index]).title">
                            {{ volumeLabel(array[index]).text }}
                        </span>
                        <button
                            v-if="volumeLabel(array[index]).differences"
                            type="button"
                            class="badge bg-warning text-dark border-0 ms-1 volume-label"
                            :title="volumeLabel(array[index]).differences + '\n' + $t('applyRecipeHint')"
                            @click="askApplyRecipe(getVolumeStorage(volumeHost(array[index])))"
                        >
                            ≠ x-dockge.zfs
                        </button>
                    </template>
                    <font-awesome-icon v-if="browse" icon="folder-open" class="action browse ms-2" :title="$t('pickHostPath')" @click="browsePath(index)" />
                    <font-awesome-icon icon="times" class="action remove ms-2 me-3 text-danger" @click="remove(index)" />
                </li>
            </ul>

            <button class="btn btn-normal btn-sm mt-3" @click="addField">{{ $t("addListItem", [ displayName ]) }}</button>
            <button v-if="browse" class="btn btn-normal btn-sm mt-3 ms-2" @click="addBrowsedField">
                <font-awesome-icon icon="folder-open" class="me-1" />
                {{ $t("addHostPath") }}
            </button>
            <PathPicker v-if="browse" ref="picker" :endpoint="getEndpoint()" :current-stack="getStackName()" />
        </div>
        <div v-else>
            {{ $t("LongSyntaxNotSupported") }}
        </div>
    </div>
</template>

<script>
import PathPicker from "./PathPicker.vue";

export default {
    components: {
        PathPicker,
    },
    inject: {
        // Provided by Compose.vue
        getEndpoint: {
            from: "composeEndpoint",
            default: () => () => "",
        },
        // Provided by Compose.vue: ZFS information of a bind source, null when not on ZFS
        getVolumeStorage: {
            from: "composeVolumeStorage",
            default: () => () => null,
        },
        getMissingVolumesRule: {
            from: "composeMissingVolumesRule",
            default: () => () => null,
        },
        getStackName: {
            from: "composeStackName",
            default: () => () => "",
        },
        toStackRelative: {
            from: "composeToStackRelative",
            default: () => (picked) => picked,
        },
        askApplyRecipe: {
            from: "composeAskApplyRecipe",
            default: () => () => {},
        },
        setVolumeRecipe: {
            from: "composeSetVolumeRecipe",
            default: () => () => {},
        },
        isZfsStack: {
            from: "composeIsZfsStack",
            default: () => () => false,
        },
    },
    props: {
        /** Show a button to pick the host part of "HOST:CONTAINER" from the host folders */
        browse: {
            type: Boolean,
            default: false,
        },
        /** Show a dropdown to bind the port to one of the host IPs ("IP:HOST:CONTAINER") */
        ipPicker: {
            type: Boolean,
            default: false,
        },
        name: {
            type: String,
            required: true,
        },
        placeholder: {
            type: String,
            default: "",
        },
        displayName: {
            type: String,
            required: true,
        },
        objectType: {
            type: String,
            default: "service",
        }
    },
    data() {
        return {
            hostIPs: [],
        };
    },
    computed: {
        array() {
            // Create the array if not exists, it should be safe.
            if (!this.service[this.name]) {
                return [];
            }
            return this.service[this.name];
        },

        /**
         * Check if the array is inited before called v-for.
         * Prevent empty arrays inserted to the YAML file.
         * @return {boolean}
         */
        isArrayInited() {
            return this.service[this.name] !== undefined;
        },

        /**
         * Not a good name, but it is used to get the object.
         */
        service() {
            if (this.objectType === "service") {
                // Used in Container.vue
                return this.$parent.$parent.service;
            } else if (this.objectType === "x-dockge") {

                if (!this.$parent.$parent.jsonConfig["x-dockge"]) {
                    return {};
                }

                // Used in Compose.vue
                return this.$parent.$parent.jsonConfig["x-dockge"];
            } else {
                return {};
            }
        },

        valid() {
            // Check if the array is actually an array
            if (!Array.isArray(this.array)) {
                return false;
            }

            // Check if the array contains non-object only.
            for (let item of this.array) {
                if (typeof item === "object") {
                    return false;
                }
            }
            return true;
        }

    },
    mounted() {
        if (this.ipPicker) {
            this.$root.emitAgent(this.getEndpoint(), "getHostIPs", (res) => {
                if (res.ok) {
                    this.hostIPs = res.list;
                }
            });
        }
    },
    created() {

    },
    methods: {
        addField() {

            // Create the object if not exists.
            if (this.objectType === "x-dockge") {
                if (!this.$parent.$parent.jsonConfig["x-dockge"]) {
                    this.$parent.$parent.jsonConfig["x-dockge"] = {};
                }
            }

            // Create the array if not exists.
            if (!this.service[this.name]) {
                this.service[this.name] = [];
            }

            this.array.push("");
        },
        remove(index) {
            this.array.splice(index, 1);
        },

        /**
         * "192.168.1.10:8080:80" => { ip: "192.168.1.10", rest: "8080:80" }, "[::1]:80:80" => { ip: "::1", ... }
         * @param {string|number} value Port mapping
         * @returns {object} { ip, rest }
         */
        splitHostIp(value) {
            const text = String(value ?? "");
            const match = /^(\[[^\]]+\]|\d{1,3}(?:\.\d{1,3}){3}):(.*)$/.exec(text);
            if (!match) {
                return {
                    ip: "",
                    rest: text,
                };
            }
            return {
                ip: match[1].replace(/^\[|\]$/g, ""),
                rest: match[2],
            };
        },

        /**
         * Bind the port mapping of a row to an IP ("" = all IPs)
         * @param {number} index Row
         * @param {string} ip IP address
         * @returns {void}
         */
        setHostIp(index, ip) {
            let rest = this.splitHostIp(this.array[index]).rest;
            if (!ip) {
                // "IP::80" (random host port) becomes "80"
                this.array[index] = rest.startsWith(":") ? rest.slice(1) : rest;
                return;
            }
            const host = ip.includes(":") ? `[${ip}]` : ip;
            // Only the container port: keep a random host port
            if (rest !== "" && !rest.includes(":")) {
                rest = ":" + rest;
            }
            this.array[index] = `${host}:${rest}`;
        },

        /**
         * Host IPs, plus the IP already used by the row if it is not in the list
         * @param {string} value Port mapping
         * @returns {object[]} IPs
         */
        ipOptions(value) {
            const current = this.splitHostIp(value).ip;
            if (current && !this.hostIPs.some((ip) => ip.address === current)) {
                return [ ...this.hostIPs, {
                    address: current,
                    interface: "",
                }];
            }
            return this.hostIPs;
        },

        /**
         * Host part of a short syntax volume, "" for a named volume or an anonymous one
         * @param {string} value "HOST:CONTAINER[:mode]"
         * @returns {string} Host part
         */
        volumeHost(value) {
            const text = String(value ?? "");
            // The first ":" outside of "${VAR:-default}"
            let depth = 0;
            for (let i = 0; i < text.length; i++) {
                if (text[i] === "$" && text[i + 1] === "{") {
                    depth++;
                    i++;
                } else if (text[i] === "}" && depth > 0) {
                    depth--;
                } else if (text[i] === ":" && depth === 0) {
                    const host = text.slice(0, i);
                    return /^[/.~$]/.test(host) ? host : "";
                }
            }
            return "";
        },

        /**
         * ZFS label of a volume row
         * @param {string} value "HOST:CONTAINER[:mode]"
         * @returns {object|null} { text, class, title, relative }
         */
        volumeLabel(value) {
            const host = this.volumeHost(value);
            const info = host ? this.getVolumeStorage(host) : null;
            if (!info) {
                return null;
            }
            // An absolute path into the stack folder: suggest the relative one, it survives a rename
            const relative = info.location === "stack" && !host.startsWith(".") && info.relative && !info.isStackFolder ? info.relative : null;
            const differences = (info.differences ?? []).map((item) => this.$t("storageDifference", [ item.property, item.actual, item.expected ])).join("\n");
            const properties = info.properties ? Object.entries(info.properties)
                .filter(([ key ]) => [ "recordsize", "compression", "atime", "quota", "used", "available" ].includes(key))
                .map(([ key, value ]) => `${key}: ${value}`).join("\n") : "";
            const label = (text, cls, title) => ({
                text,
                class: cls,
                title: [ title, properties ].filter((part) => part).join("\n"),
                relative,
                differences,
            });

            if (info.location === "otherStack") {
                return label(this.$t("storageLabelOtherStack", [ info.otherStack ]), "bg-warning text-dark", this.$t("storageLabelOtherStackHint"));
            }
            switch (info.kind) {
                case "dataset":
                    if (info.location === "stack") {
                        return label(this.$t("storageLabelDataset"), "bg-success", info.dataset);
                    }
                    return label(this.$t("storageLabelExternalDataset"), "bg-primary", info.dataset);
                case "directory":
                    if (!info.zfs) {
                        return null;
                    }
                    return label(this.$t("storageLabelDirectory"), "bg-secondary", this.$t("storageLabelDirectoryHint", [ info.dataset ]));
                case "missing":
                    if (info.location !== "stack") {
                        return label(this.$t("storageLabelMissing"), "bg-warning text-dark", info.hostPath);
                    }
                    switch (this.getMissingVolumesRule()) {
                        case "ask":
                            return label(this.$t("storageLabelMissingAsk"), "bg-info text-dark", this.$t("storageLabelMissingAskHint"));
                        case "dataset":
                            return label(this.$t("storageLabelMissingDataset"), "bg-info text-dark", this.$t("storageLabelMissingDatasetHint"));
                        case "directory":
                            return label(this.$t("storageLabelMissingDirectory"), "bg-secondary", this.$t("storageLabelMissingDirectoryHint"));
                        default:
                            return label(this.$t("storageLabelMissingInStack"), "bg-warning text-dark", this.$t("storageLabelMissingInStackHint"));
                    }
                case "file":
                    return label(this.$t("storageLabelFile"), "bg-light text-dark", info.dataset ?? "");
                case "notVisible":
                    return label(this.$t("storageLabelNotVisible"), "bg-light text-dark", this.$t("storageLabelNotVisibleHint"));
                default:
                    return null;
            }
        },

        /**
         * Options of the path picker: the "in this stack" tab, with the owner suggested by the service
         * @returns {object} Options
         */
        pickerOptions() {
            if (this.objectType !== "service") {
                return {};
            }
            const numeric = (value) => (/^\d+(:\d+)?$/.test(String(value ?? "").trim()) ? String(value).trim() : "");
            let suggestedOwner = numeric(this.service.user);
            if (!suggestedOwner) {
                const environment = this.service.environment;
                const read = (key) => {
                    if (Array.isArray(environment)) {
                        const line = environment.find((item) => String(item).startsWith(key + "="));
                        return line ? String(line).slice(key.length + 1) : "";
                    }
                    return environment?.[key] ?? "";
                };
                const puid = numeric(read("PUID"));
                const pgid = numeric(read("PGID"));
                suggestedOwner = puid ? (pgid ? `${puid}:${pgid}` : puid) : "";
            }
            return {
                stackTab: true,
                zfs: this.isZfsStack(),
                suggestedOwner,
            };
        },

        /**
         * Path to insert for what the picker returned; a new volume of the stack also gets its x-dockge.zfs entry
         * @param {string|object|null} picked Host path, or { relative, recipe }
         * @returns {string|null} Path
         */
        pickedPath(picked) {
            if (!picked) {
                return null;
            }
            if (typeof picked === "object") {
                if (picked.recipe) {
                    this.setVolumeRecipe(picked.relative.replace(/^\.\//, ""), picked.recipe);
                }
                return picked.relative;
            }
            return this.toStackRelative(picked);
        },

        /**
         * Replace the host part of a row with the equivalent relative path
         * @param {number} index Row
         * @param {string} relative "./library"
         * @returns {void}
         */
        useRelative(index, relative) {
            const value = String(this.array[index] ?? "");
            const host = this.volumeHost(value);
            if (host) {
                this.array[index] = relative + value.slice(host.length);
            }
        },

        /**
         * Replace the host part of "HOST:CONTAINER[:mode]" with a folder picked from the host
         * @param {number} index Row
         * @returns {Promise<void>}
         */
        async browsePath(index) {
            const value = this.array[index] ?? "";
            const separator = value.indexOf(":");
            const host = separator >= 0 ? value.slice(0, separator) : value;

            let picked = this.pickedPath(await this.$refs.picker.open(host, this.pickerOptions()));
            if (!picked) {
                return;
            }

            this.array[index] = separator >= 0 ? picked + value.slice(separator) : picked + ":";
        },

        async addBrowsedField() {
            const picked = this.pickedPath(await this.$refs.picker.open("", this.pickerOptions()));
            if (!picked) {
                return;
            }
            if (!this.service[this.name]) {
                this.service[this.name] = [];
            }
            this.array.push(picked + ":");
        },
    }
};
</script>

<style lang="scss" scoped>
.volume-label {
    white-space: nowrap;
    flex-shrink: 0;
}

button.volume-label {
    cursor: pointer;
}

@import "../styles/vars.scss";

.browse {
    cursor: pointer;
    color: $warning;
}

.ip-select {
    width: auto;
    max-width: 45%;
    flex-shrink: 0;
}

.list-group {
    background-color: $dark-bg2;

    li {
        display: flex;
        align-items: center;
        padding: 10px 0 10px 10px;

        .domain-input {
            flex-grow: 1;
            background-color: $dark-bg2;
            border: none;
            color: $dark-font-color;
            outline: none;

            &::placeholder {
                color: #1d2634;
            }
        }
    }
}
</style>
