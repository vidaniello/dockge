<template>
    <BModal
        v-model="show"
        :title="rows.length > 0 ? $t('missingVolumesTitle') : $t('otherStackBindsTitle')"
        :okTitle="rows.length > 0 ? $t('missingVolumesConfirm') : $t('otherStackBindsConfirm')"
        :cancelTitle="$t('cancel')"
        size="lg"
        scrollable
        @ok="confirm"
        @hidden="cancelIfOpen"
    >
        <!-- Bind mounts into the folder of another stack -->
        <div v-if="otherStackBinds.length > 0" class="alert alert-warning other-stacks">
            <div class="fw-bold mb-2">{{ $t("otherStackBindsIntro") }}</div>
            <div v-for="bind in otherStackBinds" :key="bind.path" class="mb-2">
                <code>{{ bind.path }}</code>
                <div class="small">
                    {{ $t("otherStackBindsLine", [ bind.otherStack, bind.services.join(", ") ]) }}
                    <span v-if="bind.missing">{{ $t("otherStackBindsMissing") }}</span>
                </div>
            </div>
            <div class="small">{{ $t("otherStackBindsHint") }}</div>
        </div>

        <p v-if="rows.length > 0">{{ $t("missingVolumesIntro") }}</p>

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

        <div v-if="rows.length > 0" class="form-text mt-3">{{ $t("missingVolumesNote") }}</div>
    </BModal>
</template>

<script>
import { BModal } from "bootstrap-vue-next";

/**
 * Before a deploy: choose, for each missing ./xxx volume of a dataset stack, whether to create it as a dataset or a
 * folder, with owner and permissions; confirm the bind mounts into other stacks.
 * Usage: this.$refs.dialog.open(missingVolumes, otherStackBinds).then(options => ...)
 * (null when cancelled; otherwise options to add to deployStack / startStack / updateStack)
 */
export default {
    components: {
        BModal,
    },
    data() {
        return {
            show: false,
            rows: [],
            otherStackBinds: [],
            resolver: null,
        };
    },
    methods: {
        /**
         * @param {object[]} missingVolumes Volumes to create
         * @param {object[]} otherStackBinds Bind mounts into other stacks to confirm
         * @returns {Promise<object|null>} { missingVolumes, acceptOtherStacks } or null when cancelled
         */
        open(missingVolumes, otherStackBinds = []) {
            this.otherStackBinds = otherStackBinds;
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
            resolver?.({
                missingVolumes: this.rows.length > 0 ? choice : undefined,
                acceptOtherStacks: this.otherStackBinds.length > 0 ? true : undefined,
            });
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
.other-stacks {
    border-radius: 10px;
    word-break: break-all;
}

.volume-row {
    padding: 12px 0;
    border-top: 1px solid rgba(128, 128, 128, 0.25);
}
</style>
