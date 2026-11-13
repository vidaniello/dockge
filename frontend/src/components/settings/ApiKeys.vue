<template>
    <div class="my-4">
        <p>{{ $t("apiKeysIntro") }}</p>

        <!-- Connection info -->
        <div class="shadow-box big-padding mb-4">
            <h5 class="settings-subheading mb-3">{{ $t("apiEndpoints") }}</h5>
            <table class="table table-sm api-table mb-2">
                <tbody>
                    <tr>
                        <th>REST</th>
                        <td><code>{{ baseURL }}/api/v1</code></td>
                        <td><button class="btn btn-sm btn-normal" @click="copy(baseURL + '/api/v1')"><font-awesome-icon icon="copy" /></button></td>
                    </tr>
                    <tr>
                        <th>OpenAPI</th>
                        <td><a :href="baseURL + '/api/v1/openapi.json'" target="_blank"><code>{{ baseURL }}/api/v1/openapi.json</code></a></td>
                        <td><button class="btn btn-sm btn-normal" @click="copy(baseURL + '/api/v1/openapi.json')"><font-awesome-icon icon="copy" /></button></td>
                    </tr>
                    <tr>
                        <th>MCP</th>
                        <td><code>{{ baseURL }}/mcp</code></td>
                        <td><button class="btn btn-sm btn-normal" @click="copy(baseURL + '/mcp')"><font-awesome-icon icon="copy" /></button></td>
                    </tr>
                </tbody>
            </table>

            <div v-if="config" class="small">
                <div v-if="config.port">
                    {{ $t("apiDedicatedPort", [ (config.hostname || "0.0.0.0") + ":" + config.port ]) }}
                </div>
                <div v-if="config.allowHttp" class="text-danger">
                    <font-awesome-icon icon="exclamation-circle" /> {{ $t("apiAllowHttpWarning") }}
                </div>
                <div v-else-if="!config.tls && !config.trustProxy" class="text-warning">
                    <font-awesome-icon icon="exclamation-circle" /> {{ $t("apiHttpsRequiredWarning") }}
                </div>
                <div v-else class="text-success">
                    <font-awesome-icon icon="check-circle" />
                    {{ config.tls ? $t("apiTlsOk") : $t("apiProxyOk", [ config.trustProxy ]) }}
                </div>
            </div>
        </div>

        <!-- New key (shown once) -->
        <div v-if="newKey" class="alert alert-success">
            <strong>{{ $t("apiKeyCreated") }}</strong>
            <div class="d-flex align-items-center gap-2 mt-2">
                <code class="new-key flex-grow-1">{{ newKey }}</code>
                <button class="btn btn-sm btn-normal" @click="copy(newKey)"><font-awesome-icon icon="copy" /> {{ $t("copy") }}</button>
            </div>
            <details class="mt-3">
                <summary>{{ $t("apiMcpConfigExample") }}</summary>
                <pre class="mt-2 mb-0 config-example">{{ mcpConfigExample }}</pre>
            </details>
            <button class="btn btn-sm btn-normal mt-3" @click="newKey = ''">{{ $t("apiKeySaved") }}</button>
        </div>

        <!-- Create -->
        <h5 class="settings-subheading my-3">{{ $t("apiCreateKey") }}</h5>
        <form class="row g-2 align-items-end mb-4" @submit.prevent="createKey">
            <div class="col-md-4">
                <label class="form-label" for="api-key-name">{{ $t("Name") }}</label>
                <input id="api-key-name" v-model="form.name" class="form-control" required maxlength="100" placeholder="claude-desktop">
            </div>
            <div class="col-md-3">
                <label class="form-label" for="api-key-permission">{{ $t("apiPermission") }}</label>
                <select id="api-key-permission" v-model="form.permission" class="form-select">
                    <option value="read">{{ $t("apiPermissionRead") }}</option>
                    <option value="write">{{ $t("apiPermissionWrite") }}</option>
                </select>
            </div>
            <div class="col-md-2">
                <label class="form-label" for="api-key-expires">{{ $t("apiExpires") }}</label>
                <select id="api-key-expires" v-model="form.expiresInDays" class="form-select">
                    <option :value="0">{{ $t("never") }}</option>
                    <option :value="30">30 {{ $t("days") }}</option>
                    <option :value="90">90 {{ $t("days") }}</option>
                    <option :value="365">365 {{ $t("days") }}</option>
                </select>
            </div>
            <div class="col-md-3">
                <label class="form-label" for="api-key-password">{{ $t("Current Password") }}</label>
                <input id="api-key-password" v-model="form.password" type="password" class="form-control" autocomplete="current-password" required>
            </div>
            <div class="col-12">
                <div v-if="form.permission === 'write'" class="form-text text-warning mb-2">{{ $t("apiPermissionWriteWarning") }}</div>
                <button class="btn btn-primary" type="submit" :disabled="processing">
                    <font-awesome-icon icon="plus" /> {{ $t("apiCreateKey") }}
                </button>
            </div>
        </form>

        <!-- List -->
        <h5 class="settings-subheading my-3">{{ $t("apiKeys") }}</h5>
        <div v-if="keys.length === 0" class="text-muted">{{ $t("apiNoKeys") }}</div>
        <div v-else class="table-responsive">
            <table class="table api-table align-middle">
                <thead>
                    <tr>
                        <th>{{ $t("Name") }}</th>
                        <th>{{ $t("apiKey") }}</th>
                        <th>{{ $t("apiPermission") }}</th>
                        <th>{{ $t("apiLastUsed") }}</th>
                        <th>{{ $t("apiExpires") }}</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="key in keys" :key="key.id" :class="{ inactive: !key.active || isExpired(key) }">
                        <td>{{ key.name }}</td>
                        <td><code>dk_{{ key.prefix }}_…</code></td>
                        <td>
                            <span class="badge" :class="key.permission === 'write' ? 'bg-warning text-dark' : 'bg-secondary'">
                                {{ key.permission === "write" ? $t("apiPermissionWrite") : $t("apiPermissionRead") }}
                            </span>
                        </td>
                        <td class="small">{{ key.lastUsedAt ? formatDate(key.lastUsedAt) + (key.lastUsedIp ? " (" + key.lastUsedIp + ")" : "") : $t("never") }}</td>
                        <td class="small">
                            <span v-if="isExpired(key)" class="text-danger">{{ $t("apiExpired") }}</span>
                            <span v-else>{{ key.expiresAt ? formatDate(key.expiresAt) : $t("never") }}</span>
                        </td>
                        <td class="text-end text-nowrap">
                            <button class="btn btn-sm btn-normal me-2" @click="toggle(key)">
                                {{ key.active ? $t("apiDisable") : $t("apiEnable") }}
                            </button>
                            <button class="btn btn-sm btn-danger" @click="remove(key)">
                                <font-awesome-icon icon="trash" />
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<script>
import { copyToClipboard } from "../../util-frontend";

export default {
    data() {
        return {
            keys: [],
            config: null,
            newKey: "",
            processing: false,
            form: {
                name: "",
                permission: "read",
                expiresInDays: 0,
                password: "",
            },
        };
    },
    computed: {
        baseURL() {
            if (this.config?.port) {
                const protocol = this.config.tls ? "https" : location.protocol.replace(":", "");
                return `${protocol}://${this.config.hostname && this.config.hostname !== "0.0.0.0" ? this.config.hostname : location.hostname}:${this.config.port}`;
            }
            return location.origin;
        },
        mcpConfigExample() {
            return JSON.stringify({
                mcpServers: {
                    dockge: {
                        type: "http",
                        url: this.baseURL + "/mcp",
                        headers: {
                            Authorization: "Bearer " + (this.newKey || "dk_..."),
                        },
                    },
                },
            }, null, 2);
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        load() {
            this.$root.getSocket().emit("getApiKeyList", (res) => {
                if (res.ok) {
                    this.keys = res.keys;
                    this.config = res.config;
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        createKey() {
            this.processing = true;
            this.$root.getSocket().emit("addApiKey", {
                name: this.form.name,
                permission: this.form.permission,
                expiresInDays: this.form.expiresInDays,
            }, this.form.password, (res) => {
                this.processing = false;
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.newKey = res.key;
                this.form.name = "";
                this.form.password = "";
                this.load();
            });
        },

        toggle(key) {
            this.$root.getSocket().emit("setApiKeyActive", key.id, !key.active, () => this.load());
        },

        remove(key) {
            if (!confirm(this.$t("apiDeleteConfirm", [ key.name ]))) {
                return;
            }
            this.$root.getSocket().emit("deleteApiKey", key.id, () => this.load());
        },

        isExpired(key) {
            return key.expiresAt && key.expiresAt < Date.now();
        },

        formatDate(value) {
            return new Date(value).toLocaleString();
        },

        async copy(text) {
            if (await copyToClipboard(text)) {
                this.$root.toastSuccess(this.$t("copied"));
            }
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../styles/vars.scss";

.api-table {
    .dark & {
        color: $dark-font-color;

        th, td {
            background-color: transparent;
            color: inherit;
            border-color: $dark-border-color;
        }
    }

    tr.inactive td {
        opacity: 0.5;
    }
}

.new-key {
    word-break: break-all;
    font-size: 15px;
    padding: 6px 10px;
    border-radius: 6px;
    background-color: rgba(0, 0, 0, 0.15);
}

.config-example {
    font-size: 13px;
    white-space: pre-wrap;
}
</style>
