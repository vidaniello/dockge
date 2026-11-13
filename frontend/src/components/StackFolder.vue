<template>
    <div class="stack-folder" :class="{ 'drag-source': isDragSource }">
        <div
            ref="header"
            class="folder-header"
            :class="dropClass"
            :style="{ paddingLeft: (10 + 16 * depth) + 'px' }"
            @click="renaming ? null : $emit('toggle', node.path)"
        >
            <font-awesome-icon class="me-2 chevron" :class="{ open }" icon="chevron-right" />
            <font-awesome-icon class="me-2 folder-icon" :icon="open ? 'folder-open' : 'folder'" />

            <!-- Rename on the folder's own row -->
            <input
                v-if="renaming"
                ref="renameInput"
                v-model="renameValue"
                class="form-control form-control-sm rename-input"
                maxlength="200"
                @click.stop
                @pointerdown.stop
                @keydown.enter.prevent="submitRename"
                @keydown.esc.prevent="cancelRename"
                @blur="submitRename"
            />
            <span v-else class="folder-name">{{ node.name }}</span>

            <span v-if="!renaming" class="folder-actions">
                <button type="button" class="action" :title="$t('newSubfolder')" :aria-label="$t('newSubfolder')" @click.stop="$emit('new-folder', node.path)">
                    <font-awesome-icon icon="folder-plus" />
                </button>
                <button type="button" class="action" :title="$t('renameFolder')" :aria-label="$t('renameFolder')" @click.stop="$emit('rename-folder', node.path)">
                    <font-awesome-icon icon="pen" />
                </button>
                <button v-if="node.count === 0" type="button" class="action danger" :title="$t('deleteFolder')" :aria-label="$t('deleteFolder')" @click.stop="$emit('delete-folder', node.path)">
                    <font-awesome-icon icon="trash" />
                </button>
            </span>
            <span v-if="node.count > 0 && !renaming" class="badge rounded-pill folder-count ms-2">{{ node.count }}</span>
        </div>

        <div v-show="open">
            <slot name="before-children" :path="node.path"></slot>
            <template v-for="item in node.items" :key="item.key">
                <StackFolder
                    v-if="item.type === 'folder'"
                    :node="item.node"
                    :parent="node.path"
                    :depth="depth + 1"
                    :endpoint="endpoint"
                    :is-open="isOpen"
                    :item-props="itemProps"
                    :renaming-path="renamingPath"
                    @toggle="$emit('toggle', $event)"
                    @new-folder="$emit('new-folder', $event)"
                    @rename-folder="$emit('rename-folder', $event)"
                    @rename-submit="$emit('rename-submit', $event)"
                    @rename-cancel="$emit('rename-cancel')"
                    @delete-folder="$emit('delete-folder', $event)"
                >
                    <template #before-children="slotProps">
                        <slot name="before-children" v-bind="slotProps"></slot>
                    </template>
                </StackFolder>
                <StackListItem
                    v-else
                    :stack="item.stack"
                    :parent="node.path"
                    :depth="depth + 1"
                    v-bind="itemProps"
                />
            </template>
            <div v-if="node.items.length === 0" class="empty-folder" :style="{ paddingLeft: (36 + 16 * depth) + 'px' }">
                {{ $t("emptyFolder") }}
            </div>
        </div>
    </div>
</template>

<script>
import { computed, inject, ref } from "vue";
import { useDraggable, useDroppable } from "@dnd-kit/vue";
import StackListItem from "./StackListItem.vue";

/**
 * A virtual folder of the sidebar. Its header can be dragged (to move or reorder the folder)
 * and is a drop target: before / after it, or into it (dnd-kit, the drop is handled in StackList.vue).
 */
export default {
    name: "StackFolder",
    components: {
        StackListItem,
    },
    props: {
        /** { name, path, items: [], count } */
        node: {
            type: Object,
            required: true,
        },
        /** Path of the parent folder, "" = top level */
        parent: {
            type: String,
            default: "",
        },
        depth: {
            type: Number,
            default: 0,
        },
        endpoint: {
            type: String,
            default: "current",
        },
        isOpen: {
            type: Function,
            required: true,
        },
        /** Props passed to every StackListItem (selection callbacks) */
        itemProps: {
            type: Object,
            default: () => ({}),
        },
        /** Path of the folder being renamed, if any */
        renamingPath: {
            type: String,
            default: "",
        },
    },
    emits: [ "toggle", "new-folder", "rename-folder", "rename-submit", "rename-cancel", "delete-folder" ],
    setup(props) {
        const header = ref(null);
        const dropHint = inject("sidebarDropHint", null);
        const droppableId = computed(() => `drop-folder:${props.endpoint}:${props.node.path}`);

        const { isDragSource } = useDraggable({
            id: computed(() => `folder:${props.endpoint}:${props.node.path}`),
            element: header,
            data: computed(() => ({
                kind: "folder",
                path: props.node.path,
                endpoint: props.endpoint,
            })),
        });
        const { isDropTarget } = useDroppable({
            id: droppableId,
            element: header,
            data: computed(() => ({
                itemType: "folder",
                key: "f:" + props.node.name,
                parent: props.parent,
                path: props.node.path,
                endpoint: props.endpoint,
            })),
        });

        const dropClass = computed(() => {
            if (!isDropTarget.value || isDragSource.value || !dropHint || dropHint.id !== droppableId.value) {
                return {};
            }
            return {
                "drop-before": dropHint.zone === "before",
                "drop-after": dropHint.zone === "after",
                "drop-target": dropHint.zone === "into",
            };
        });

        return {
            header,
            isDragSource,
            dropClass,
        };
    },
    data() {
        return {
            renameValue: "",
            renameDone: false,
        };
    },
    computed: {
        open() {
            return this.isOpen(this.node.path);
        },
        renaming() {
            return this.renamingPath === this.node.path;
        },
    },
    watch: {
        renaming(value) {
            if (value) {
                this.renameValue = this.node.name;
                this.renameDone = false;
                this.$nextTick(() => {
                    this.$refs.renameInput?.focus();
                    this.$refs.renameInput?.select();
                });
            }
        },
    },
    methods: {
        submitRename() {
            if (this.renameDone) {
                return;
            }
            this.renameDone = true;
            const value = this.renameValue.trim();
            if (!value || value === this.node.name) {
                this.$emit("rename-cancel");
            } else {
                this.$emit("rename-submit", value);
            }
        },
        cancelRename() {
            this.renameDone = true;
            this.$emit("rename-cancel");
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.folder-header {
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    padding-top: 8px;
    padding-bottom: 8px;
    padding-right: 10px;
    display: flex;
    align-items: center;
    user-select: none;
    border-radius: 10px;
    border: 1px dashed transparent;
    transition: background-color 0.15s, border-color 0.15s;
    position: relative;

    &:hover {
        background-color: $highlight-white;

        .dark & {
            background-color: $dark-header-bg;
        }

        .folder-actions {
            opacity: 1;
        }
    }

    &.drop-target {
        border-color: $primary;
        background-color: rgba($primary, 0.18);
    }

    // Insertion line before / after the folder
    &.drop-before::before,
    &.drop-after::after {
        content: "";
        position: absolute;
        left: 8px;
        right: 8px;
        height: 3px;
        border-radius: 2px;
        background-color: $primary;
    }

    &.drop-before::before {
        top: -2px;
    }

    &.drop-after::after {
        bottom: -2px;
    }

    .chevron {
        transition: transform 0.15s ease-in-out;
        width: 10px;
        color: $dark-font-color3;

        &.open {
            transform: rotate(90deg);
        }
    }

    .folder-icon {
        color: $warning;
    }

    .folder-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .rename-input {
        flex: 1;
        min-width: 0;
        height: 26px;
        padding-top: 0;
        padding-bottom: 0;
    }

    .folder-actions {
        opacity: 0;
        display: flex;
        gap: 10px;
        transition: opacity 0.15s;

        .action {
            border: 0;
            background: none;
            padding: 0;
            color: inherit;
            font-size: 12px;
            opacity: 0.6;

            &:hover {
                opacity: 1;
            }

            &.danger:hover {
                color: $danger;
            }
        }
    }

    .folder-count {
        background-color: rgba(128, 128, 128, 0.25);
        color: inherit;
        font-weight: 600;
        font-size: 11px;
    }
}

// The folder being dragged
.drag-source > .folder-header {
    cursor: grabbing;
    background-color: $highlight-white;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);

    .dark & {
        background-color: $dark-header-bg;
    }
}

.empty-folder {
    font-size: 12px;
    font-style: italic;
    color: $dark-font-color3;
    padding-top: 4px;
    padding-bottom: 6px;
}
</style>
