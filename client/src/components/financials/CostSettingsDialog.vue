<template>
  <Dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogContent class="sm:max-w-[560px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden max-h-[92vh] flex flex-col">
      <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2] bg-gradient-to-b from-gray-50/80 to-white">
        <DialogTitle class="text-[1.1rem] font-bold text-gray-900">Cost settings</DialogTitle>
        <DialogDescription class="text-[13px] text-gray-500">
          Financials only — payouts never read these. Applies to open months; closed months keep the settings they
          closed with.
        </DialogDescription>
      </DialogHeader>

      <form class="settings-body" novalidate @submit.prevent="save">
        <div v-if="store.settingsLoading && !form" class="loading-rows" aria-busy="true">
          <div v-for="i in 6" :key="i" class="skeleton-row"></div>
        </div>

        <div v-else-if="store.settingsError && !form" class="error-box" role="alert">
          <div class="error-title">Could not load the cost settings</div>
          <div class="error-msg">{{ store.settingsError }}</div>
          <button type="button" class="btn btn-primary btn-sm" @click="load">Retry</button>
        </div>

        <template v-else-if="form">
          <fieldset class="lines">
            <legend class="f-label">Count in total costs and margin</legend>
            <div v-for="line in store.settingsLines" :key="line.key" class="line-row">
              <span :id="`fin-line-${line.key}`" class="line-label">{{ line.label }}</span>
              <button
                type="button"
                role="switch"
                class="switch"
                :class="{ on: form.costs[line.key] }"
                :aria-checked="form.costs[line.key] ? 'true' : 'false'"
                :aria-labelledby="`fin-line-${line.key}`"
                @click="form.costs[line.key] = !form.costs[line.key]"
              >
                <span class="knob" aria-hidden="true"></span>
              </button>
              <span class="switch-state" aria-hidden="true">{{ form.costs[line.key] ? 'Counted' : 'Not counted' }}</span>
            </div>
          </fieldset>

          <div class="num-fields">
            <label class="field">
              <span class="f-label">Overhead per month ($)</span>
              <input
                v-model="form.overheadMonthly"
                type="number"
                inputmode="decimal"
                min="0"
                max="10000000"
                step="0.01"
                class="form-input"
                :aria-invalid="!!overheadError"
              />
              <span class="f-hint">Counted only while Overhead is switched on. 0 to 10,000,000.</span>
            </label>
            <label class="field">
              <span class="f-label">Depreciation years</span>
              <input
                v-model="form.depreciationYears"
                type="number"
                inputmode="decimal"
                min="1"
                max="40"
                step="1"
                class="form-input"
                :aria-invalid="!!yearsError"
              />
              <span class="f-hint">Counted only while Depreciation is switched on. 1 to 40.</span>
            </label>
          </div>

          <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
        </template>
      </form>

      <div class="px-6 py-4 border-t border-[#e8edf2] flex flex-wrap gap-2 justify-between items-center bg-gray-50/50">
        <Button
          type="button"
          variant="outline"
          class="text-[12px]"
          :disabled="!form || !store.settingsDefaults || store.settingsSaving"
          @click="restoreDefaults"
        >Restore defaults</Button>
        <div class="flex gap-2 ml-auto">
          <Button type="button" variant="outline" class="text-[12px]" @click="emit('update:open', false)">Cancel</Button>
          <Button
            type="button"
            class="text-[12px] bg-sky-500 hover:bg-sky-600 text-white"
            :disabled="!form || store.settingsSaving || !!overheadError || !!yearsError"
            @click="save"
          >{{ store.settingsSaving ? 'Saving…' : 'Save' }}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useFinancialsStore } from '../../stores/financials'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

// Which cost lines count in Financials' margin, the monthly overhead and the
// depreciation years (GET / PUT /api/financials/settings). The server checks
// every value again (400 INVALID_SETTINGS); the checks here only say so early.
const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['update:open', 'saved'])

const store = useFinancialsStore()
const form = ref(null)
const saveError = ref('')

function fill(settings) {
  if (!settings) { form.value = null; return }
  form.value = {
    costs: { ...settings.costs },
    overheadMonthly: settings.overheadMonthly,
    depreciationYears: settings.depreciationYears,
  }
}

async function load() {
  form.value = null
  saveError.value = ''
  await store.loadSettings()
  if (!store.settingsError) fill(store.settings)
}

watch(() => props.open, (isOpen) => { if (isOpen) load() })

function restoreDefaults() {
  saveError.value = ''
  fill(store.settingsDefaults)
}

const numberOf = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v))
const overheadError = computed(() => {
  if (!form.value) return ''
  const v = numberOf(form.value.overheadMonthly)
  return Number.isFinite(v) && v >= 0 && v <= 10000000 ? '' : 'Overhead per month must be a number from 0 to 10,000,000.'
})
const yearsError = computed(() => {
  if (!form.value) return ''
  const v = numberOf(form.value.depreciationYears)
  return Number.isFinite(v) && v >= 1 && v <= 40 ? '' : 'Depreciation years must be a number from 1 to 40.'
})
const formError = computed(() => overheadError.value || yearsError.value || saveError.value)

async function save() {
  if (!form.value || overheadError.value || yearsError.value || store.settingsSaving) return
  saveError.value = ''
  try {
    const result = await store.saveSettings({
      costs: { ...form.value.costs },
      overheadMonthly: numberOf(form.value.overheadMonthly),
      depreciationYears: numberOf(form.value.depreciationYears),
    })
    emit('saved', result)
    emit('update:open', false)
  } catch (err) {
    saveError.value = err?.message || 'Failed to save the cost settings'
  }
}
</script>

<style scoped>
.settings-body {
  padding: 1rem 1.5rem 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}
.f-label {
  display: block;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.4rem;
}
.f-hint { font-size: 0.7rem; color: var(--text-dim); }
.lines { border: 0; padding: 0; margin: 0; }
.line-row {
  display: grid;
  grid-template-columns: 1fr auto 6.5rem;
  align-items: center;
  gap: 0.75rem;
  padding: 0.45rem 0;
  border-bottom: 1px solid var(--bg);
}
.line-label { font-size: 0.85rem; font-weight: 500; }
.switch-state { font-size: 0.72rem; color: var(--text-dim); }
.switch {
  position: relative;
  width: 38px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: #cbd5e1;
  cursor: pointer;
  transition: background 0.15s;
}
.switch.on { background: var(--accent); }
.switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.knob {
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
.switch.on .knob { transform: translateX(16px); }
.num-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.9rem;
}
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field .f-label { margin-bottom: 0; }
.form-input[aria-invalid='true'] { border-color: var(--danger); }
.form-error {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--danger);
}
.loading-rows { display: flex; flex-direction: column; gap: 0.5rem; }
.skeleton-row {
  height: 28px;
  border-radius: 8px;
  background: var(--bg);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.8; } }
.error-box {
  background: var(--danger-dim);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  color: var(--danger);
}
.error-title { font-weight: 700; font-size: 0.85rem; }
.error-msg { font-size: 0.78rem; margin: 0.3rem 0 0.6rem; }

@media (max-width: 767px) {
  .num-fields { grid-template-columns: 1fr; }
  .line-row { grid-template-columns: 1fr auto; }
  .switch-state { display: none; }
}
</style>
