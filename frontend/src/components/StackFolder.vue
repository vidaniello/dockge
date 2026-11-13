<template>
    <div class="stack-folder" :class="{ 'drag-source': isDragSource }">
        <div
            ref="header"
            class="folder-header"
            :class="{ 'drop-target': isDropTarget && !isDragSource }"
            :style="{ paddingLeft: (10 + 16 * depth) + 'px' }"
            @click="$emit('toggle', node.path)"
        >
            <font-awesome-icon class="me-2 chevron" :class="{ open }" icon="chevron-right" />
            <font-awesome-icon class="me-2 folder-icon" :icon="open ? 'folder-open' : 'folder'" />
            <span class="folder-name">{{ node.name }}</span>

            <span class="folder-actions">
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
            <span v-if="node.count > 0" class="badge rounded-pill folder-count ms-2">{{ node.count }}</span>
        </div>

        <div v-show="open">
            <slot name="before-children" :path="node.path"></slot>
            <StackFolder
                v-for="child in node.folders"
                :key="child.path"
                :node="child"
                :depth="depth + 1"
                :endpoint="endpoint"
                :is-open="isOpen"
                :item-props="itemProps"
                @toggle="$emit('toggle', $event)"
                @new-folder="$emit('new-folder', $event)"
                @rename-folder="$emit('rename-folder', $event)"
                @delete-folder="$emit('delete-folder', $event)"
            >
                <template #before-children="slotProps">
                    <slot name="before-children" v-bind="slotProps"></slot>
                </template>
            </StackFolder>
            <StackListItem
                v-for="item in node.stacks"
                :key="item.name"
                :stack="item"
                :depth="depth + 1"
                v-bind="itemProps"
            />
            <div v-if="node.folders.length === 0 && node.stacks.length === 0" class="empty-folder" :style="{ paddingLeft: (36 + 16 * depth) + 'px' }">
                {{ $t("emptyFolder") }}
            </div>
        </div>
    </div>
</template>

<script>
import { computed, ref } from "vue";
import { useDraggable, useDroppable } from "@dnd-kit/vue";
import StackListItem from "./StackListItem.vue";

/**
 * A virtual folder of the sidebar. Its header can be dragged (to move the folder into another one)
 * and is a drop target for stacks and folders (dnd-kit, the drop is handled in StackList.vue).
 */
export default {
    name: "StackFolder",
    components: {
        StackListItem,
    },
    props: {
        /** { name, path, folders: [], stacks: [], count } */
        node: {
            type: Object,
            required: true,
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
    },
    emits: [ "toggle", "new-folder", "rename-folder", "delete-folder" ],
    setup(props) {
        const header = ref(null);
        const data = computed(() => ({
            kind: "folder",
            path: props.node.path,
            endpoint: props.endpoint,
        }));
        const { isDragSource } = useDraggable({
            id: computed(() => `folder:${props.endpoint}:${props.node.path}`),
            element: header,
            data,
        });
        const { isDropTarget } = useDroppable({
            id: computed(() => `drop-folder:${props.endpoint}:${props.node.path}`),
            element: header,
            data,
        });
        return {
            header,
            isDragSource,
            isDropTarget,
        };
    },
    computed: {
        open() {
            return this.isOpen(this.node.path);
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
