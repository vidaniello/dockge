<template>
    <div class="shadow-box mb-3" :style="boxStyle">
        <div class="list-header">
            <div class="header-top">
                <!-- TODO -->
                <button
                    v-if="false" class="btn btn-outline-normal ms-2" :class="{ 'active': selectMode }" type="button"
                    @click="selectMode = !selectMode"
                >
                    {{ $t("Select") }}
                </button>

                <button
                    type="button"
                    class="btn btn-sm btn-normal new-folder-btn"
                    :title="$t('newFolder')"
                    @click="startCreateFolder('current', '')"
                >
                    <font-awesome-icon icon="folder-plus" />
                </button>
                <div class="search-wrapper">
                    <a v-if="searchText == ''" class="search-icon">
                        <font-awesome-icon icon="search" />
                    </a>
                    <a v-if="searchText != ''" class="search-icon" style="cursor: pointer" @click="clearSearchText">
                        <font-awesome-icon icon="times" />
                    </a>
                    <form>
                        <input v-model="searchText" class="form-control search-input" autocomplete="off" />
                    </form>
                </div>
            </div>

            <!-- TODO -->
            <div v-if="false" class="header-filter">
                <!--<StackListFilter :filterState="filterState" @update-filter="updateFilter" />-->
            </div>

            <!-- TODO: Selection Controls -->
            <div v-if="selectMode && false" class="selection-controls px-2 pt-2">
                <input v-model="selectAll" class="form-check-input select-input" type="checkbox" />

                <button class="btn-outline-normal" @click="pauseDialog">
                    <font-awesome-icon icon="pause" size="sm" /> {{
                        $t("Pause") }}
                </button>
                <button class="btn-outline-normal" @click="resumeSelected">
                    <font-awesome-icon icon="play" size="sm" />
                    {{ $t("Resume") }}
                </button>

                <span v-if="selectedStackCount > 0">
                    {{ $t("selectedStackCount", [selectedStackCount]) }}
                </span>
            </div>
        </div>
        <DragDropProvider :sensors="sensors" @drag-start="dragging = true" @drag-end="onDragEnd">
            <div ref="stackList" class="stack-list" :class="{ scrollbar: scrollbar }" :style="stackListStyle">
                <div v-if="agentStackList[0] && agentStackList[0].stacks.length === 0" class="text-center mt-3">
                    <router-link to="/compose">{{ $t("addFirstStackMsg") }}</router-link>
                </div>
                <div v-for="(agent, agentIndex) in agentStackList" :key="agentIndex" class="stack-list-inner">
                    <div
                        v-if="$root.agentCount > 1" class="p-2 agent-select"
                        @click="closedAgents.set(agent.endpoint, !closedAgents.get(agent.endpoint))"
                    >
                        <span class="me-1">
                            <font-awesome-icon v-show="closedAgents.get(agent.endpoint)" icon="chevron-circle-right" />
                            <font-awesome-icon v-show="!closedAgents.get(agent.endpoint)" icon="chevron-circle-down" />
                        </span>
                        <span v-if="agent.endpoint === 'current'">{{ $t("currentEndpoint") }}</span>
                        <span v-else>{{ agent.endpoint }}</span>
                    </div>
                    <div v-show="$root.agentCount === 1 || !closedAgents.get(agent.endpoint)">
                        <!-- New top level folder -->
                        <FolderNameInput
                            v-if="isEditingFolder(agent.endpoint, '')"
                            :initial="folderEdit.initial"
                            :placeholder="$t('newFolderPlaceholder')"
                            @submit="submitFolderEdit"
                            @cancel="folderEdit = null"
                        />

                        <!-- Virtual folders (x-dockge.folder + empty folders); drag & drop with dnd-kit -->
                        <StackFolder
                            v-for="folder in agent.tree.folders"
                            :key="folder.path"
                            :node="folder"
                            :endpoint="agent.endpoint"
                            :is-open="(path) => isFolderOpen(agent.endpoint, path)"
                            :item-props="itemProps"
                            @toggle="toggleFolder(agent.endpoint, $event)"
                            @new-folder="startCreateFolder(agent.endpoint, $event)"
                            @rename-folder="startRenameFolder(agent.endpoint, $event)"
                            @delete-folder="deleteFolder(agent.endpoint, $event)"
                        >
                            <template #before-children="{ path }">
                                <FolderNameInput
                                    v-if="isEditingFolder(agent.endpoint, path)"
                                    :initial="folderEdit.initial"
                                    :depth="path.split('/').length"
                                    :placeholder="$t('newFolderPlaceholder')"
                                    @submit="submitFolderEdit"
                                    @cancel="folderEdit = null"
                                />
                            </template>
                        </StackFolder>

                        <!-- Stacks managed by Dockge, not in a folder -->
                        <StackListItem
                            v-for="item in agent.tree.stacks"
                            :key="item.name" :stack="item" :isSelectMode="selectMode"
                            :isSelected="isSelected" :select="select" :deselect="deselect"
                        />

                        <!-- While dragging (below the list, so nothing moves under the pointer): drop here for the top level -->
                        <StackRootDropZone v-if="dragging" :endpoint="agent.endpoint" />

                        <!-- Stacks not managed by Dockge (e.g. started from another folder or by another tool) -->
                        <div v-if="agent.unmanaged.length > 0 || agent.truenasApps.length > 0" class="stack-group">
                            <div class="group-header" @click="toggleGroup(agent.endpoint, 'unmanaged')">
                                <font-awesome-icon class="me-2 chevron" :class="{ open: isGroupOpen(agent.endpoint, 'unmanaged') }" icon="chevron-right" />
                                <font-awesome-icon class="me-2" icon="box-archive" />
                                <span class="group-name">{{ $t("unmanagedStacks") }}</span>
                                <span class="badge rounded-pill group-count">{{ agent.unmanaged.length + agent.truenasApps.length }}</span>
                            </div>
                            <div v-show="isGroupOpen(agent.endpoint, 'unmanaged')">
                                <StackListItem
                                    v-for="item in agent.unmanaged"
                                    :key="item.name" :stack="item" :depth="1" :isSelectMode="selectMode"
                                    :isSelected="isSelected" :select="select" :deselect="deselect"
                                />

                                <!-- TrueNAS SCALE apps are compose projects named "ix-<app>" -->
                                <div v-if="agent.truenasApps.length > 0" class="stack-group">
                                    <div class="group-header sub" @click="toggleGroup(agent.endpoint, 'truenas')">
                                        <font-awesome-icon class="me-2 chevron" :class="{ open: isGroupOpen(agent.endpoint, 'truenas') }" icon="chevron-right" />
                                        <span class="group-name">{{ $t("truenasApps") }}</span>
                                        <span class="badge rounded-pill group-count">{{ agent.truenasApps.length }}</span>
                                    </div>
                                    <div v-show="isGroupOpen(agent.endpoint, 'truenas')">
                                        <StackListItem
                                            v-for="item in agent.truenasApps"
                                            :key="item.name" :stack="item" :depth="2" :isSelectMode="selectMode"
                                            :isSelected="isSelected" :select="select" :deselect="deselect"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </DragDropProvider>
    </div>

    <Confirm ref="confirmPause" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="pauseSelected">
        {{ $t("pauseStackMsg") }}
    </Confirm>
</template>

<script>
import Confirm from "../components/Confirm.vue";
import StackListItem from "../components/StackListItem.vue";
import StackFolder from "../components/StackFolder.vue";
import StackRootDropZone from "../components/StackRootDropZone.vue";
import FolderNameInput from "../components/FolderNameInput.vue";
import { DragDropProvider, KeyboardSensor, PointerSensor } from "@dnd-kit/vue";
import { PointerActivationConstraints } from "@dnd-kit/dom";
import { CREATED_FILE, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../../../common/util-common";

const OPEN_GROUPS_KEY = "dockge.sidebar.openGroups";

/**
 * TrueNAS SCALE (24.10+) runs its apps as docker compose projects named "ix-<app name>"
 * @param {object} stack Stack
 * @returns {boolean} true if the stack is a TrueNAS app
 */
function isTrueNASApp(stack) {
    return stack.name.startsWith("ix-");
}

/**
 * Build the tree of virtual folders. Folders are sorted by name, stacks keep the order of the list.
 * @param {object[]} stacks Sorted stacks
 * @returns {object} Root node { folders, stacks }
 */
function buildFolderTree(stacks, extraFolders = []) {
    const root = {
        name: "",
        path: "",
        folders: [],
        stacks: [],
        count: 0,
        children: new Map(),
    };

    const ensure = (folder) => {
        let node = root;
        let currentPath = "";
        for (const part of folder.split("/")) {
            currentPath = currentPath ? currentPath + "/" + part : part;
            if (!node.children.has(part)) {
                const child = {
                    name: part,
                    path: currentPath,
                    folders: [],
                    stacks: [],
                    count: 0,
                    children: new Map(),
                };
                node.children.set(part, child);
                node.folders.push(child);
            }
            node = node.children.get(part);
        }
        return node;
    };

    // Empty folders first, so they exist even without stacks
    for (const folder of extraFolders) {
        ensure(folder);
    }

    for (const stack of stacks) {
        let node = root;
        if (stack.folder) {
            let currentPath = "";
            for (const part of stack.folder.split("/")) {
                currentPath = currentPath ? currentPath + "/" + part : part;
                if (!node.children.has(part)) {
                    const child = {
                        name: part,
                        path: currentPath,
                        folders: [],
                        stacks: [],
                        count: 0,
                        children: new Map(),
                    };
                    node.children.set(part, child);
                    node.folders.push(child);
                }
                node = node.children.get(part);
                node.count++;
            }
        }
        node.stacks.push(stack);
    }

    const sortFolders = (node) => {
        node.folders.sort((a, b) => a.name.localeCompare(b.name));
        node.folders.forEach(sortFolders);
    };
    sortFolders(root);
    return root;
}

/**
 * @returns {object} Open/closed state of the groups in the stack list
 */
function loadOpenGroups() {
    try {
        const value = JSON.parse(window.localStorage.getItem(OPEN_GROUPS_KEY));
        if (value && typeof value === "object") {
            return value;
        }
    } catch (e) {
        // ignore
    }
    return {};
}

export default {
    components: {
        Confirm,
        StackListItem,
        StackFolder,
        StackRootDropZone,
        FolderNameInput,
        DragDropProvider,
    },
    props: {
        /** Should the scrollbar be shown */
        scrollbar: {
            type: Boolean,
        },
    },
    data() {
        return {
            searchText: "",
            selectMode: false,
            selectAll: false,
            disableSelectAllWatcher: false,
            selectedStacks: {},
            windowTop: 0,
            filterState: {
                status: null,
                active: null,
                tags: null,
            },
            closedAgents: new Map(),
            openGroups: loadOpenGroups(),
            dragging: false,
            // Inline folder name editor: { endpoint, parent, mode: "create" | "rename", path, initial }
            folderEdit: null,
            // A drag starts after moving the pointer 6px, so a click still opens the stack
            sensors: [
                PointerSensor.configure({
                    activationConstraints: () => [ new PointerActivationConstraints.Distance({ value: 6 }) ],
                }),
                KeyboardSensor,
            ],
        };
    },
    computed: {
        itemProps() {
            return {
                isSelectMode: this.selectMode,
                isSelected: this.isSelected,
                select: this.select,
                deselect: this.deselect,
            };
        },

        /**
         * Improve the sticky appearance of the list by increasing its
         * height as user scrolls down.
         * Not used on mobile.
         * @returns {object} Style for stack list
         */
        boxStyle() {
            if (window.innerWidth > 550) {
                return {
                    height: `calc(100vh - 160px + ${this.windowTop}px)`,
                };
            } else {
                return {
                    height: "calc(100vh - 160px)",
                };
            }

        },

        /**
         * Returns a sorted list of stacks based on the applied filters and search text.
         * @returns {Array} The sorted list of stacks.
         */
        agentStackList() {
            let result = Object.values(this.$root.completeStackList);

            result = result.filter(stack => {
                // filter by search text
                // finds stack name, tag name or tag value
                let searchTextMatch = true;
                if (this.searchText !== "") {
                    const loweredSearchText = this.searchText.toLowerCase();
                    searchTextMatch =
                        stack.name.toLowerCase().includes(loweredSearchText)
                        || stack.folder?.toLowerCase().includes(loweredSearchText)
                        || stack.tags.find(tag => tag.name.toLowerCase().includes(loweredSearchText)
                            || tag.value?.toLowerCase().includes(loweredSearchText));
                }

                // filter by active
                let activeMatch = true;
                if (this.filterState.active != null && this.filterState.active.length > 0) {
                    activeMatch = this.filterState.active.includes(stack.active);
                }

                // filter by tags
                let tagsMatch = true;
                if (this.filterState.tags != null && this.filterState.tags.length > 0) {
                    tagsMatch = stack.tags.map(tag => tag.tag_id) // convert to array of tag IDs
                        .filter(stackTagId => this.filterState.tags.includes(stackTagId)) // perform Array Intersaction between filter and stack's tags
                        .length > 0;
                }

                return searchTextMatch && activeMatch && tagsMatch;
            });

            result.sort((m1, m2) => {

                // sort by managed by dockge
                if (m1.isManagedByDockge && !m2.isManagedByDockge) {
                    return -1;
                } else if (!m1.isManagedByDockge && m2.isManagedByDockge) {
                    return 1;
                }

                // sort by status
                if (m1.status !== m2.status) {
                    if (m2.status === RUNNING) {
                        return 1;
                    } else if (m1.status === RUNNING) {
                        return -1;
                    } else if (m2.status === EXITED) {
                        return 1;
                    } else if (m1.status === EXITED) {
                        return -1;
                    } else if (m2.status === CREATED_STACK) {
                        return 1;
                    } else if (m1.status === CREATED_STACK) {
                        return -1;
                    } else if (m2.status === CREATED_FILE) {
                        return 1;
                    } else if (m1.status === CREATED_FILE) {
                        return -1;
                    } else if (m2.status === UNKNOWN) {
                        return 1;
                    } else if (m1.status === UNKNOWN) {
                        return -1;
                    }
                }
                return m1.name.localeCompare(m2.name);
            });

            // Group stacks by endpoint, sorting them so the local endpoint is first
            // and the rest are sorted alphabetically
            result = [
                ...result.reduce((acc, stack) => {
                    const endpoint = stack.endpoint || "current";
                    if (!acc.has(endpoint)) {
                        acc.set(endpoint, []);
                    }
                    acc.get(endpoint).push(stack);
                    return acc;
                }, new Map()).entries()
            ].map(([ endpoint, stacks ]) => ({
                endpoint,
                stacks,
                managed: stacks.filter(stack => stack.isManagedByDockge),
                tree: buildFolderTree(
                    stacks.filter(stack => stack.isManagedByDockge),
                    // Stored folders (also empty ones); hidden while searching unless they match
                    (this.$root.folderLists[endpoint] ?? []).filter(folder => this.searchText === "" || folder.toLowerCase().includes(this.searchText.toLowerCase()))
                ),
                unmanaged: stacks.filter(stack => !stack.isManagedByDockge && !isTrueNASApp(stack)),
                truenasApps: stacks.filter(stack => !stack.isManagedByDockge && isTrueNASApp(stack)),
            })).sort((a, b) => {
                if (a.endpoint === "current" && b.endpoint !== "current") {
                    return -1;
                } else if (a.endpoint !== "current" && b.endpoint === "current") {
                    return 1;
                }
                return a.endpoint.localeCompare(b.endpoint);
            });

            return result;
        },

        isDarkTheme() {
            return document.body.classList.contains("dark");
        },

        stackListStyle() {
            //let listHeaderHeight = 107;
            let listHeaderHeight = 60;

            if (this.selectMode) {
                listHeaderHeight += 42;
            }

            return {
                "height": `calc(100% - ${listHeaderHeight}px)`
            };
        },

        selectedStackCount() {
            return Object.keys(this.selectedStacks).length;
        },

        /**
         * Determines if any filters are active.
         * @returns {boolean} True if any filter is active, false otherwise.
         */
        filtersActive() {
            return this.filterState.status != null || this.filterState.active != null || this.filterState.tags != null || this.searchText !== "";
        }
    },
    watch: {
        searchText() {
            for (let stack of this.agentStackList) {
                if (!this.selectedStacks[stack.id]) {
                    if (this.selectAll) {
                        this.disableSelectAllWatcher = true;
                        this.selectAll = false;
                    }
                    break;
                }
            }
        },
        selectAll() {
            if (!this.disableSelectAllWatcher) {
                this.selectedStacks = {};

                if (this.selectAll) {
                    this.agentStackList.forEach((item) => {
                        this.selectedStacks[item.id] = true;
                    });
                }
            } else {
                this.disableSelectAllWatcher = false;
            }
        },
        selectMode() {
            if (!this.selectMode) {
                this.selectAll = false;
                this.selectedStacks = {};
            }
        },
    },
    mounted() {
        window.addEventListener("scroll", this.onScroll);
    },
    beforeUnmount() {
        window.removeEventListener("scroll", this.onScroll);
    },
    methods: {
        /**
         * Is a group of the stack list expanded? Groups are always expanded while searching.
         * @param {string} endpoint Endpoint
         * @param {string} group Group name
         * @returns {boolean} true if expanded
         */
        isGroupOpen(endpoint, group) {
            return this.searchText !== "" || !!this.openGroups[endpoint + "|" + group];
        },

        /**
         * Expand / collapse a group and remember it
         * @param {string} endpoint Endpoint
         * @param {string} group Group name
         * @returns {void}
         */
        toggleGroup(endpoint, group) {
            const key = endpoint + "|" + group;
            this.openGroups[key] = !this.openGroups[key];
            try {
                window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(this.openGroups));
            } catch (e) {
                // ignore
            }
        },

        /**
         * Folders are open unless the user closed them, and always open while searching
         * @param {string} endpoint Endpoint
         * @param {string} path Folder path
         * @returns {boolean} true if open
         */
        isFolderOpen(endpoint, path) {
            return this.searchText !== "" || this.openGroups[endpoint + "|folder:" + path] !== false;
        },

        toggleFolder(endpoint, path) {
            const key = endpoint + "|folder:" + path;
            this.openGroups[key] = !this.isFolderOpen(endpoint, path);
            try {
                window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(this.openGroups));
            } catch (e) {
                // ignore
            }
        },

        /**
         * End of a drag & drop (dnd-kit): move a stack or a folder into the folder it was dropped on
         * @param {object} event dnd-kit drag end event
         * @returns {void}
         */
        onDragEnd(event) {
            this.dragging = false;
            if (event.canceled) {
                return;
            }
            const source = event.operation.source?.data;
            const target = event.operation.target?.data;
            if (!source || !target || target.kind !== "folder") {
                return;
            }
            if (source.endpoint !== target.endpoint) {
                this.$root.toastError(this.$t("moveAcrossInstances"));
                return;
            }
            const endpoint = source.endpoint === "current" ? "" : source.endpoint;
            const done = (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                }
            };

            if (source.kind === "stack") {
                if (source.folder === target.path) {
                    return;
                }
                this.openFolderPath(source.endpoint, target.path);
                this.$root.emitAgent(endpoint, "setStackFolder", source.name, target.path, done);
            } else if (source.kind === "folder") {
                // Dropped on itself or inside itself
                if (target.path === source.path || target.path.startsWith(source.path + "/")) {
                    return;
                }
                const name = source.path.split("/").pop();
                const newPath = target.path ? target.path + "/" + name : name;
                if (newPath === source.path) {
                    return;
                }
                this.openFolderPath(source.endpoint, target.path);
                this.$root.emitAgent(endpoint, "renameStackFolder", source.path, newPath, done);
            }
        },

        /**
         * Expand a folder and its parents (so a moved item stays visible)
         * @param {string} endpoint Endpoint
         * @param {string} path Folder path
         * @returns {void}
         */
        openFolderPath(endpoint, path) {
            if (!path) {
                return;
            }
            const parts = path.split("/");
            for (let i = 1; i <= parts.length; i++) {
                this.openGroups[endpoint + "|folder:" + parts.slice(0, i).join("/")] = true;
            }
            this.saveOpenGroups();
        },

        saveOpenGroups() {
            try {
                window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(this.openGroups));
            } catch (e) {
                // ignore
            }
        },

        isEditingFolder(endpoint, parent) {
            return this.folderEdit !== null && this.folderEdit.endpoint === endpoint && this.folderEdit.parent === parent;
        },

        startCreateFolder(endpoint, parent) {
            if (this.$root.agentCount > 1 && endpoint === "current" && parent === "") {
                // Several instances: the header button creates the folder in this instance
                this.closedAgents.set("current", false);
            }
            this.openFolderPath(endpoint, parent);
            this.folderEdit = {
                endpoint,
                parent,
                mode: "create",
                path: "",
                initial: "",
            };
        },

        startRenameFolder(endpoint, path) {
            const parts = path.split("/");
            this.folderEdit = {
                endpoint,
                parent: parts.slice(0, -1).join("/"),
                mode: "rename",
                path,
                initial: parts[parts.length - 1],
            };
        },

        /**
         * Create or rename the folder typed in the inline editor
         * @param {string} name Name typed by the user ("/" allowed to create several levels)
         * @returns {void}
         */
        submitFolderEdit(name) {
            const edit = this.folderEdit;
            this.folderEdit = null;
            if (!edit) {
                return;
            }
            const endpoint = edit.endpoint === "current" ? "" : edit.endpoint;
            const newPath = edit.parent ? edit.parent + "/" + name : name;
            const done = (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                }
            };
            if (edit.mode === "create") {
                this.openFolderPath(edit.endpoint, newPath);
                this.$root.emitAgent(endpoint, "createStackFolder", newPath, done);
            } else {
                this.$root.emitAgent(endpoint, "renameStackFolder", edit.path, newPath, done);
            }
        },

        deleteFolder(endpoint, path) {
            if (!confirm(this.$t("deleteFolderConfirm", [ path ]))) {
                return;
            }
            this.$root.emitAgent(endpoint === "current" ? "" : endpoint, "deleteStackFolder", path, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Handle user scroll
         * @returns {void}
         */
        onScroll() {
            if (window.top.scrollY <= 133) {
                this.windowTop = window.top.scrollY;
            } else {
                this.windowTop = 133;
            }
        },

        /**
         * Clear the search bar
         * @returns {void}
         */
        clearSearchText() {
            this.searchText = "";
        },
        /**
         * Update the StackList Filter
         * @param {object} newFilter Object with new filter
         * @returns {void}
         */
        updateFilter(newFilter) {
            this.filterState = newFilter;
        },
        /**
         * Deselect a stack
         * @param {number} id ID of stack
         * @returns {void}
         */
        deselect(id) {
            delete this.selectedStacks[id];
        },
        /**
         * Select a stack
         * @param {number} id ID of stack
         * @returns {void}
         */
        select(id) {
            this.selectedStacks[id] = true;
        },
        /**
         * Determine if stack is selected
         * @param {number} id ID of stack
         * @returns {bool} Is the stack selected?
         */
        isSelected(id) {
            return id in this.selectedStacks;
        },
        /**
         * Disable select mode and reset selection
         * @returns {void}
         */
        cancelSelectMode() {
            this.selectMode = false;
            this.selectedStacks = {};
        },
        /**
         * Show dialog to confirm pause
         * @returns {void}
         */
        pauseDialog() {
            this.$refs.confirmPause.show();
        },
        /**
         * Pause each selected stack
         * @returns {void}
         */
        pauseSelected() {
            Object.keys(this.selectedStacks)
                .filter(id => this.$root.stackList[id].active)
                .forEach(id => this.$root.getSocket().emit("pauseStack", id, () => { }));

            this.cancelSelectMode();
        },
        /**
         * Resume each selected stack
         * @returns {void}
         */
        resumeSelected() {
            Object.keys(this.selectedStacks)
                .filter(id => !this.$root.stackList[id].active)
                .forEach(id => this.$root.getSocket().emit("resumeStack", id, () => { }));

            this.cancelSelectMode();
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.shadow-box {
    height: calc(100vh - 150px);
    position: sticky;
    top: 10px;
}

.small-padding {
    padding-left: 5px !important;
    padding-right: 5px !important;
}

.list-header {
    border-bottom: 1px solid #dee2e6;
    border-radius: 10px 10px 0 0;
    margin: -10px;
    margin-bottom: 10px;
    padding: 10px;

    .dark & {
        background-color: $dark-header-bg;
        border-bottom: 0;
    }
}

.header-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.header-filter {
    display: flex;
    align-items: center;
}

@media (max-width: 770px) {
    .list-header {
        margin: -20px;
        margin-bottom: 10px;
        padding: 5px;
    }
}

.search-wrapper {
    display: flex;
    align-items: center;
}

.search-icon {
    padding: 10px;
    color: #c0c0c0;

    // Clear filter button (X)
    svg[data-icon="times"] {
        cursor: pointer;
        transition: all ease-in-out 0.1s;

        &:hover {
            opacity: 0.5;
        }
    }
}

.search-input {
    max-width: 15em;
}

.stack-item {
    width: 100%;
}

.tags {
    margin-top: 4px;
    padding-left: 67px;
    display: flex;
    flex-wrap: wrap;
    gap: 0;
}

.bottom-style {
    padding-left: 67px;
    margin-top: 5px;
}

.selection-controls {
    margin-top: 5px;
    display: flex;
    align-items: center;
    gap: 10px;
}

.group-header {
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    color: $dark-font-color3;
    padding: 8px 10px;
    display: flex;
    align-items: center;
    user-select: none;
    border-radius: 10px;

    &:hover {
        background-color: $highlight-white;

        .dark & {
            background-color: $dark-header-bg;
        }
    }

    &.sub {
        padding-left: 24px;
    }

    .chevron {
        transition: transform 0.15s ease-in-out;
        width: 10px;

        &.open {
            transform: rotate(90deg);
        }
    }

    .group-name {
        flex: 1;
    }

    .group-count {
        background-color: rgba(128, 128, 128, 0.25);
        color: inherit;
        font-weight: 600;
        font-size: 11px;

        .dark & {
            color: $dark-font-color;
        }
    }
}

.root-drop-zone {
    margin: 4px 0 8px;
    padding: 8px;
    text-align: center;
    font-size: 13px;
    color: $dark-font-color3;
    border: 1px dashed rgba(128, 128, 128, 0.5);
    border-radius: 10px;

    &.drop-target {
        border-color: $primary;
        background-color: rgba($primary, 0.15);
    }
}

.agent-select {
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    color: $dark-font-color3;
    padding-left: 10px;
    padding-right: 10px;
    display: flex;
    align-items: center;
    user-select: none;
}
</style>
