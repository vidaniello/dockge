<template>
    <div class="folder-name-input" :style="{ paddingLeft: (10 + 16 * depth) + 'px' }">
        <font-awesome-icon icon="folder" class="me-2 folder-icon" />
        <input
            ref="input"
            v-model="value"
            class="form-control form-control-sm"
            :placeholder="placeholder"
            maxlength="200"
            @keydown.enter.prevent="submit"
            @keydown.esc.prevent="$emit('cancel')"
            @blur="submit"
        />
    </div>
</template>

<script>
/**
 * Inline input to name a new folder or rename one. Enter / blur = confirm, Esc = cancel.
 */
export default {
    props: {
        initial: {
            type: String,
            default: "",
        },
        depth: {
            type: Number,
            default: 0,
        },
        placeholder: {
            type: String,
            default: "",
        },
    },
    emits: [ "submit", "cancel" ],
    data() {
        return {
            value: this.initial,
            done: false,
        };
    },
    mounted() {
        this.$refs.input.focus();
        this.$refs.input.select();
    },
    methods: {
        submit() {
            if (this.done) {
                return;
            }
            this.done = true;
            const value = this.value.trim();
            if (!value || value === this.initial) {
                this.$emit("cancel");
            } else {
                this.$emit("submit", value);
            }
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.folder-name-input {
    display: flex;
    align-items: center;
    padding-top: 4px;
    padding-bottom: 4px;
    padding-right: 10px;

    .folder-icon {
        color: $warning;
    }
}
</style>
