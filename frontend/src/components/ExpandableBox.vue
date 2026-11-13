<template>
    <!-- When expanded, the content is moved to <body> (without re-creating it) so that it can cover the whole viewport -->
    <Teleport to="body" :disabled="!expanded">
        <div class="expandable-box" :class="{ expanded }" v-bind="$attrs">
            <div class="expandable-header">
                <div class="expandable-title">
                    <slot name="title" :expanded="expanded">
                        <component :is="titleTag" class="mb-0">{{ title }}</component>
                    </slot>
                </div>
                <div class="expandable-actions">
                    <slot name="actions" :expanded="expanded"></slot>
                    <button
                        type="button"
                        class="btn btn-sm btn-normal"
                        :title="expanded ? $t('exitFullscreen') : $t('fullscreen')"
                        @click="toggle"
                    >
                        <font-awesome-icon :icon="expanded ? 'compress' : 'expand'" />
                    </button>
                </div>
            </div>

            <div ref="body" class="expandable-body" :class="{ 'fixed-height': fixedHeight }" :style="bodyStyle">
                <slot :expanded="expanded"></slot>
            </div>

            <div
                v-if="resizable && !expanded"
                class="resize-handle"
                :title="$t('dragToResize')"
                @pointerdown="startResize"
                @dblclick="resetHeight"
            ></div>

            <slot name="footer" :expanded="expanded"></slot>
        </div>
    </Teleport>
</template>

<script>
const STORAGE_PREFIX = "dockge.boxHeight.";

export default {
    inheritAttrs: false,
    props: {
        title: {
            type: String,
            default: "",
        },
        titleTag: {
            type: String,
            default: "h4",
        },
        /** Allow changing the height by dragging the bottom edge */
        resizable: {
            type: Boolean,
            default: false,
        },
        /** Initial body height in px. 0 = auto (grows with the content) */
        height: {
            type: Number,
            default: 0,
        },
        minHeight: {
            type: Number,
            default: 120,
        },
        /** If set, the height chosen by the user is remembered in localStorage under this key */
        storageKey: {
            type: String,
            default: "",
        },
    },
    emits: [ "update:expanded" ],
    data() {
        return {
            expanded: false,
            currentHeight: this.loadHeight(),
        };
    },
    computed: {
        fixedHeight() {
            return this.expanded || this.currentHeight > 0;
        },
        bodyStyle() {
            if (this.expanded || this.currentHeight <= 0) {
                return {};
            }
            return {
                height: this.currentHeight + "px",
            };
        },
    },
    watch: {
        expanded(value) {
            document.body.classList.toggle("expandable-box-open", value);
            this.$emit("update:expanded", value);
        },
    },
    mounted() {
        window.addEventListener("keydown", this.onKeyDown);
    },
    beforeUnmount() {
        window.removeEventListener("keydown", this.onKeyDown);
        this.stopResize();
        if (this.expanded) {
            document.body.classList.remove("expandable-box-open");
        }
    },
    methods: {
        toggle() {
            this.expanded = !this.expanded;
        },

        onKeyDown(e) {
            // Editors and terminals call preventDefault() when they use the Escape key themselves (e.g. vim, CodeMirror search)
            if (this.expanded && e.key === "Escape" && !e.defaultPrevented) {
                this.expanded = false;
            }
        },

        loadHeight() {
            if (this.storageKey) {
                try {
                    const value = Number(window.localStorage.getItem(STORAGE_PREFIX + this.storageKey));
                    if (value > 0) {
                        return Math.max(value, this.minHeight);
                    }
                } catch (e) {
                    // localStorage not available
                }
            }
            return this.height;
        },

        saveHeight() {
            if (!this.storageKey) {
                return;
            }
            try {
                window.localStorage.setItem(STORAGE_PREFIX + this.storageKey, String(this.currentHeight));
            } catch (e) {
                // localStorage not available
            }
        },

        resetHeight() {
            this.currentHeight = this.height;
            if (this.storageKey) {
                try {
                    window.localStorage.removeItem(STORAGE_PREFIX + this.storageKey);
                } catch (e) {
                    // localStorage not available
                }
            }
        },

        startResize(e) {
            e.preventDefault();
            this.resizeStartY = e.clientY;
            this.resizeStartHeight = this.$refs.body?.getBoundingClientRect().height ?? this.currentHeight;
            window.addEventListener("pointermove", this.onResize);
            window.addEventListener("pointerup", this.stopResize);
            document.body.classList.add("resizing-vertical");
        },

        onResize(e) {
            const delta = e.clientY - this.resizeStartY;
            this.currentHeight = Math.max(this.minHeight, Math.round(this.resizeStartHeight + delta));
        },

        stopResize() {
            window.removeEventListener("pointermove", this.onResize);
            window.removeEventListener("pointerup", this.stopResize);
            if (document.body.classList.contains("resizing-vertical")) {
                document.body.classList.remove("resizing-vertical");
                this.saveHeight();
            }
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.expandable-box {
    position: relative;
    display: flex;
    flex-direction: column;

    &.expanded {
        position: fixed;
        inset: 0;
        margin: 0 !important;
        z-index: 1060;
        padding: 12px 16px 16px;
        background-color: #fff;

        .dark & {
            background-color: $dark-bg;
        }
    }
}

.expandable-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
}

.expandable-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

.expandable-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-left: auto;
}

.expandable-body {
    position: relative;

    &.fixed-height {
        min-height: 0;

        // Make the direct child (editor box / terminal) fill the body
        > :deep(*) {
            height: 100%;
        }
    }

    .expanded & {
        flex: 1;
    }
}

.resize-handle {
    height: 10px;
    margin-top: -4px;
    margin-bottom: 8px;
    cursor: ns-resize;
    border-radius: 5px;
    position: relative;

    &::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 3px;
        width: 48px;
        height: 4px;
        margin-left: -24px;
        border-radius: 2px;
        background-color: rgba(128, 128, 128, 0.35);
        transition: background-color 0.15s;
    }

    &:hover::after {
        background-color: $primary;
    }
}
</style>

<style lang="scss">
body.expandable-box-open {
    overflow: hidden;
}

body.resizing-vertical {
    cursor: ns-resize !important;
    user-select: none;
}
</style>
