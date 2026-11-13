<template>
    <div class="container-fluid">
        <div class="dashboard-layout">
            <!-- Sidebar: stack list -->
            <aside
                v-if="!$root.isMobile"
                class="sidebar"
                :class="{ collapsed: sidebarCollapsed }"
                :style="sidebarStyle"
            >
                <template v-if="!sidebarCollapsed">
                    <div class="sidebar-top mb-3">
                        <router-link to="/compose" class="btn btn-primary"><font-awesome-icon icon="plus" /> {{ $t("compose") }}</router-link>
                        <button type="button" class="btn btn-normal btn-sm" :title="$t('collapseSidebar')" @click="setCollapsed(true)">
                            <font-awesome-icon icon="angles-left" />
                        </button>
                    </div>
                    <StackList :scrollbar="true" />
                </template>

                <!-- Collapsed rail -->
                <div v-else class="sidebar-rail">
                    <button type="button" class="btn btn-normal btn-sm" :title="$t('expandSidebar')" @click="setCollapsed(false)">
                        <font-awesome-icon icon="angles-right" />
                    </button>
                    <router-link to="/compose" class="btn btn-primary btn-sm" :title="$t('compose')">
                        <font-awesome-icon icon="plus" />
                    </router-link>
                </div>

                <div
                    v-if="!sidebarCollapsed"
                    class="sidebar-resizer"
                    :title="$t('dragToResize')"
                    @pointerdown="startResize"
                    @dblclick="resetWidth"
                ></div>
            </aside>

            <div ref="container" class="dashboard-content mb-3">
                <!-- Add :key to disable vue router re-use the same component -->
                <router-view :key="$route.fullPath" :calculatedHeight="height" />
            </div>
        </div>
    </div>
</template>

<script>

import StackList from "../components/StackList.vue";

const WIDTH_KEY = "dockge.sidebar.width";
const COLLAPSED_KEY = "dockge.sidebar.collapsed";
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 220;

/**
 * Read a value from localStorage, ignoring errors (private mode, blocked storage...)
 * @param {string} key Key
 * @returns {string|null} Value
 */
function readStorage(key) {
    try {
        return window.localStorage.getItem(key);
    } catch (e) {
        return null;
    }
}

/**
 * Write a value to localStorage, ignoring errors
 * @param {string} key Key
 * @param {string} value Value
 * @returns {void}
 */
function writeStorage(key, value) {
    try {
        window.localStorage.setItem(key, value);
    } catch (e) {
        // ignore
    }
}

export default {
    components: {
        StackList,
    },
    data() {
        const width = Number(readStorage(WIDTH_KEY));
        return {
            height: 0,
            sidebarWidth: width >= MIN_WIDTH ? width : DEFAULT_WIDTH,
            sidebarCollapsed: readStorage(COLLAPSED_KEY) === "1",
            resizing: false,
        };
    },
    computed: {
        sidebarStyle() {
            if (this.sidebarCollapsed) {
                return {};
            }
            return {
                "--sidebar-width": this.sidebarWidth + "px",
            };
        },
    },
    mounted() {
        this.height = this.$refs.container.offsetHeight;
    },
    beforeUnmount() {
        this.stopResize();
    },
    methods: {
        setCollapsed(value) {
            this.sidebarCollapsed = value;
            writeStorage(COLLAPSED_KEY, value ? "1" : "0");
        },

        maxWidth() {
            return Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.6));
        },

        startResize(e) {
            e.preventDefault();
            this.resizeStartX = e.clientX;
            this.resizeStartWidth = this.sidebarWidth;
            this.resizing = true;
            window.addEventListener("pointermove", this.onResize);
            window.addEventListener("pointerup", this.stopResize);
            document.body.classList.add("resizing-horizontal");
        },

        onResize(e) {
            const width = this.resizeStartWidth + (e.clientX - this.resizeStartX);
            this.sidebarWidth = Math.min(this.maxWidth(), Math.max(MIN_WIDTH, Math.round(width)));
        },

        stopResize() {
            window.removeEventListener("pointermove", this.onResize);
            window.removeEventListener("pointerup", this.stopResize);
            document.body.classList.remove("resizing-horizontal");
            if (this.resizing) {
                this.resizing = false;
                writeStorage(WIDTH_KEY, String(this.sidebarWidth));
            }
        },

        resetWidth() {
            this.sidebarWidth = DEFAULT_WIDTH;
            writeStorage(WIDTH_KEY, String(DEFAULT_WIDTH));
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.container-fluid {
    width: 98%;
}

.dashboard-layout {
    display: flex;
    align-items: flex-start;
    gap: 24px;
}

.sidebar {
    position: relative;
    flex: 0 0 var(--sidebar-width, 340px);
    width: var(--sidebar-width, 340px);
    min-width: 0;

    &.collapsed {
        flex: 0 0 auto;
        width: auto;
    }
}

.sidebar-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.sidebar-rail {
    position: sticky;
    top: 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
}

// Drag handle on the right edge of the sidebar
.sidebar-resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    right: -16px;
    width: 8px;
    cursor: ew-resize;
    border-radius: 4px;
    transition: background-color 0.15s;

    &:hover {
        background-color: rgba($primary, 0.35);
    }
}

.dashboard-content {
    flex: 1 1 auto;
    min-width: 0;
}

// Small screens: stack the list above the content, like before
@media (max-width: 767.98px) {
    .dashboard-layout {
        flex-direction: column;
        align-items: stretch;
    }

    .sidebar {
        flex: 0 0 auto;
        width: 100%;
    }

    .sidebar-resizer {
        display: none;
    }

    .sidebar-rail {
        flex-direction: row;
    }
}
</style>

<style lang="scss">
body.resizing-horizontal {
    cursor: ew-resize !important;
    user-select: none;
}
</style>
