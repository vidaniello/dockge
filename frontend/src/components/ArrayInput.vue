<template>
    <div>
        <div v-if="valid">
            <ul v-if="isArrayInited" class="list-group">
                <li v-for="(value, index) in array" :key="index" class="list-group-item">
                    <input v-model="array[index]" type="text" class="no-bg domain-input" :placeholder="placeholder" />
                    <font-awesome-icon v-if="browse" icon="folder-open" class="action browse ms-2" :title="$t('pickHostPath')" @click="browsePath(index)" />
                    <font-awesome-icon icon="times" class="action remove ms-2 me-3 text-danger" @click="remove(index)" />
                </li>
            </ul>

            <button class="btn btn-normal btn-sm mt-3" @click="addField">{{ $t("addListItem", [ displayName ]) }}</button>
            <button v-if="browse" class="btn btn-normal btn-sm mt-3 ms-2" @click="addBrowsedField">
                <font-awesome-icon icon="folder-open" class="me-1" />
                {{ $t("addHostPath") }}
            </button>
            <PathPicker v-if="browse" ref="picker" :endpoint="getEndpoint()" />
        </div>
        <div v-else>
            {{ $t("LongSyntaxNotSupported") }}
        </div>
    </div>
</template>

<script>
import PathPicker from "./PathPicker.vue";

export default {
    components: {
        PathPicker,
    },
    inject: {
        // Provided by Compose.vue
        getEndpoint: {
            from: "composeEndpoint",
            default: () => () => "",
        },
    },
    props: {
        /** Show a button to pick the host part of "HOST:CONTAINER" from the host folders */
        browse: {
            type: Boolean,
            default: false,
        },
        name: {
            type: String,
            required: true,
        },
        placeholder: {
            type: String,
            default: "",
        },
        displayName: {
            type: String,
            required: true,
        },
        objectType: {
            type: String,
            default: "service",
        }
    },
    data() {
        return {

        };
    },
    computed: {
        array() {
            // Create the array if not exists, it should be safe.
            if (!this.service[this.name]) {
                return [];
            }
            return this.service[this.name];
        },

        /**
         * Check if the array is inited before called v-for.
         * Prevent empty arrays inserted to the YAML file.
         * @return {boolean}
         */
        isArrayInited() {
            return this.service[this.name] !== undefined;
        },

        /**
         * Not a good name, but it is used to get the object.
         */
        service() {
            if (this.objectType === "service") {
                // Used in Container.vue
                return this.$parent.$parent.service;
            } else if (this.objectType === "x-dockge") {

                if (!this.$parent.$parent.jsonConfig["x-dockge"]) {
                    return {};
                }

                // Used in Compose.vue
                return this.$parent.$parent.jsonConfig["x-dockge"];
            } else {
                return {};
            }
        },

        valid() {
            // Check if the array is actually an array
            if (!Array.isArray(this.array)) {
                return false;
            }

            // Check if the array contains non-object only.
            for (let item of this.array) {
                if (typeof item === "object") {
                    return false;
                }
            }
            return true;
        }

    },
    created() {

    },
    methods: {
        addField() {

            // Create the object if not exists.
            if (this.objectType === "x-dockge") {
                if (!this.$parent.$parent.jsonConfig["x-dockge"]) {
                    this.$parent.$parent.jsonConfig["x-dockge"] = {};
                }
            }

            // Create the array if not exists.
            if (!this.service[this.name]) {
                this.service[this.name] = [];
            }

            this.array.push("");
        },
        remove(index) {
            this.array.splice(index, 1);
        },

        /**
         * Replace the host part of "HOST:CONTAINER[:mode]" with a folder picked from the host
         * @param {number} index Row
         * @returns {Promise<void>}
         */
        async browsePath(index) {
            const value = this.array[index] ?? "";
            const separator = value.indexOf(":");
            const host = separator >= 0 ? value.slice(0, separator) : value;

            const picked = await this.$refs.picker.open(host);
            if (!picked) {
                return;
            }

            this.array[index] = separator >= 0 ? picked + value.slice(separator) : picked + ":";
        },

        async addBrowsedField() {
            const picked = await this.$refs.picker.open("");
            if (!picked) {
                return;
            }
            if (!this.service[this.name]) {
                this.service[this.name] = [];
            }
            this.array.push(picked + ":");
        },
    }
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.browse {
    cursor: pointer;
    color: $warning;
}

.list-group {
    background-color: $dark-bg2;

    li {
        display: flex;
        align-items: center;
        padding: 10px 0 10px 10px;

        .domain-input {
            flex-grow: 1;
            background-color: $dark-bg2;
            border: none;
            color: $dark-font-color;
            outline: none;

            &::placeholder {
                color: #1d2634;
            }
        }
    }
}
</style>
