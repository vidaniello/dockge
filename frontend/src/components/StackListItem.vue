<template>
    <router-link
        ref="element"
        :to="url"
        :class="{ 'dim' : !stack.isManagedByDockge, 'drag-source': isDragSource, ...dropClass }"
        class="item"
        :style="depthMargin"
        draggable="false"
    >
        <Uptime :stack="stack" :fixed-width="true" class="me-2" />
        <div class="title">
            <span>{{ stackName }}</span>
        </div>
        <span
            v-if="stack.imageUpdates && stack.imageUpdates.updates > 0"
            class="ms-auto update-icon"
            :title="$t('imageUpdatesAvailable', [ stack.imageUpdates.updates ])"
        >
            <font-awesome-icon icon="arrow-alt-circle-up" />
        </span>
    </router-link>
</template>

<script>
import { computed, inject, ref } from "vue";
import { useDraggable, useDroppable } from "@dnd-kit/vue";
import Uptime from "./Uptime.vue";

export default {
    components: {
        Uptime
    },
    props: {
        /** Stack this represents */
        stack: {
            type: Object,
            default: null,
        },
        /** If the user is in select mode */
        isSelectMode: {
            type: Boolean,
            default: false,
        },
        /** Folder containing this stack, "" = top level */
        parent: {
            type: String,
            default: "",
        },
        /** How many ancestors are above this stack */
        depth: {
            type: Number,
            default: 0,
        },
        /** Callback to determine if stack is selected */
        isSelected: {
            type: Function,
            default: () => {}
        },
        /** Callback fired when stack is selected */
        select: {
            type: Function,
            default: () => {}
        },
        /** Callback fired when stack is deselected */
        deselect: {
            type: Function,
            default: () => {}
        },
    },
    /**
     * Managed stacks can be dragged onto a folder of the sidebar (dnd-kit, see StackList.vue)
     * @param {object} props Props
     * @returns {object} Template refs and drag state
     */
    setup(props) {
        const element = ref(null);
        const dropHint = inject("sidebarDropHint", null);
        const endpoint = computed(() => props.stack.endpoint || "current");
        const droppableId = computed(() => `drop-stack:${endpoint.value}:${props.stack.name}`);

        // Other items can be dropped before / after this stack (reorder)
        const { isDropTarget } = useDroppable({
            id: droppableId,
            element,
            disabled: computed(() => !props.stack.isManagedByDockge),
            data: computed(() => ({
                itemType: "stack",
                key: "s:" + props.stack.name,
                parent: props.parent,
                endpoint: endpoint.value,
            })),
        });

        const { isDragSource } = useDraggable({
            id: computed(() => `stack:${props.stack.endpoint || "current"}:${props.stack.name}`),
            element,
            disabled: computed(() => !props.stack.isManagedByDockge),
            data: computed(() => ({
                kind: "stack",
                name: props.stack.name,
                endpoint: props.stack.endpoint || "current",
                folder: props.stack.folder || "",
            })),
        });
        const dropClass = computed(() => {
            if (!isDropTarget.value || !dropHint || dropHint.id !== droppableId.value) {
                return {};
            }
            return {
                "drop-before": dropHint.zone === "before",
                "drop-after": dropHint.zone === "after",
            };
        });

        return {
            element,
            isDragSource,
            dropClass,
        };
    },
    data() {
        return {
            isCollapsed: true,
        };
    },
    computed: {
        endpointDisplay() {
            return this.$root.endpointDisplayFunction(this.stack.endpoint);
        },
        url() {
            if (this.stack.endpoint) {
                return `/compose/${this.stack.name}/${this.stack.endpoint}`;
            } else {
                return `/compose/${this.stack.name}`;
            }
        },
        depthMargin() {
            if (!this.depth) {
                return {};
            }
            return {
                paddingLeft: `${8 + 16 * this.depth}px`,
            };
        },
        stackName() {
            return this.stack.name;
        }
    },
    watch: {
        isSelectMode() {
            // TODO: Resize the heartbeat bar, but too slow
            // this.$refs.heartbeatBar.resize();
        }
    },
    beforeMount() {

    },
    methods: {
        /**
         * Changes the collapsed value of the current stack and saves
         * it to local storage
         * @returns {void}
         */
        changeCollapsed() {
            this.isCollapsed = !this.isCollapsed;

            // Save collapsed value into local storage
            let storage = window.localStorage.getItem("stackCollapsed");
            let storageObject = {};
            if (storage !== null) {
                storageObject = JSON.parse(storage);
            }
            storageObject[`stack_${this.stack.id}`] = this.isCollapsed;

            window.localStorage.setItem("stackCollapsed", JSON.stringify(storageObject));
        },

        /**
         * Toggle selection of stack
         * @returns {void}
         */
        toggleSelection() {
            if (this.isSelected(this.stack.id)) {
                this.deselect(this.stack.id);
            } else {
                this.select(this.stack.id);
            }
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.small-padding {
    padding-left: 5px !important;
    padding-right: 5px !important;
}

.collapse-padding {
    padding-left: 8px !important;
    padding-right: 2px !important;
}

.item {
    text-decoration: none;
    display: flex;
    align-items: center;
    min-height: 52px;
    border-radius: 10px;
    transition: all ease-in-out 0.15s;
    width: 100%;
    padding: 5px 8px;
    &.disabled {
        opacity: 0.3;
    }
    &:hover {
        background-color: $highlight-white;
    }
    &.active {
        background-color: #cdf8f4;
    }
    .title {
        margin-top: -4px;
    }
    .endpoint {
        font-size: 12px;
        color: $dark-font-color3;
    }
}

.collapsed {
    transform: rotate(-90deg);
}

.animated {
    transition: all 0.2s $easing-in;
}

.select-input-wrapper {
    float: left;
    margin-top: 15px;
    margin-left: 3px;
    margin-right: 10px;
    padding-left: 4px;
    position: relative;
    z-index: 15;
}

.dim {
    opacity: 0.5;
}

// Insertion line before / after the stack
.item {
    position: relative;
}

.drop-before::before,
.drop-after::after {
    content: "";
    position: absolute;
    left: 8px;
    right: 8px;
    height: 3px;
    border-radius: 2px;
    background-color: $primary;
}

.drop-before::before {
    top: -2px;
}

.drop-after::after {
    bottom: -2px;
}

// The stack being dragged (dnd-kit moves the element itself under the pointer)
.drag-source {
    cursor: grabbing;
    background-color: $highlight-white;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    opacity: 0.9;

    .dark & {
        background-color: $dark-header-bg;
    }
}

.update-icon {
    color: $warning;
    padding-left: 8px;
}

</style>
