<template>
    <transition name="slide-fade" appear>
        <div>
            <h1 class="mb-3">{{ $t("terminal") }} - {{ serviceName }} ({{ stackName }})</h1>

            <ExpandableBox :title="`${serviceName} (${shell})`" title-tag="h5" resizable storage-key="containerTerminal" :height="defaultHeight" :min-height="200">
                <template #actions>
                    <span class="copy-hint d-none d-md-inline">{{ $t("terminalCopyPasteHint") }}</span>
                    <router-link v-if="shell !== 'sh'" :to="sh" class="btn btn-sm btn-normal">{{ $t("Switch to sh") }}</router-link>
                </template>
                <Terminal class="terminal" :rows="20" mode="interactive" :name="terminalName" :stack-name="stackName" :service-name="serviceName" :shell="shell" :endpoint="endpoint"></Terminal>
            </ExpandableBox>
        </div>
    </transition>
</template>

<script>
import { getContainerExecTerminalName } from "../../../common/util-common";
import ExpandableBox from "../components/ExpandableBox.vue";

export default {
    components: {
        ExpandableBox,
    },
    data() {
        return {

        };
    },
    computed: {
        defaultHeight() {
            return Math.max(400, window.innerHeight - 330);
        },
        stackName() {
            return this.$route.params.stackName;
        },
        endpoint() {
            return this.$route.params.endpoint || "";
        },
        shell() {
            return this.$route.params.type;
        },
        serviceName() {
            return this.$route.params.serviceName;
        },
        terminalName() {
            return getContainerExecTerminalName(this.endpoint, this.stackName, this.serviceName, 0);
        },
        sh() {
            let endpoint = this.$route.params.endpoint;

            let data = {
                name: "containerTerminal",
                params: {
                    stackName: this.stackName,
                    serviceName: this.serviceName,
                    type: "sh",
                },
            };

            if (endpoint) {
                data.name = "containerTerminalEndpoint";
                data.params.endpoint = endpoint;
            }

            return data;
        },
    },
    mounted() {

    },
    methods: {

    }
};
</script>

<style scoped lang="scss">
@import "../styles/vars.scss";

.copy-hint {
    font-size: 12px;
    color: $dark-font-color3;
}
</style>
