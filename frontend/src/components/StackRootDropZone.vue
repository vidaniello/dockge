<template>
    <div ref="element" class="root-drop-zone" :class="{ 'drop-target': isDropTarget }">
        <font-awesome-icon icon="arrow-up" class="me-2" />
        {{ $t("noFolder") }}
    </div>
</template>

<script>
import { computed, ref } from "vue";
import { useDroppable } from "@dnd-kit/vue";

/**
 * Drop target shown while dragging: moves the stack / folder to the top level
 */
export default {
    props: {
        endpoint: {
            type: String,
            default: "current",
        },
    },
    setup(props) {
        const element = ref(null);
        const { isDropTarget } = useDroppable({
            id: computed(() => `drop-root:${props.endpoint}`),
            element,
            data: computed(() => ({
                itemType: "root",
                path: "",
                parent: "",
                endpoint: props.endpoint,
            })),
        });
        return {
            element,
            isDropTarget,
        };
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.root-drop-zone {
    margin: 6px 0 8px;
    padding: 10px;
    text-align: center;
    font-size: 13px;
    color: $dark-font-color3;
    border: 1px dashed rgba(128, 128, 128, 0.5);
    border-radius: 10px;
    transition: background-color 0.15s, border-color 0.15s;

    &.drop-target {
        border-color: $primary;
        background-color: rgba($primary, 0.18);
        color: inherit;
    }
}
</style>
