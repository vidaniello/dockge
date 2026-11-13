<template>
    <transition name="slide-fade" appear>
        <div v-if="!processing">
            <h1 class="mb-3">{{ $t("console") }}</h1>

            <ExpandableBox v-if="enableConsole" title="" resizable storage-key="console" :height="defaultHeight" :min-height="200">
                <template #title>
                    <span class="copy-hint">{{ $t("terminalCopyPasteHint") }}</span>
                </template>
                <Terminal class="terminal" :rows="20" mode="mainTerminal" name="console" :endpoint="endpoint"></Terminal>
            </ExpandableBox>

            <div v-else class="alert alert-warning shadow-box" role="alert">
                <h4 class="alert-heading">{{ $t("Console is not enabled") }}</h4>
                <i18n-t keypath="ConsoleNotEnabledMSG1" tag="p">
                    <template #docker><code>{{ $t('dockerCode') }}</code></template>
                    <template #rm><code>{{ $t('rmCode') }}</code></template>
                </i18n-t>

                <i18n-t keypath="ConsoleNotEnabledMSG2" tag="p">
                    <template #rmRf>
                        <code>{{ $t('rmRfCode') }}</code>
                    </template>
                </i18n-t>

                <i18n-t keypath="ConsoleNotEnabledMSG3" tag="p">
                    <template #envVar>
                        <code>{{ $t('envVarCode') }}</code>
                    </template>
                </i18n-t>
            </div>
        </div>
    </transition>
</template>

<script>
import ExpandableBox from "../components/ExpandableBox.vue";

export default {
    components: {
        ExpandableBox,
    },
    data() {
        return {
            processing: true,
            enableConsole: false,
        };
    },
    computed: {
        defaultHeight() {
            return Math.max(400, window.innerHeight - 300);
        },
        endpoint() {
            return this.$route.params.endpoint || "";
        },
    },
    mounted() {
        this.$root.emitAgent(this.endpoint, "checkMainTerminal", (res) => {
            this.enableConsole = res.ok;
            this.processing = false;
        });
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
