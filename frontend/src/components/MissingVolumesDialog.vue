<template>
    <BModal
        v-model="show"
        :title="$t('missingVolumesTitle')"
        :okTitle="$t('missingVolumesConfirm')"
        :cancelTitle="$t('cancel')"
        size="lg"
        scrollable
        @ok="confirm"
        @hidden="cancelIfOpen"
    >
        <p>{{ $t("missingVolumesIntro") }}</p>

        <div v-for="volume in rows" :key="volume.path" class="volume-row">
            <div class="d-flex align-items-center flex-wrap gap-2 mb-2">
                <code class="fs-6">{{ volume.path }}</code>
                <span class="text-muted small">{{ $t("missingVolumesServices", [ volume.services.join(", ") ]) }}</span>
            </div>

            <div class="row g-2 align-items-end">
                <div class="col-sm-4">
                    <label class="form-label small mb-1">{{ $t("missingVolumesCreateAs") }}</label>
                    <select v-model="volume.type" class="form-select form-select-sm">
                        <option value="dataset" :disabled="!volume.canBeDataset">{{ $t("storageLabelDataset") }}</option>
                        <option value="directory">{{ $t("storageLabelDirectory") }}</option>
                    </select>
                </div>
                <div class="col-sm-4">
                    <label class="form-label small mb-1">{{ $t("missingVolumesOwner") }}</label>
                    <input v-model="volume.owner" class="form-control form-control-sm" placeholder="root" />
                </div>
                <div class="col-sm-4">
                    <label class="form-label small mb-1">{{ $t("missingVolumesMode") }}</label>
                    <input v-model="volume.mode" class="form-control form-control-sm" placeholder="0755" />
                </div>
            </div>

            <div v-if="!volume.canBeDataset" class="form-text text-warning">{{ volume.reason }}</div>
            <div v-else-if="volume.ownerSource" class="form-text">{{ $t("missingVolumesOwnerHint", [ volume.ownerSource ]) }}</div>
            <div v-if="volume.recipe && volume.recipe.recordsize" class="form-text">x-dockge.zfs: recordsize {{ volume.recipe.recordsize }}</div>
            <div v-if="errorOf(volume)" class="form-text text-danger">{{ errorOf(volume) }}</div>
        </div>

        <div class="form-text mt-3">{{ $t("missingVolumesNote") }}</div>
    </BModal>
</template>

<script>
import { BModal } from "bootstrap-vue-next";

/**
 * Before a deploy: choose, for each missing ./xxx volume of a dataset stack, whether to create it as a dataset or a
 * folder, with owner and permissions. Usage: this.$refs.dialog.open(missingVolumes).then(choice => ...)
 * (null when cancelled; otherwise the missingVolumes option of deployStack / startStack / updateStack)
 */
export default {
    components: {
        BModal,
    },
    data() {
        return {
            show: false,
            rows: [],
            resolver: null,
        };
    },
    methods: {
        open(missingVolumes) {
            this.rows = missingVolumes.map((volume) => ({
                ...volume,
                type: volume.defaultType,
                owner: volume.suggestedOwner ?? "",
                mode: volume.recipe?.mode ?? "",
            }));
            this.show = true;
            return new Promise((resolve) => {
                this.resolver = resolve;
            });
        },

        errorOf(volume) {
            if (volume.owner && !/^\d{1,10}(:\d{1,10})?$/.test(volume.owner.trim())) {
                return this.$t("missingVolumesOwnerInvalid");
            }
            if (volume.mode && !/^0?[0-7]{3,4}$/.test(volume.mode.trim())) {
                return this.$t("missingVolumesModeInvalid");
            }
            return "";
        },

        confirm(event) {
            if (this.rows.some((volume) => this.errorOf(volume))) {
                event.preventDefault();
                return;
            }
            const choice = {};
            for (const volume of this.rows) {
                choice[volume.path] = {
                    type: volume.type,
                    owner: volume.owner.trim() || undefined,
                    mode: volume.mode.trim() || undefined,
                };
            }
            const resolver = this.resolver;
            this.resolver = null;
            resolver?.(choice);
        },

        cancelIfOpen() {
            const resolver = this.resolver;
            this.resolver = null;
            resolver?.(null);
        },
    },
};
</script>

<style lang="scss" scoped>
.volume-row {
    padding: 12px 0;
    border-top: 1px solid rgba(128, 128, 128, 0.25);
}
</style>
