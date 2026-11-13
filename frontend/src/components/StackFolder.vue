<template>
    <div class="stack-folder">
        <div
            class="folder-header"
            :class="{ 'drop-target': dropActive }"
            :style="{ paddingLeft: (10 + 16 * depth) + 'px' }"
            @click="$emit('toggle', node.path)"
            @dragover="onDragOver"
            @dragleave="dropActive = false"
            @drop="onDrop"
        >
            <font-awesome-icon class="me-2 chevron" :class="{ open }" icon="chevron-right" />
            <font-awesome-icon class="me-2 folder-icon" :icon="open ? 'folder-open' : 'folder'" />
            <span class="folder-name">{{ node.name }}</span>
            <font-awesome-icon icon="pen" class="ms-2 rename" :title="$t('renameFolder')" @click.stop="$emit('rename-folder', node.path)" />
            <span class="badge rounded-pill folder-count ms-2">{{ node.count }}</span>
        </div>

        <div v-show="open">
            <StackFolder
                v-for="child in node.folders"
                :key="child.path"
                :node="child"
                :depth="depth + 1"
                :endpoint="endpoint"
                :is-open="isOpen"
                :item-props="itemProps"
                @toggle="$emit('toggle', $event)"
                @move-stack="(...args) => $emit('move-stack', ...args)"
                @rename-folder="$emit('rename-folder', $event)"
            />
            <StackListItem
                v-for="item in node.stacks"
                :key="item.name"
                :stack="item"
                :depth="depth + 1"
                v-bind="itemProps"
            />
        </div>
    </div>
</template>

<script>
import StackListItem from "./StackListItem.vue";

export const DRAG_TYPE = "application/x-dockge-stack";

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
            default: "",
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
    emits: [ "toggle", "move-stack", "rename-folder" ],
    data() {
        return {
            dropActive: false,
        };
    },
    computed: {
        open() {
            return this.isOpen(this.node.path);
        },
    },
    methods: {
        onDragOver(e) {
            if (e.dataTransfer?.types.includes(DRAG_TYPE)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                this.dropActive = true;
            }
        },

        onDrop(e) {
            this.dropActive = false;
            const raw = e.dataTransfer?.getData(DRAG_TYPE);
            if (!raw) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            const data = JSON.parse(raw);
            this.$emit("move-stack", data, this.node.path);
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

    &:hover {
        background-color: $highlight-white;

        .dark & {
            background-color: $dark-header-bg;
        }

        .rename {
            opacity: 0.6;
        }
    }

    &.drop-target {
        border-color: $primary;
        background-color: rgba($primary, 0.15);
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

    .rename {
        opacity: 0;
        font-size: 12px;
        transition: opacity 0.15s;

        &:hover {
            opacity: 1 !important;
        }
    }

    .folder-count {
        background-color: rgba(128, 128, 128, 0.25);
        color: inherit;
        font-weight: 600;
        font-size: 11px;
    }
}
</style>
