<template>
  <div class="kpi-approval" :class="{ 'kpi-approval--yes': view.approved }">
    <div class="kpi-approval-row">
      <span :id="labelId" class="kpi-approval-label">Approved for public use:</span>
      <button
        type="button"
        role="switch"
        class="kpi-switch"
        :class="{ on: view.approved }"
        :aria-checked="view.approved ? 'true' : 'false'"
        :aria-labelledby="labelId"
        :aria-describedby="view.stale ? staleId : undefined"
        :disabled="saving"
        @click="ask"
      >
        <span class="kpi-knob" aria-hidden="true"></span>
      </button>
      <strong class="kpi-approval-answer" aria-hidden="true">{{ saving ? 'Saving…' : view.answer }}</strong>
    </div>
    <p v-if="view.stale" :id="staleId" class="kpi-approval-stale" role="note">{{ view.staleNote }}</p>
    <p v-if="view.by || view.at" class="kpi-approval-meta">
      {{ view.approved ? 'Approved' : 'Last set' }}<template v-if="view.by"> by {{ view.by }}</template><template v-if="view.at"> on {{ fmtAppInstant(view.at) }}</template>
    </p>

    <Dialog :open="confirming" @update:open="(v) => { if (!v) confirming = false }">
      <DialogContent class="sm:max-w-[460px] rounded-[14px]">
        <DialogHeader>
          <DialogTitle class="text-[1.05rem] font-bold text-gray-900">{{ confirmText.title }}</DialogTitle>
          <DialogDescription class="text-[13px] text-gray-600">{{ confirmText.body }}</DialogDescription>
        </DialogHeader>
        <p v-if="!next" class="text-[12px] text-gray-500">
          Anything already published with this figure is not withdrawn by this page.
        </p>
        <DialogFooter class="gap-2">
          <Button type="button" variant="outline" class="text-[12px]" @click="confirming = false">Cancel</Button>
          <Button
            type="button"
            :variant="next ? 'default' : 'destructive'"
            class="text-[12px]"
            :disabled="saving"
            @click="confirm"
          >{{ confirmText.action }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { approvalConfirmText, approvalView } from '../../lib/kpiView.js'
import { fmtAppInstant } from '../../utils/datetime'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

// "Approved for public use" for one metric. Off by default; the server decides
// whether an approval still holds (a changed definition or setting resets it,
// and `stale` says so). A missing or not-tracked metric can be toggled too: the
// server accepts or refuses it.
const props = defineProps({
  metric: { type: Object, required: true },
  saving: { type: Boolean, default: false },
})
const emit = defineEmits(['set'])

const view = computed(() => approvalView(props.metric.approval))
const labelId = computed(() => `kpi-approval-${props.metric.key}`)
const staleId = computed(() => `kpi-approval-stale-${props.metric.key}`)

const confirming = ref(false)
const next = ref(false)
const confirmText = computed(() => approvalConfirmText(props.metric.label, next.value))

function ask() {
  if (props.saving) return
  next.value = !view.value.approved
  confirming.value = true
}

function confirm() {
  confirming.value = false
  emit('set', { key: props.metric.key, approved: next.value, definitionVersion: props.metric.definitionVersion })
}
</script>

<style scoped>
.kpi-approval {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.6rem 0.75rem;
  background: var(--bg);
}
.kpi-approval--yes {
  border-color: #a7f3d0;
  background: #ecfdf5;
}
.kpi-approval-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.kpi-approval-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text);
}
.kpi-approval-answer {
  font-size: 0.8rem;
  color: var(--text);
}
.kpi-approval-stale {
  margin: 0.4rem 0 0;
  font-size: 0.74rem;
  font-weight: 600;
  color: #92400e;
}
.kpi-approval-meta {
  margin: 0.3rem 0 0;
  font-size: 0.72rem;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}

/* The Financials cost-settings switch (CostSettingsDialog.vue), green when on. */
.kpi-switch {
  position: relative;
  width: 38px;
  height: 22px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: #cbd5e1;
  cursor: pointer;
  transition: background 0.15s;
}
.kpi-switch.on { background: #059669; }
.kpi-switch:disabled { opacity: 0.6; cursor: progress; }
.kpi-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.kpi-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 0.15s;
}
.kpi-switch.on .kpi-knob { transform: translateX(16px); }
</style>
