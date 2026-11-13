<template>
    <transition name="slide-fade" appear>
        <div>
            <h1 v-if="isAdd" class="mb-3">{{ $t("compose") }}</h1>
            <h1 v-else class="mb-3">
                <Uptime :stack="globalStack" :pill="true" /> {{ stack.name }}
                <span v-if="$root.agentCount > 1 && endpoint !== ''" class="agent-name">
                    ({{ endpointDisplay }})
                </span>
            </h1>

            <div v-if="stack.isManagedByDockge" class="mb-3">
                <div class="btn-group me-2" role="group">
                    <button v-if="isEditMode" class="btn btn-primary" :disabled="processing" @click="deployStack">
                        <font-awesome-icon icon="rocket" class="me-1" />
                        {{ $t("deployStack") }}
                    </button>

                    <button v-if="isEditMode" class="btn btn-normal" :disabled="processing" @click="saveStack">
                        <font-awesome-icon icon="save" class="me-1" />
                        {{ $t("saveStackDraft") }}
                    </button>

                    <button v-if="!isEditMode" class="btn btn-secondary" :disabled="processing" @click="enableEditMode">
                        <font-awesome-icon icon="pen" class="me-1" />
                        {{ $t("editStack") }}
                    </button>

                    <button v-if="!isEditMode && !active" class="btn btn-primary" :disabled="processing" @click="startStack">
                        <font-awesome-icon icon="play" class="me-1" />
                        {{ $t("startStack") }}
                    </button>

                    <button v-if="!isEditMode && active" class="btn btn-normal " :disabled="processing" @click="restartStack">
                        <font-awesome-icon icon="rotate" class="me-1" />
                        {{ $t("restartStack") }}
                    </button>

                    <button v-if="!isEditMode" class="btn btn-normal" :disabled="processing" @click="updateStack">
                        <font-awesome-icon icon="cloud-arrow-down" class="me-1" />
                        {{ $t("updateStack") }}
                        <span v-if="imageUpdates && imageUpdates.updates > 0" class="badge bg-warning text-dark ms-1">{{ imageUpdates.updates }}</span>
                    </button>

                    <button v-if="!isEditMode && active" class="btn btn-normal" :disabled="processing" @click="stopStack">
                        <font-awesome-icon icon="stop" class="me-1" />
                        {{ $t("stopStack") }}
                    </button>

                    <BDropdown right text="" variant="normal">
                        <BDropdownItem @click="downStack">
                            <font-awesome-icon icon="stop" class="me-1" />
                            {{ $t("downStack") }}
                        </BDropdownItem>
                        <BDropdownItem v-if="!isEditMode" @click="checkImageUpdates">
                            <font-awesome-icon icon="arrows-rotate" class="me-1" />
                            {{ $t("checkImageUpdates") }}
                        </BDropdownItem>
                        <BDropdownItem v-if="!isEditMode" @click="openFolderDialog">
                            <font-awesome-icon icon="folder" class="me-1" />
                            {{ $t("moveToFolder") }}
                        </BDropdownItem>
                        <BDropdownItem v-if="!isEditMode" @click="openRenameDialog">
                            <font-awesome-icon icon="pen" class="me-1" />
                            {{ $t("renameStack") }}
                        </BDropdownItem>
                    </BDropdown>
                </div>

                <button v-if="isEditMode && !isAdd" class="btn btn-normal" :disabled="processing" @click="discardStack">{{ $t("discardStack") }}</button>
                <button v-if="!isEditMode" class="btn btn-danger" :disabled="processing" @click="showDeleteDialog = !showDeleteDialog">
                    <font-awesome-icon icon="trash" class="me-1" />
                    {{ $t("deleteStack") }}
                </button>
            </div>

            <!-- URLs -->
            <div v-if="urls.length > 0" class="mb-3">
                <a v-for="(urlItem, index) in urls" :key="index" target="_blank" :href="urlItem.url">
                    <span class="badge bg-secondary me-2">{{ urlItem.display }}</span>
                </a>
            </div>

            <!-- Progress Terminal -->
            <transition name="slide-fade" appear>
                <Terminal
                    v-show="showProgressTerminal"
                    ref="progressTerminal"
                    class="mb-3 terminal"
                    :name="terminalName"
                    :endpoint="endpoint"
                    :rows="progressTerminalRows"
                    @has-data="showProgressTerminal = true; submitted = true;"
                ></Terminal>
            </transition>

            <div v-if="stack.isManagedByDockge" class="row">
                <div class="col-lg-6">
                    <!-- General -->
                    <div v-if="isAdd">
                        <h4 class="mb-3">{{ $t("general") }}</h4>
                        <div class="shadow-box big-padding mb-3">
                            <!-- Stack Name -->
                            <div>
                                <label for="name" class="form-label">{{ $t("stackName") }}</label>
                                <input id="name" v-model="stack.name" type="text" class="form-control" required @blur="stackNameToLowercase">
                                <div class="form-text">{{ $t("Lowercase only") }}</div>
                            </div>

                            <!-- Endpoint -->
                            <div class="mt-3">
                                <label for="name" class="form-label">{{ $t("dockgeAgent") }}</label>
                                <select v-model="stack.endpoint" class="form-select">
                                    <option v-for="(agent, agentEndpoint) in $root.agentList" :key="agentEndpoint" :value="agentEndpoint" :disabled="$root.agentStatusList[agentEndpoint] != 'online'">
                                        ({{ $root.agentStatusList[agentEndpoint] }}) {{ (agent.name !== '') ? agent.name : agent.url || $t("Current") }}
                                    </option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <!-- Containers -->
                    <h4 class="mb-3">{{ $tc("container", 2) }}</h4>

                    <div v-if="isEditMode" class="input-group mb-3">
                        <input
                            v-model="newContainerName"
                            :placeholder="$t(`New Container Name...`)"
                            class="form-control"
                            @keyup.enter="addContainer"
                        />
                        <button class="btn btn-primary" @click="addContainer">
                            {{ $t("addContainer") }}
                        </button>
                    </div>

                    <div ref="containerList">
                        <Container
                            v-for="(service, name) in jsonConfig.services"
                            :key="name"
                            :name="name"
                            :is-edit-mode="isEditMode"
                            :first="name === Object.keys(jsonConfig.services)[0]"
                            :serviceStatus="serviceStatusList[name]"
                            :dockerStats="dockerStats"
                            :updateInfo="imageUpdates?.services?.[name] ?? null"
                            @start-service="startService"
                            @stop-service="stopService"
                            @restart-service="restartService"
                        />
                    </div>

                    <button v-if="false && isEditMode && jsonConfig.services && Object.keys(jsonConfig.services).length > 0" class="btn btn-normal mb-3" @click="addContainer">{{ $t("addContainer") }}</button>

                    <!-- General -->
                    <div v-if="isEditMode">
                        <h4 class="mb-3">{{ $t("extra") }}</h4>
                        <div class="shadow-box big-padding mb-3">
                            <!-- URLs -->
                            <div class="mb-4">
                                <label class="form-label">
                                    {{ $tc("url", 2) }}
                                </label>
                                <ArrayInput name="urls" :display-name="$t('url')" placeholder="https://" object-type="x-dockge" />
                            </div>
                        </div>
                    </div>

                    <!-- Logs: all services (combined) or a single service -->
                    <div v-show="!isEditMode">
                        <ExpandableBox :title="$t('terminal')" resizable storage-key="stackLogs" :height="315" :min-height="150" class="mb-3">
                            <template #actions>
                                <div v-if="serviceNames.length > 1" class="log-tabs" role="group">
                                    <button
                                        type="button"
                                        class="btn btn-sm"
                                        :class="logService === '' ? 'btn-primary' : 'btn-normal'"
                                        @click="selectLogService('')"
                                    >
                                        {{ $t("allServices") }}
                                    </button>
                                    <button
                                        v-for="serviceName in serviceNames"
                                        :key="serviceName"
                                        type="button"
                                        class="btn btn-sm"
                                        :class="logService === serviceName ? 'btn-primary' : 'btn-normal'"
                                        @click="selectLogService(serviceName)"
                                    >
                                        {{ serviceName }}
                                    </button>
                                </div>
                            </template>
                            <Terminal
                                :key="logTerminalName"
                                class="terminal"
                                :name="logTerminalName"
                                :endpoint="endpoint"
                                :rows="combinedTerminalRows"
                                :cols="combinedTerminalCols"
                            ></Terminal>
                        </ExpandableBox>
                    </div>
                </div>
                <div class="col-lg-6">
                    <!-- YAML editor -->
                    <ExpandableBox :title="stack.composeFileName" class="mb-3">
                        <template #actions="{ expanded }">
                            <button v-if="isEditMode" class="btn btn-sm btn-normal" :title="$t('insertHostPathHint')" @click="insertHostPath">
                                <font-awesome-icon icon="folder-open" class="me-1" />
                                {{ $t("insertHostPath") }}
                            </button>
                            <template v-if="expanded && isEditMode">
                                <button class="btn btn-sm btn-primary" :disabled="processing" @click="deployStack">
                                    <font-awesome-icon icon="rocket" class="me-1" />
                                    {{ $t("deployStack") }}
                                </button>
                                <button class="btn btn-sm btn-normal" :disabled="processing" @click="saveStack">
                                    <font-awesome-icon icon="save" class="me-1" />
                                    {{ $t("saveStackDraft") }}
                                </button>
                            </template>
                        </template>
                        <template #default="{ expanded }">
                            <div class="shadow-box editor-box" :class="{'edit-mode' : isEditMode, 'fill': expanded}">
                                <code-mirror
                                    ref="editor"
                                    v-model="stack.composeYAML"
                                    :extensions="extensions"
                                    minimal
                                    wrap="true"
                                    :dark="$root.isDark"
                                    tab="true"
                                    :disabled="!isEditMode"
                                    :hasFocus="editorFocus"
                                    @change="yamlCodeChange"
                                />
                            </div>
                        </template>
                        <template #footer>
                            <div v-if="isEditMode && yamlError" class="mt-2 yaml-error">
                                {{ yamlError }}
                            </div>
                        </template>
                    </ExpandableBox>

                    <!-- ENV editor (read-only when not in edit mode) -->
                    <ExpandableBox v-if="isEditMode || stack.composeENV" title=".env" class="mb-3">
                        <template #actions="{ expanded }">
                            <button v-if="!isEditMode" class="btn btn-sm btn-normal" :title="envRevealed ? $t('hideValues') : $t('showValues')" @click="envRevealed = !envRevealed">
                                <font-awesome-icon :icon="envRevealed ? 'eye-slash' : 'eye'" />
                            </button>
                            <template v-if="expanded && isEditMode">
                                <button class="btn btn-sm btn-primary" :disabled="processing" @click="deployStack">
                                    <font-awesome-icon icon="rocket" class="me-1" />
                                    {{ $t("deployStack") }}
                                </button>
                                <button class="btn btn-sm btn-normal" :disabled="processing" @click="saveStack">
                                    <font-awesome-icon icon="save" class="me-1" />
                                    {{ $t("saveStackDraft") }}
                                </button>
                            </template>
                        </template>
                        <template #default="{ expanded }">
                            <div class="shadow-box editor-box env-box" :class="{'edit-mode' : isEditMode, 'fill': expanded, 'concealed': envConcealed}">
                                <!-- .env usually contains passwords: blurred until the user asks to see it -->
                                <button v-if="envConcealed" type="button" class="btn btn-normal reveal-button" @click="envRevealed = true">
                                    <font-awesome-icon icon="eye" class="me-1" />
                                    {{ $t("showValues") }}
                                </button>
                                <code-mirror
                                    ref="editorEnv"
                                    v-model="stack.composeENV"
                                    :extensions="extensionsEnv"
                                    minimal
                                    wrap="true"
                                    :dark="$root.isDark"
                                    tab="true"
                                    :disabled="!isEditMode"
                                    :hasFocus="editorFocus"
                                    @change="yamlCodeChange"
                                />
                            </div>
                        </template>
                    </ExpandableBox>

                    <div v-if="isEditMode">
                        <!-- Volumes -->
                        <div v-if="false">
                            <h4 class="mb-3">{{ $tc("volume", 2) }}</h4>
                            <div class="shadow-box big-padding mb-3">
                            </div>
                        </div>

                        <!-- Networks -->
                        <h4 class="mb-3">{{ $tc("network", 2) }}</h4>
                        <div class="shadow-box big-padding mb-3">
                            <NetworkInput />
                        </div>
                    </div>

                    <!-- <div class="shadow-box big-padding mb-3">
                        <div class="mb-3">
                            <label for="name" class="form-label"> Search Templates</label>
                            <input id="name" v-model="name" type="text" class="form-control" placeholder="Search..." required>
                        </div>

                        <prism-editor v-if="false" v-model="yamlConfig" class="yaml-editor" :highlight="highlighter" line-numbers @input="yamlCodeChange"></prism-editor>
                    </div>-->
                </div>
            </div>

            <div v-if="!stack.isManagedByDockge && !processing">
                {{ $t("stackNotManagedByDockgeMsg") }}
            </div>

            <PathPicker ref="pathPicker" :endpoint="endpoint" />

            <!-- Folder Dialog -->
            <BModal v-model="showFolderDialog" :title="$t('moveToFolder')" :cancelTitle="$t('cancel')" :okTitle="$t('moveToFolder')" @ok="setFolder">
                <label for="stack-folder" class="form-label">{{ $t("folder") }}</label>
                <input id="stack-folder" v-model="folderInput" type="text" class="form-control" list="stack-folder-list" placeholder="media/arr" @keyup.enter="setFolder(); showFolderDialog = false">
                <datalist id="stack-folder-list">
                    <option v-for="folder in existingFolders" :key="folder" :value="folder" />
                </datalist>
                <div class="form-text">{{ $t("folderHelp") }}</div>
            </BModal>

            <!-- Rename Dialog -->
            <BModal v-model="showRenameDialog" :title="$t('renameStack')" :cancelTitle="$t('cancel')" :okTitle="$t('renameStack')" :okDisabled="!renameNewName || renameNewName === stack.name" @ok="renameStack">
                <label for="rename-stack" class="form-label">{{ $t("newStackName") }}</label>
                <input id="rename-stack" v-model="renameNewName" type="text" class="form-control" @input="renameNewName = renameNewName.toLowerCase()" @keyup.enter="renameStack(); showRenameDialog = false">
                <div class="form-text">{{ $t("Lowercase only") }}</div>

                <div class="alert alert-warning mt-3 mb-0">
                    {{ $t("renameStackWarning") }}
                </div>

                <div v-if="renameVolumes.length > 0" class="mt-3">
                    <p class="mb-2">
                        {{ $t("renameStackVolumesWarning") }}
                        <code v-for="volume in renameVolumes" :key="volume" class="me-2">{{ volume }}</code>
                    </p>
                    <div class="form-check">
                        <input id="rename-keep-volumes" v-model="renameKeepVolumes" class="form-check-input" type="checkbox">
                        <label class="form-check-label" for="rename-keep-volumes">{{ $t("renameStackKeepVolumes") }}</label>
                    </div>
                </div>
            </BModal>

            <!-- Delete Dialog -->
            <BModal v-model="showDeleteDialog" :cancelTitle="$t('cancel')" :okTitle="$t('deleteStack')" okVariant="danger" @ok="deleteDialog">
                {{ $t("deleteStackMsg") }}
            </BModal>
        </div>
    </transition>
</template>

<script>
import CodeMirror from "vue-codemirror6";
import { yaml } from "@codemirror/lang-yaml";
import { python } from "@codemirror/lang-python";
import { dracula as editorThemeDark, tomorrow as editorThemeLight } from "thememirror";
import { lineNumbers, EditorView } from "@codemirror/view";
import { parseDocument, Document } from "yaml";

import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import {
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    copyYAMLComments, envsubstYAML,
    getCombinedTerminalName,
    getComposeTerminalName,
    getServiceLogTerminalName,
    PROGRESS_TERMINAL_ROWS,
    RUNNING
} from "../../../common/util-common";
import { BModal } from "bootstrap-vue-next";
import NetworkInput from "../components/NetworkInput.vue";
import ExpandableBox from "../components/ExpandableBox.vue";
import PathPicker from "../components/PathPicker.vue";
import dotenv from "dotenv";
import { ref } from "vue";

const template = `
services:
  nginx:
    image: nginx:latest
    restart: unless-stopped
    ports:
      - "8080:80"
`;
const envDefault = "# VARIABLE=value #comment";

let yamlErrorTimeout = null;

let serviceStatusTimeout = null;
let dockerStatsTimeout = null;

export default {
    components: {
        NetworkInput,
        ExpandableBox,
        PathPicker,
        FontAwesomeIcon,
        CodeMirror,
        BModal,
    },
    provide() {
        return {
            // Used by the volume path picker (ArrayInput)
            composeEndpoint: () => this.endpoint,
        };
    },
    beforeRouteUpdate(to, from, next) {
        this.exitConfirm(next);
    },
    beforeRouteLeave(to, from, next) {
        this.exitConfirm(next);
    },
    setup() {
        const editorFocus = ref(false);

        const focusEffectHandler = (state, focusing) => {
            editorFocus.value = focusing;
            return null;
        };

        const focusEffect = EditorView.focusChangeEffect.of(focusEffectHandler);
        const yamlLanguage = yaml();
        const envLanguage = python();
        const lineNumbersExtension = lineNumbers();

        return {
            focusEffect,
            yamlLanguage,
            envLanguage,
            lineNumbersExtension,
            editorFocus,
        };
    },
    yamlDoc: null,  // For keeping the yaml comments
    data() {
        return {
            jsonConfig: {},
            envsubstJSONConfig: {},
            yamlError: "",
            processing: true,
            showProgressTerminal: false,
            progressTerminalRows: PROGRESS_TERMINAL_ROWS,
            combinedTerminalRows: COMBINED_TERMINAL_ROWS,
            combinedTerminalCols: COMBINED_TERMINAL_COLS,
            stack: {

            },
            serviceStatusList: {},
            dockerStats: {},
            isEditMode: false,
            submitted: false,
            showDeleteDialog: false,
            newContainerName: "",
            stopServiceStatusTimeout: false,
            stopDockerStatsTimeout: false,
            // Service whose logs are shown in the terminal, "" = all services
            logService: "",
            showRenameDialog: false,
            showFolderDialog: false,
            // The .env is blurred until revealed (it usually contains passwords)
            envRevealed: false,
            folderInput: "",
            renameNewName: "",
            renameVolumes: [],
            renameKeepVolumes: true,
        };
    },
    computed: {
        // The dark theme (dracula) is unreadable on the white background of the light theme
        editorTheme() {
            return this.$root.isDark ? editorThemeDark : editorThemeLight;
        },

        extensions() {
            return [ this.editorTheme, this.yamlLanguage, this.lineNumbersExtension, this.focusEffect ];
        },

        extensionsEnv() {
            return [ this.editorTheme, this.envLanguage, this.lineNumbersExtension, this.focusEffect ];
        },

        endpointDisplay() {
            return this.$root.endpointDisplayFunction(this.endpoint);
        },

        urls() {
            if (!this.envsubstJSONConfig["x-dockge"] || !this.envsubstJSONConfig["x-dockge"].urls || !Array.isArray(this.envsubstJSONConfig["x-dockge"].urls)) {
                return [];
            }

            let urls = [];
            for (const url of this.envsubstJSONConfig["x-dockge"].urls) {
                let display;
                try {
                    let obj = new URL(url);
                    let pathname = obj.pathname;
                    if (pathname === "/") {
                        pathname = "";
                    }
                    display = obj.host + pathname + obj.search;
                } catch (e) {
                    display = url;
                }

                urls.push({
                    display,
                    url,
                });
            }
            return urls;
        },

        isAdd() {
            return this.$route.path === "/compose" && !this.submitted;
        },

        /**
         * Get the stack from the global stack list, because it may contain more real-time data like status
         * @return {*}
         */
        globalStack() {
            return this.$root.completeStackList[this.stack.name + "_" + this.endpoint];
        },

        status() {
            return this.globalStack?.status;
        },

        envConcealed() {
            return !this.isEditMode && !this.envRevealed;
        },

        /** Result of the last image update check of this stack */
        imageUpdates() {
            return this.globalStack?.imageUpdates ?? null;
        },

        active() {
            return this.status === RUNNING;
        },

        terminalName() {
            if (!this.stack.name) {
                return "";
            }
            return getComposeTerminalName(this.endpoint, this.stack.name);
        },

        combinedTerminalName() {
            if (!this.stack.name) {
                return "";
            }
            return getCombinedTerminalName(this.endpoint, this.stack.name);
        },

        /**
         * Folders already used by the stacks of the same endpoint, including parent folders
         * @returns {string[]} Folder paths
         */
        existingFolders() {
            const set = new Set();
            for (const stack of Object.values(this.$root.completeStackList)) {
                if ((stack.endpoint || "") !== (this.endpoint || "") || !stack.folder) {
                    continue;
                }
                const parts = stack.folder.split("/");
                for (let i = 1; i <= parts.length; i++) {
                    set.add(parts.slice(0, i).join("/"));
                }
            }
            return [ ...set ].sort();
        },

        logTerminalName() {
            if (!this.stack.name) {
                return "";
            }
            if (this.logService === "") {
                return this.combinedTerminalName;
            }
            return getServiceLogTerminalName(this.endpoint, this.stack.name, this.logService);
        },

        serviceNames() {
            if (!this.jsonConfig.services || typeof this.jsonConfig.services !== "object") {
                return [];
            }
            return Object.keys(this.jsonConfig.services);
        },

        networks() {
            return this.jsonConfig.networks;
        },

        endpoint() {
            return this.stack.endpoint || this.$route.params.endpoint || "";
        },

        url() {
            if (this.stack.endpoint) {
                return `/compose/${this.stack.name}/${this.stack.endpoint}`;
            } else {
                return `/compose/${this.stack.name}`;
            }
        },
    },
    watch: {
        "stack.composeYAML": {
            handler() {
                if (this.editorFocus) {
                    console.debug("yaml code changed");
                    this.yamlCodeChange();
                }
            },
            deep: true,
        },

        "stack.composeENV": {
            handler() {
                if (this.editorFocus) {
                    console.debug("env code changed");
                    this.yamlCodeChange();
                }
            },
            deep: true,
        },

        jsonConfig: {
            handler() {
                // jsonConfig was just parsed from the YAML text (load, typing, discard...):
                // do not write it back, it would reformat the user's file and drop its style
                if (this.jsonConfigFromYAML) {
                    this.jsonConfigFromYAML = false;
                    return;
                }

                if (!this.editorFocus) {
                    console.debug("jsonConfig changed");

                    let doc = new Document(this.jsonConfig);

                    // Stick back the yaml comments
                    if (this.yamlDoc) {
                        copyYAMLComments(doc, this.yamlDoc);
                    }

                    this.stack.composeYAML = doc.toString();
                    this.yamlDoc = doc;
                }
            },
            deep: true,
        },

        $route(to, from) {

        }
    },
    mounted() {
        if (this.isAdd) {
            this.processing = false;
            this.isEditMode = true;

            let composeYAML;
            let composeENV;

            if (this.$root.composeTemplate) {
                composeYAML = this.$root.composeTemplate;
                this.$root.composeTemplate = "";
            } else {
                composeYAML = template;
            }
            if (this.$root.envTemplate) {
                composeENV = this.$root.envTemplate;
                this.$root.envTemplate = "";
            } else {
                composeENV = envDefault;
            }

            // Default Values
            this.stack = {
                name: "",
                composeYAML,
                composeENV,
                isManagedByDockge: true,
                endpoint: "",
            };

            this.yamlCodeChange();

        } else {
            this.stack.name = this.$route.params.stackName;
            this.loadStack();
        }

        this.requestServiceStatus();
        this.requestDockerStats();
    },
    unmounted() {

    },
    methods: {
        startServiceStatusTimeout() {
            clearTimeout(serviceStatusTimeout);
            serviceStatusTimeout = setTimeout(async () => {
                this.requestServiceStatus();
            }, 5000);
        },

        startDockerStatsTimeout() {
            clearTimeout(dockerStatsTimeout);
            dockerStatsTimeout = setTimeout(async () => {
                this.requestDockerStats();
            }, 5000);
        },

        requestServiceStatus() {
            // Do not request if it is add mode
            if (this.isAdd) {
                return;
            }

            this.$root.emitAgent(this.endpoint, "serviceStatusList", this.stack.name, (res) => {
                if (res.ok) {
                    this.serviceStatusList = res.serviceStatusList;
                }
                if (!this.stopServiceStatusTimeout) {
                    this.startServiceStatusTimeout();
                }
            });
        },

        requestDockerStats() {
            this.$root.emitAgent(this.endpoint, "dockerStats", (res) => {
                if (res.ok) {
                    this.dockerStats = res.dockerStats;
                }
                if (!this.stopDockerStatsTimeout) {
                    this.startDockerStatsTimeout();
                }
            });
        },

        exitConfirm(next) {
            if (this.isEditMode) {
                if (confirm(this.$t("confirmLeaveStack"))) {
                    this.exitAction();
                    next();
                } else {
                    next(false);
                }
            } else {
                this.exitAction();
                next();
            }
        },

        exitAction() {
            console.log("exitAction");
            this.stopServiceStatusTimeout = true;
            this.stopDockerStatsTimeout = true;
            clearTimeout(serviceStatusTimeout);
            clearTimeout(dockerStatsTimeout);

            // Leave Combined Terminal
            console.debug("leaveCombinedTerminal", this.endpoint, this.stack.name);
            this.$root.emitAgent(this.endpoint, "leaveCombinedTerminal", this.stack.name, () => {});

            // Leave the log terminal of a single service
            if (this.logService) {
                this.$root.emitAgent(this.endpoint, "leaveLogTerminal", this.stack.name, this.logService, () => {});
            }
        },

        /**
         * Show the logs of all services ("") or of a single service
         * @param {string} serviceName Service name
         * @returns {void}
         */
        selectLogService(serviceName) {
            if (serviceName === this.logService || !this.stack.name) {
                return;
            }

            this.$root.emitAgent(this.endpoint, "leaveLogTerminal", this.stack.name, this.logService, () => {});
            this.logService = serviceName;

            // Wait for the new <Terminal> to be mounted and bound, so it receives the output from the very beginning
            this.$nextTick(() => {
                this.$root.emitAgent(this.endpoint, "joinLogTerminal", this.stack.name, serviceName, (res) => {
                    if (!res.ok) {
                        this.$root.toastRes(res);
                    }
                });
            });
        },

        bindTerminal() {
            this.$refs.progressTerminal?.bind(this.endpoint, this.terminalName);
        },

        loadStack() {
            this.processing = true;
            this.$root.emitAgent(this.endpoint, "getStack", this.stack.name, (res) => {
                if (res.ok) {
                    this.stack = res.stack;
                    this.yamlCodeChange();
                    this.processing = false;
                    this.bindTerminal();
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        deployStack() {
            this.processing = true;

            if (!this.jsonConfig.services) {
                this.$root.toastError("No services found in compose.yaml");
                this.processing = false;
                return;
            }

            // Check if services is object
            if (typeof this.jsonConfig.services !== "object") {
                this.$root.toastError("Services must be an object");
                this.processing = false;
                return;
            }

            let serviceNameList = Object.keys(this.jsonConfig.services);

            // Set the stack name if empty, use the first container name
            if (!this.stack.name && serviceNameList.length > 0) {
                let serviceName = serviceNameList[0];
                let service = this.jsonConfig.services[serviceName];

                if (service && service.container_name) {
                    this.stack.name = service.container_name;
                } else {
                    this.stack.name = serviceName;
                }
            }

            this.bindTerminal();

            this.$root.emitAgent(this.stack.endpoint, "deployStack", this.stack.name, this.stack.composeYAML, this.stack.composeENV, this.isAdd, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.isEditMode = false;
                    this.$router.push(this.url);
                }
            });
        },

        saveStack() {
            this.processing = true;

            this.$root.emitAgent(this.stack.endpoint, "saveStack", this.stack.name, this.stack.composeYAML, this.stack.composeENV, this.isAdd, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.isEditMode = false;
                    this.$router.push(this.url);
                }
            });
        },

        startStack() {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "startStack", this.stack.name, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
            });
        },

        stopStack() {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "stopStack", this.stack.name, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
            });
        },

        downStack() {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "downStack", this.stack.name, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
            });
        },

        restartStack() {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "restartStack", this.stack.name, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
            });
        },

        updateStack() {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "updateStack", this.stack.name, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
            });
        },

        /**
         * Pick a folder of the host and insert it at the cursor of the compose.yaml editor
         * @returns {Promise<void>}
         */
        async insertHostPath() {
            const view = this.$refs.editor?.view;
            const picked = await this.$refs.pathPicker.open("");
            if (!picked || !view) {
                return;
            }
            view.dispatch(view.state.replaceSelection(picked));
            view.focus();
            this.$nextTick(() => this.yamlCodeChange());
        },

        checkImageUpdates() {
            this.processing = true;
            this.$root.emitAgent(this.endpoint, "checkImageUpdates", this.stack.name, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
            });
        },

        openFolderDialog() {
            this.folderInput = this.globalStack?.folder ?? "";
            this.showFolderDialog = true;
        },

        setFolder() {
            this.$root.emitAgent(this.endpoint, "setStackFolder", this.stack.name, this.folderInput, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                // The compose file changed on disk, reload it unless the user is editing
                if (!this.isEditMode) {
                    this.loadStack();
                }
            });
        },

        openRenameDialog() {
            this.renameNewName = this.stack.name;
            this.renameVolumes = [];
            this.renameKeepVolumes = true;
            this.showRenameDialog = true;

            this.$root.emitAgent(this.endpoint, "getProjectScopedVolumes", this.stack.name, (res) => {
                if (res.ok) {
                    this.renameVolumes = res.volumes;
                }
            });
        },

        renameStack() {
            const newName = this.renameNewName.trim();
            if (!newName || newName === this.stack.name) {
                return;
            }

            this.processing = true;
            this.$root.emitAgent(this.endpoint, "renameStack", this.stack.name, newName, this.renameKeepVolumes, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    if (this.endpoint) {
                        this.$router.push(`/compose/${newName}/${this.endpoint}`);
                    } else {
                        this.$router.push(`/compose/${newName}`);
                    }
                }
            });
        },

        deleteDialog() {
            this.$root.emitAgent(this.endpoint, "deleteStack", this.stack.name, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.$router.push("/");
                }
            });
        },

        discardStack() {
            this.loadStack();
            this.isEditMode = false;
        },

        yamlToJSON(yaml) {
            let doc = parseDocument(yaml);
            if (doc.errors.length > 0) {
                throw doc.errors[0];
            }

            const config = doc.toJS() ?? {};

            // Check data types
            // "services" must be an object
            if (!config.services) {
                config.services = {};
            }

            if (Array.isArray(config.services) || typeof config.services !== "object") {
                throw new Error("Services must be an object");
            }

            return {
                config,
                doc,
            };
        },

        yamlCodeChange() {
            try {
                let { config, doc } = this.yamlToJSON(this.stack.composeYAML);

                this.yamlDoc = doc;
                this.jsonConfigFromYAML = true;
                this.jsonConfig = config;

                let env = dotenv.parse(this.stack.composeENV);
                let envYAML = envsubstYAML(this.stack.composeYAML, env);
                this.envsubstJSONConfig = this.yamlToJSON(envYAML).config;

                clearTimeout(yamlErrorTimeout);
                this.yamlError = "";
            } catch (e) {
                clearTimeout(yamlErrorTimeout);

                if (this.yamlError) {
                    this.yamlError = e.message;

                } else {
                    yamlErrorTimeout = setTimeout(() => {
                        this.yamlError = e.message;
                    }, 3000);
                }
            }
        },

        enableEditMode() {
            this.isEditMode = true;
        },

        checkYAML() {

        },

        addContainer() {
            this.checkYAML();

            if (this.jsonConfig.services[this.newContainerName]) {
                this.$root.toastError("Container name already exists");
                return;
            }

            if (!this.newContainerName) {
                this.$root.toastError("Container name cannot be empty");
                return;
            }

            this.jsonConfig.services[this.newContainerName] = {
                restart: "unless-stopped",
            };
            this.newContainerName = "";
            let element = this.$refs.containerList.lastElementChild;
            element.scrollIntoView({
                block: "start",
                behavior: "smooth"
            });
        },

        stackNameToLowercase() {
            this.stack.name = this.stack?.name?.toLowerCase();
        },

        startService(serviceName) {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "startService", this.stack.name, serviceName, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.requestServiceStatus(); // Refresh service status
                }
            });
        },

        stopService(serviceName) {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "stopService", this.stack.name, serviceName, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.requestServiceStatus(); // Refresh service status
                }
            });
        },

        restartService(serviceName) {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "restartService", this.stack.name, serviceName, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.requestServiceStatus(); // Refresh service status
                }
            });
        },
    }
};
</script>

<style scoped lang="scss">
@import "../styles/vars.scss";

.terminal {
    height: 200px;
}

.editor-box {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;

    // Fullscreen: the editor fills the whole box and scrolls internally
    &.fill {
        display: flex;
        flex-direction: column;
        overflow: hidden;

        :deep(.vue-codemirror) {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
        }

        :deep(.cm-editor) {
            flex: 1;
            min-height: 0;
        }

        :deep(.cm-scroller) {
            overflow: auto;
        }
    }
}

.env-box {
    position: relative;

    &.concealed :deep(.vue-codemirror) {
        filter: blur(6px);
        user-select: none;
        pointer-events: none;
    }

    .reveal-button {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 2;
        white-space: nowrap;
    }

    // Leave room for the button when the .env has only a line or two
    &.concealed {
        min-height: 80px;
    }
}

.yaml-error {
    color: $danger;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    white-space: pre-wrap;
}

.log-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.agent-name {
    font-size: 13px;
    color: $dark-font-color3;
}
</style>
