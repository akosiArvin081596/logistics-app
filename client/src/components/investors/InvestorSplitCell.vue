<template>
  <!-- @click.stop: this cell lives inside a clickable row (opens the detail
       modal). Stop propagation so editing the split never opens the modal. -->
  <div class="split-cell" @click.stop>
    <template v-if="ownerId">
      <div class="split-field" :class="{ 'is-loading': loading }">
        <input
          v-model.number="value"
          type="number"
          min="0"
          max="100"
          step="1"
          inputmode="decimal"
          class="split-input"
          :disabled="loading || saving"
          :aria-label="`Net-profit split percent for ${investorName || 'investor'}`"
          @keyup.enter="save"
          @click.stop
        />
        <span class="split-suffix" aria-hidden="true">%</span>
      </div>
      <button
        type="button"
        class="split-save"
        :class="{ 'is-dirty': canSave }"
        :disabled="!canSave"
        :title="dirty ? 'Save split %' : 'No changes to save'"
        :aria-label="`Save split percent for ${investorName || 'investor'}`"
        @click.stop="save"
      >
        <span v-if="saving" class="split-spinner" aria-hidden="true"></span>
        <span v-else>Save</span>
      </button>
    </template>
    <span
      v-else
      class="split-na"
      title="No portal login yet — the split applies once this investor has portal access."
    >&mdash;</span>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  // The investor's users.id (same id used as trucks.owner_id). 0 / falsy when
  // the investor has no linked login — the split is meaningless without one.
  ownerId: { type: Number, default: 0 },
  investorName: { type: String, default: '' },
})

const api = useApi()
const { show: toast } = useToast()

const DEFAULT_SPLIT = 50
const value = ref(DEFAULT_SPLIT)     // bound to the input (v-model.number)
const baseline = ref(DEFAULT_SPLIT)  // last-persisted value, for dirty-checking
const loading = ref(false)
const saving = ref(false)

const numeric = computed(() => {
  const n = parseFloat(value.value)
  return Number.isFinite(n) ? n : NaN
})
const valid = computed(
  () => Number.isFinite(numeric.value) && numeric.value >= 0 && numeric.value <= 100,
)
const dirty = computed(() => valid.value && numeric.value !== baseline.value)
const canSave = computed(() => dirty.value && !loading.value && !saving.value)

async function load() {
  if (!props.ownerId) return
  loading.value = true
  try {
    const cfg = await api.get(`/api/investor/config?ownerId=${props.ownerId}`)
    const n = parseFloat(cfg && cfg.investor_split_pct)
    const v = Number.isFinite(n) ? n : DEFAULT_SPLIT
    value.value = v
    baseline.value = v
  } catch {
    // The read endpoint may not be available yet (e.g. not deployed in this
    // environment). Fall back to the default split rather than blocking the row.
    value.value = DEFAULT_SPLIT
    baseline.value = DEFAULT_SPLIT
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!canSave.value || !props.ownerId) return
  const pct = Math.round(Math.min(100, Math.max(0, numeric.value)) * 100) / 100
  saving.value = true
  try {
    await api.put(`/api/investor/config?ownerId=${props.ownerId}`, {
      investor_split_pct: String(pct),
    })
    baseline.value = pct
    value.value = pct
    toast(`Split saved — ${props.investorName || 'Investor'} keeps ${pct}% of net profit`)
  } catch (err) {
    toast(err.message || 'Failed to save split', 'error')
  } finally {
    saving.value = false
  }
}

onMounted(load)
watch(() => props.ownerId, load)
</script>

<style scoped>
.split-cell {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.split-field {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.split-field.is-loading { opacity: 0.55; }

.split-input {
  width: 62px;
  padding: 0.3rem 1.15rem 0.3rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  text-align: right;
  -moz-appearance: textfield;
}
.split-input::-webkit-outer-spin-button,
.split-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.split-input:focus {
  outline: none;
  border-color: var(--blue);
}
.split-input:disabled { cursor: not-allowed; }

.split-suffix {
  position: absolute;
  right: 0.5rem;
  font-size: 0.72rem;
  color: var(--text-dim);
  pointer-events: none;
}

.split-save {
  padding: 0.3rem 0.6rem;
  font-size: 0.7rem;
  font-weight: 600;
  font-family: inherit;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
  min-width: 3rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.split-save.is-dirty {
  background: var(--blue-dim);
  color: var(--blue);
  border-color: var(--blue-dim);
}
.split-save.is-dirty:hover {
  background: var(--blue);
  color: #fff;
  border-color: var(--blue);
}
.split-save:disabled {
  opacity: 0.5;
  cursor: default;
}

.split-na {
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}

.split-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(56, 189, 248, 0.35);
  border-top-color: var(--blue);
  border-radius: 50%;
  animation: split-spin 0.7s linear infinite;
}
@keyframes split-spin { to { transform: rotate(360deg); } }
</style>
