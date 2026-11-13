<template>
    <transition ref="tableContainer" name="slide-fade" appear>
        <div v-if="$route.name === 'DashboardHome'">
            <h1 class="mb-3">
                {{ $t("home") }}
            </h1>

            <div class="row first-row">
                <!-- Left -->
                <div class="col-md-7">
                    <!-- Stats -->
                    <div class="shadow-box big-padding text-center mb-4">
                        <div class="row">
                            <div class="col">
                                <h3>{{ $t("active") }}</h3>
                                <span class="num active">{{ activeNum }}</span>
                            </div>
                            <div class="col">
                                <h3>{{ $t("exited") }}</h3>
                                <span class="num exited">{{ exitedNum }}</span>
                            </div>
                            <div class="col">
                                <h3>{{ $t("inactive") }}</h3>
                                <span class="num inactive">{{ inactiveNum }}</span>
                            </div>
                        </div>
                    </div>

                    <!-- Docker Run -->
                    <h2 class="mb-3">{{ $t("Docker Run") }}</h2>
                    <div class="mb-3">
                        <textarea id="name" v-model="dockerRunCommand" type="text" class="form-control docker-run shadow-box" required placeholder="docker run ..."></textarea>
                    </div>

                    <button class="btn-normal btn mb-4" @click="convertDockerRun">{{ $t("Convert to Compose") }}</button>
                </div>
                <!-- Right -->
                <div class="col-md-5">
                    <!-- Image updates -->
                    <div class="shadow-box big-padding mb-4">
                        <div class="d-flex align-items-center mb-3 gap-2">
                            <h4 class="mb-0 flex-grow-1">{{ $t("imageUpdates") }}</h4>
                            <button class="btn btn-sm btn-normal" :disabled="checkingUpdates > 0" @click="checkAllImageUpdates">
                                <font-awesome-icon icon="arrows-rotate" :spin="checkingUpdates > 0" class="me-1" />
                                {{ $t("checkNow") }}
                            </button>
                        </div>

                        <div v-if="stacksWithUpdates.length === 0" class="text-muted">
                            {{ $t("noImageUpdates") }}
                        </div>

                        <router-link v-for="item in stacksWithUpdates" :key="item.key" :to="item.url" class="update-row">
                            <div class="d-flex align-items-center">
                                <font-awesome-icon icon="arrow-alt-circle-up" class="me-2 update-icon" />
                                <strong class="flex-grow-1">{{ item.name }}</strong>
                                <span v-if="$root.agentCount > 1" class="text-muted small me-2">{{ item.endpointDisplay }}</span>
                                <span class="badge bg-warning text-dark">{{ item.updates }}</span>
                            </div>
                            <div class="small update-services">
                                <span v-for="service in item.services" :key="service.name" class="me-2">
                                    {{ service.name }} ({{ service.image }}){{ service.status === "recreate" ? " - " + $t("imageStatus_recreate") : "" }}
                                </span>
                            </div>
                        </router-link>

                        <div class="form-text mt-2">
                            {{ $t("lastCheck") }}: {{ lastImageCheck }}
                        </div>
                    </div>

                    <!-- Agent List -->
                    <div class="shadow-box big-padding">
                        <h4 class="mb-3">{{ $tc("dockgeAgent", 2) }} <span class="badge bg-warning" style="font-size: 12px;">beta</span></h4>

                        <div v-for="(agentItem, endpoint) in $root.agentList" :key="endpoint" class="mb-3 agent">
                            <!-- Agent Status -->
                            <template v-if="$root.agentStatusList[endpoint]">
                                <span v-if="$root.agentStatusList[endpoint] === 'online'" class="badge bg-primary me-2">{{ $t("agentOnline") }}</span>
                                <span v-else-if="$root.agentStatusList[endpoint] === 'offline'" class="badge bg-danger me-2">{{ $t("agentOffline") }}</span>
                                <span v-else class="badge bg-secondary me-2">{{ $t($root.agentStatusList[endpoint]) }}</span>
                            </template>

                            <!-- Agent Display Name -->
                            <template v-if="$root.agentStatusList[endpoint]">
                                <span v-if="endpoint === '' && agentItem.name === ''" class="badge bg-secondary me-2">Current</span>
                                <span v-else-if="agentItem.name === ''" :href="agentItem.url" class="me-2">{{ endpoint }}</span>
                                <span v-else :href="agentItem.url" class="me-2">{{ agentItem.name }}</span>
                            </template>

                            <!-- Edit Name  -->
                            <font-awesome-icon v-if="agentItem.name !== ''" icon="pen-to-square" @click="showEditAgentNameDialog[agentItem.name] = !showEditAgentNameDialog[agentItem.Name]" />

                            <!-- Edit Dialog -->
                            <BModal v-model="showEditAgentNameDialog[agentItem.name]" :no-close-on-backdrop="true" :close-on-esc="true" :okTitle="$t('Update Name')" okVariant="info" @ok="updateName(agentItem.url, agentItem.updatedName)">
                                <label for="Update Name" class="form-label">Current value: {{ $t(agentItem.name) }}</label>
                                <input id="updatedName" v-model="agentItem.updatedName" type="text" class="form-control" optional>
                            </BModal>

                            <!-- Remove Button -->
                            <font-awesome-icon v-if="endpoint !== ''" class="ms-2 remove-agent" icon="trash" @click="showRemoveAgentDialog[agentItem.url] = !showRemoveAgentDialog[agentItem.url]" />

                            <!-- Remove Agent Dialog -->
                            <BModal v-model="showRemoveAgentDialog[agentItem.url]" :okTitle="$t('removeAgent')" okVariant="danger" @ok="removeAgent(agentItem.url)">
                                <p>{{ agentItem.url }}</p>
                                {{ $t("removeAgentMsg") }}
                            </BModal>
                        </div>

                        <button v-if="!showAgentForm" class="btn btn-normal" @click="showAgentForm = !showAgentForm">{{ $t("addAgent") }}</button>

                        <!-- Add Agent Form -->
                        <form v-if="showAgentForm" @submit.prevent="addAgent">
                            <div class="mb-3">
                                <label for="url" class="form-label">{{ $t("dockgeURL") }}</label>
                                <input id="url" v-model="agent.url" type="url" class="form-control" required placeholder="http://">
                            </div>

                            <div class="mb-3">
                                <label for="username" class="form-label">{{ $t("Username") }}</label>
                                <input id="username" v-model="agent.username" type="text" class="form-control" required>
                            </div>

                            <div class="mb-3">
                                <label for="password" class="form-label">{{ $t("Password") }}</label>
                                <input id="password" v-model="agent.password" type="password" class="form-control" required autocomplete="new-password">
                            </div>

                            <div class="mb-3">
                                <label for="name" class="form-label">{{ $t("Friendly Name") }}</label>
                                <input id="name" v-model="agent.name" type="text" class="form-control" optional>
                            </div>

                            <button type="submit" class="btn btn-primary" :disabled="connectingAgent">
                                <template v-if="connectingAgent">{{ $t("connecting") }}</template>
                                <template v-else>{{ $t("connect") }}</template>
                            </button>
                        </form>
                    </div>
                </div>
            </div>
        </div>
    </transition>
    <router-view ref="child" />
</template>

<script>
import { statusNameShort } from "../../../common/util-common";

export default {
    components: {

    },
    props: {
        calculatedHeight: {
            type: Number,
            default: 0
        }
    },
    data() {
        return {
            checkingUpdates: 0,
            page: 1,
            perPage: 25,
            initialPerPage: 25,
            paginationConfig: {
                hideCount: true,
                chunksNavigation: "scroll",
            },
            importantHeartBeatListLength: 0,
            displayedRecords: [],
            dockerRunCommand: "",
            showAgentForm: false,
            showRemoveAgentDialog: {},
            showEditAgentNameDialog: {},
            connectingAgent: false,
            agent: {
                url: "http://",
                username: "",
                password: "",
                name: "",
                updatedName: "",
            }
        };
    },

    computed: {
        /** Stacks with newer images, from the last check */
        stacksWithUpdates() {
            const list = [];
            for (const [ key, stack ] of Object.entries(this.$root.completeStackList)) {
                const info = stack.imageUpdates;
                if (!info || info.updates <= 0) {
                    continue;
                }
                list.push({
                    key,
                    name: stack.name,
                    updates: info.updates,
                    endpointDisplay: this.$root.endpointDisplayFunction(stack.endpoint),
                    url: stack.endpoint ? `/compose/${stack.name}/${stack.endpoint}` : `/compose/${stack.name}`,
                    services: Object.entries(info.services)
                        .filter(([ , service ]) => service.status === "update" || service.status === "recreate")
                        .map(([ name, service ]) => ({
                            name,
                            ...service,
                        })),
                });
            }
            return list.sort((a, b) => a.name.localeCompare(b.name));
        },

        lastImageCheck() {
            let last = 0;
            for (const stack of Object.values(this.$root.completeStackList)) {
                last = Math.max(last, stack.imageUpdates?.checkedAt ?? 0);
            }
            return last ? new Date(last).toLocaleString() : this.$t("never");
        },

        activeNum() {
            return this.getStatusNum("active");
        },
        inactiveNum() {
            return this.getStatusNum("inactive");
        },
        exitedNum() {
            return this.getStatusNum("exited");
        },
    },

    watch: {
        perPage() {
            this.$nextTick(() => {
                this.getImportantHeartbeatListPaged();
            });
        },

        page() {
            this.getImportantHeartbeatListPaged();
        },
    },

    mounted() {
        this.initialPerPage = this.perPage;

        window.addEventListener("resize", this.updatePerPage);
        this.updatePerPage();
    },

    beforeUnmount() {
        window.removeEventListener("resize", this.updatePerPage);
    },

    methods: {
        /** Check all stacks of all the Dockge instances */
        checkAllImageUpdates() {
            const endpoints = Object.keys(this.$root.agentList);
            if (endpoints.length === 0) {
                endpoints.push("");
            }
            for (const endpoint of endpoints) {
                if (this.$root.agentStatusList[endpoint] && this.$root.agentStatusList[endpoint] !== "online") {
                    continue;
                }
                this.checkingUpdates++;
                this.$root.emitAgent(endpoint, "checkImageUpdates", "", (res) => {
                    this.checkingUpdates--;
                    if (!res.ok) {
                        this.$root.toastRes(res);
                    }
                });
            }
        },

        addAgent() {
            this.connectingAgent = true;
            this.$root.getSocket().emit("addAgent", this.agent, (res) => {
                this.$root.toastRes(res);

                if (res.ok) {
                    this.showAgentForm = false;
                    this.agent = {
                        url: "http://",
                        username: "",
                        password: "",
                    };
                }

                this.connectingAgent = false;
            });
        },

        removeAgent(url) {
            this.$root.getSocket().emit("removeAgent", url, (res) => {
                if (res.ok) {
                    this.$root.toastRes(res);

                    let urlObj = new URL(url);
                    let endpoint = urlObj.host;

                    // Remove the stack list and status list of the removed agent
                    delete this.$root.allAgentStackList[endpoint];
                }
            });
        },

        updateName(url, updatedName) {
            this.$root.getSocket().emit("updateAgent", url, updatedName, (res) => {
                this.$root.toastRes(res);

                if (res.ok) {
                    this.showAgentForm = false;
                    this.agent = {
                        updatedName: "",
                    };
                }
            });
        },

        getStatusNum(statusName) {
            let num = 0;

            for (let stackName in this.$root.completeStackList) {
                const stack = this.$root.completeStackList[stackName];
                if (statusNameShort(stack.status) === statusName) {
                    num += 1;
                }
            }
            return num;
        },

        convertDockerRun() {
            if (this.dockerRunCommand.trim() === "docker run") {
                throw new Error("Please enter a docker run command");
            }

            // composerize is working in dev, but after "vite build", it is not working
            // So pass to backend to do the conversion
            this.$root.getSocket().emit("composerize", this.dockerRunCommand, (res) => {
                if (res.ok) {
                    this.$root.composeTemplate = res.composeTemplate;
                    this.$router.push("/compose");
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Updates the displayed records when a new important heartbeat arrives.
         * @param {object} heartbeat - The heartbeat object received.
         * @returns {void}
         */
        onNewImportantHeartbeat(heartbeat) {
            if (this.page === 1) {
                this.displayedRecords.unshift(heartbeat);
                if (this.displayedRecords.length > this.perPage) {
                    this.displayedRecords.pop();
                }
                this.importantHeartBeatListLength += 1;
            }
        },

        /**
         * Retrieves the length of the important heartbeat list for all monitors.
         * @returns {void}
         */
        getImportantHeartbeatListLength() {
            this.$root.getSocket().emit("monitorImportantHeartbeatListCount", null, (res) => {
                if (res.ok) {
                    this.importantHeartBeatListLength = res.count;
                    this.getImportantHeartbeatListPaged();
                }
            });
        },

        /**
         * Retrieves the important heartbeat list for the current page.
         * @returns {void}
         */
        getImportantHeartbeatListPaged() {
            const offset = (this.page - 1) * this.perPage;
            this.$root.getSocket().emit("monitorImportantHeartbeatListPaged", null, offset, this.perPage, (res) => {
                if (res.ok) {
                    this.displayedRecords = res.data;
                }
            });
        },

        /**
         * Updates the number of items shown per page based on the available height.
         * @returns {void}
         */
        updatePerPage() {
            const tableContainer = this.$refs.tableContainer;
            const tableContainerHeight = tableContainer.offsetHeight;
            const availableHeight = window.innerHeight - tableContainerHeight;
            const additionalPerPage = Math.floor(availableHeight / 58);

            if (additionalPerPage > 0) {
                this.perPage = Math.max(this.initialPerPage, this.perPage + additionalPerPage);
            } else {
                this.perPage = this.initialPerPage;
            }

        },
    }
};
</script>

<style lang="scss" scoped>
.update-row {
    display: block;
    padding: 8px 10px;
    margin: 0 -10px;
    border-radius: 10px;
    text-decoration: none;
    color: inherit;

    &:hover {
        background-color: rgba(128, 128, 128, 0.12);
    }

    .update-icon {
        color: #f8a306;
    }

    .update-services {
        padding-left: 24px;
        color: #8a929b;
        word-break: break-all;
    }
}

@import "../styles/vars";

.num {
    font-size: 30px;

    font-weight: bold;
    display: block;

    &.active {
        color: $primary;
    }

    &.exited {
        color: $danger;
    }
}

.shadow-box {
    padding: 20px;
}

table {
    font-size: 14px;

    tr {
        transition: all ease-in-out 0.2ms;
    }

    @media (max-width: 550px) {
        table-layout: fixed;
        overflow-wrap: break-word;
    }
}

.docker-run {
    border: none;
    font-family: 'JetBrains Mono', monospace;
    font-size: 15px;
}

.first-row .shadow-box {

}

.remove-agent {
    cursor: pointer;
    color: rgba(255, 255, 255, 0.3);
}

.agent {
    a {
        text-decoration: none;
    }
}

</style>
