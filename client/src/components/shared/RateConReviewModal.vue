<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="max-w-[820px] max-h-[90vh] flex flex-col overflow-hidden" style="padding:0;">
      <!-- Extra right padding clears DialogContent's absolutely-positioned close X. -->
      <DialogHeader class="border-b border-gray-100 bg-muted/50" style="padding:1rem 2.5rem 1rem 1.25rem;">
        <DialogTitle>Review rate-con</DialogTitle>
        <DialogDescription>
          Read from <span class="rc-filename">{{ fileName || 'the rate-con PDF' }}</span>. Fix anything wrong &mdash;
          nothing is created until you click Create Load.
        </DialogDescription>
      </DialogHeader>

      <div class="rc-body">
        <!-- Server-side warnings, verbatim. The per-field flags below are derived
             client-side so they stay honest as the dispatcher edits. -->
        <div v-if="warnings.length" class="rc-callout rc-callout-warn" role="status">
          <strong>Check these before creating:</strong>
          <ul>
            <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
          </ul>
        </div>

        <div v-if="submitError" class="rc-callout rc-callout-error" role="alert">{{ submitError }}</div>

        <section v-for="section in visibleSections" :key="section.title" class="rc-section">
          <div class="rc-section-title">{{ section.title }}</div>
          <div class="rc-grid">
            <div
              v-for="field in section.fields"
              :key="field.key"
              class="rc-field"
              :class="{ 'rc-field-wide': field.wide }"
            >
              <label class="rc-label" :for="inputId(field.key)">
                {{ field.label }}
                <span v-if="field.required" class="rc-req" aria-hidden="true">*</span>
                <span v-if="flags[field.key]" class="rc-chip" :class="`rc-chip-${flags[field.key].level}`">
                  {{ flags[field.key].label }}
                </span>
              </label>
              <textarea
                v-if="field.multiline"
                :id="inputId(field.key)"
                v-model="form[field.key]"
                rows="2"
                class="rc-input"
                :class="flags[field.key] ? `is-${flags[field.key].level}` : ''"
                :disabled="submitting"
              />
              <input
                v-else
                :id="inputId(field.key)"
                v-model="form[field.key]"
                :type="field.type || 'text'"
                :inputmode="field.inputmode"
                class="rc-input"
                :class="[flags[field.key] ? `is-${flags[field.key].level}` : '', field.mono ? 'rc-input-mono' : '']"
                :disabled="submitting"
              />
            </div>
          </div>
        </section>

        <button type="button" class="rc-more" :aria-expanded="showMore" @click="showMore = !showMore">
          {{ showMore ? 'Hide' : 'Show' }} reference numbers &amp; notes ({{ extraFieldCount }})
        </button>
      </div>

      <div class="rc-footer">
        <span v-if="!loadNumber" class="rc-foot-msg rc-foot-error">A Load Number is required to create the load.</span>
        <span v-else-if="missingCount" class="rc-foot-msg rc-foot-warn">{{ missingCount }} field{{ missingCount === 1 ? '' : 's' }} still blank &mdash; you can fill them later from Active Loads &rarr; Edit.</span>
        <span v-else class="rc-foot-msg">Creating load {{ loadNumber }}.</span>
        <div class="rc-foot-actions">
          <button type="button" class="rc-btn rc-btn-ghost" :disabled="submitting" @click="onOpenChange(false)">Cancel</button>
          <button type="button" class="rc-btn rc-btn-primary" :disabled="submitting || !loadNumber" @click="submit">
            {{ submitting ? 'Creating…' : 'Create Load' }}
          </button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useApi } from '../../composables/useApi'

const props = defineProps({
  open: { type: Boolean, default: false },
  // Shape returned by POST /api/loads/ratecon/extract. Any value may be null.
  fields: { type: Object, default: () => ({}) },
  warnings: { type: Array, default: () => [] },
  pdfBase64: { type: String, default: '' },
  fileName: { type: String, default: '' },
})

const emit = defineEmits(['update:open', 'created'])

const api = useApi()

// Sheets read + Distance Matrix + 3 tab writes + a Drive upload. The 20s
// useApi default aborts a request that is still working.
const CREATE_TIMEOUT_MS = 60000

// Every key the extract contract can return, grouped for review. `important`
// fields get an amber "Not found" flag when blank — they're the ones that make
// a load unusable downstream (no rate = no invoice, no address = no route).
const SECTIONS = [
  {
    title: 'Load',
    fields: [
      { key: 'Load Number', label: 'Load Number', required: true, important: true, mono: true },
      { key: 'Rate', label: 'Rate ($)', important: true, inputmode: 'decimal' },
      { key: 'Total Rate', label: 'Total Rate ($)', inputmode: 'decimal' },
      { key: 'Trailer Number', label: 'Trailer Number' },
      { key: 'Details', label: 'Details', wide: true, multiline: true },
    ],
  },
  {
    title: 'Broker',
    fields: [
      { key: 'Broker Name', label: 'Broker Name', important: true },
      { key: 'Broker Phone', label: 'Broker Phone', type: 'tel' },
      { key: 'Broker Email', label: 'Broker Email', type: 'email' },
    ],
  },
  {
    title: 'Pickup',
    fields: [
      { key: 'Pickup Company Information', label: 'Shipper / Facility' },
      { key: 'Pickup Appointment Time', label: 'Pickup Appointment' },
      { key: 'Pickup Address', label: 'Pickup Address', wide: true, important: true },
    ],
  },
  {
    title: 'Drop-off',
    fields: [
      { key: 'Drop-off Company Information', label: 'Receiver / Facility' },
      { key: 'Delivery Appointment Time', label: 'Delivery Appointment' },
      { key: 'Drop-off Address', label: 'Drop-off Address', wide: true, important: true },
    ],
  },
  {
    // Collapsed by default: real, but nobody scans them before dispatching.
    title: 'References & notes',
    extra: true,
    fields: [
      { key: 'P/U Reference Number', label: 'P/U Reference #' },
      { key: 'Delivery Reference Number', label: 'Delivery Reference #' },
      { key: 'Order Number', label: 'Order Number' },
      { key: 'PO Number', label: 'PO Number' },
      { key: 'Move Number', label: 'Move Number' },
      { key: 'BOL Number', label: 'BOL Number' },
      { key: 'Driver Name', label: 'Driver Name (on the rate-con)' },
      { key: 'Pickup Notes/Instructions', label: 'Pickup Notes', wide: true, multiline: true },
      { key: 'Delivery Notes/Instructions', label: 'Delivery Notes', wide: true, multiline: true },
    ],
  },
]

const KNOWN_KEYS = SECTIONS.flatMap(s => s.fields.map(f => f.key))
const ALL_FIELDS = SECTIONS.flatMap(s => s.fields)
const IMPORTANT_KEYS = ALL_FIELDS.filter(f => f.important).map(f => f.key)

const form = reactive({})
const showMore = ref(false)
const submitting = ref(false)
const submitError = ref('')

const extraFieldCount = computed(() => SECTIONS.find(s => s.extra)?.fields.length || 0)
const visibleSections = computed(() => SECTIONS.filter(s => !s.extra || showMore.value))
const loadNumber = computed(() => (form['Load Number'] || '').toString().trim())
const missingCount = computed(() => IMPORTANT_KEYS.filter(k => !(form[k] || '').toString().trim()).length)

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Keys named by a server warning, so anything the backend flagged is visible on
// the field itself and not only in the callout. Whole-phrase, and never
// immediately before a hyphen — a plain substring test flags "Rate" on every
// warning that merely says "rate-con", which is most of them.
const warnedKeys = computed(() => {
  const hay = props.warnings.join(' • ')
  if (!hay.trim()) return new Set()
  return new Set(KNOWN_KEYS.filter(k => new RegExp(`\\b${escapeRe(k)}\\b(?!-)`, 'i').test(hay)))
})

function reset() {
  // Start from the extracted object so unknown//future keys survive the round
  // trip untouched, then guarantee every known key exists for v-model.
  for (const k of Object.keys(form)) delete form[k]
  const src = props.fields || {}
  for (const [k, v] of Object.entries(src)) form[k] = v == null ? '' : String(v)
  for (const k of KNOWN_KEYS) if (!(k in form)) form[k] = ''
  showMore.value = false
  submitError.value = ''
}

watch(
  () => [props.open, props.fields],
  ([isOpen]) => { if (isOpen) reset() },
  { immediate: true },
)

function inputId(key) {
  return 'rc-' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

// { level, label } per flagged key, else absent. Recomputed as the dispatcher
// types, so a filled-in blank clears its own flag. A blank Load Number is the
// only hard block — everything else is fixable later from Active Loads → Edit.
const flags = computed(() => {
  const out = {}
  for (const f of ALL_FIELDS) {
    const blank = !(form[f.key] || '').toString().trim()
    if (f.required && blank) out[f.key] = { level: 'error', label: 'Required' }
    else if (blank && f.important) out[f.key] = { level: 'warn', label: 'Not found' }
    else if (warnedKeys.value.has(f.key)) out[f.key] = { level: 'warn', label: 'Check this' }
  }
  return out
})

function onOpenChange(value) {
  if (value) return
  if (submitting.value) return // don't let a stray Esc orphan an in-flight create
  emit('update:open', false)
}

async function submit() {
  if (submitting.value) return
  if (!loadNumber.value) {
    submitError.value = 'Load Number is blank. Fill it in from the rate-con before creating the load.'
    return
  }
  submitting.value = true
  submitError.value = ''
  try {
    const res = await api.post(
      '/api/loads/from-ratecon',
      { fields: { ...form, 'Load Number': loadNumber.value }, pdfBase64: props.pdfBase64, fileName: props.fileName },
      { timeout: CREATE_TIMEOUT_MS },
    )
    emit('created', res.loadId || loadNumber.value, res)
    emit('update:open', false)
  } catch (err) {
    submitError.value = messageFor(err)
  } finally {
    submitting.value = false
  }
}

function messageFor(err) {
  if (err?.code === 'DUPLICATE_LOAD' || err?.status === 409) {
    const where = err?.data?.existingRowIndex ? ` (Job Tracking row ${err.data.existingRowIndex})` : ''
    return `Load ${loadNumber.value} already exists${where}. Open it from the Job Board or Active Loads instead of creating a second copy.`
  }
  if (err?.status === 400) return err.message || 'The load was rejected — check the Load Number.'
  if (err?.status === 403) return "Your account can't create loads from a rate-con. Ask a Super Admin."
  if (err?.status === 0) {
    return err.code === 'ABORT'
      ? 'Cancelled.'
      : 'Timed out — the load may still have been created. Check the Job Board before retrying.'
  }
  return err?.message || 'Failed to create the load.'
}
</script>

<style scoped>
.rc-filename { font-weight: 600; color: var(--text, #1a1d27); }

.rc-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.rc-callout {
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  font-size: 0.78rem;
  line-height: 1.45;
}
.rc-callout ul { margin: 0.3rem 0 0; padding-left: 1.1rem; }
.rc-callout-warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
.rc-callout-error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }

.rc-section { display: flex; flex-direction: column; gap: 0.5rem; }
.rc-section-title {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim, #6b7085);
}

/* Mobile-first: one column, two from md up (matches the dashboard tabs). */
.rc-grid { display: grid; grid-template-columns: 1fr; gap: 0.7rem; }
@media (min-width: 768px) {
  .rc-grid { grid-template-columns: 1fr 1fr; }
  .rc-field-wide { grid-column: span 2; }
}

.rc-field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.rc-label {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-dim, #6b7085);
}
.rc-req { color: #dc2626; }

.rc-chip {
  padding: 1px 5px;
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: 4px;
}
.rc-chip-warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
.rc-chip-error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }

.rc-input {
  width: 100%;
  padding: 0.45rem 0.6rem;
  font-family: inherit;
  font-size: 0.85rem;
  color: var(--text, #1a1d27);
  background: var(--surface, #fff);
  border: 1px solid #d1d5db;
  border-radius: 6px;
  resize: vertical;
}
.rc-input:focus { outline: none; border-color: var(--accent, #38bdf8); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.12); }
.rc-input:disabled { background: #f9fafb; color: var(--text-dim, #6b7085); }
.rc-input-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.rc-input.is-warn { border-color: #f59e0b; background: #fffdf7; }
.rc-input.is-error { border-color: #dc2626; background: #fffafa; }

.rc-more {
  align-self: flex-start;
  padding: 0.35rem 0.6rem;
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-dim, #6b7085);
  background: transparent;
  border: 1px solid var(--border, #e2e4ea);
  border-radius: 6px;
  cursor: pointer;
}
.rc-more:hover { color: var(--text, #1a1d27); border-color: var(--text-dim, #6b7085); }

.rc-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.85rem 1.25rem;
  border-top: 1px solid #f3f4f6;
  background: #fafafa;
}
.rc-foot-msg { font-size: 0.75rem; color: var(--text-dim, #6b7085); }
.rc-foot-warn { color: #92400e; }
.rc-foot-error { color: #b91c1c; font-weight: 600; }
.rc-foot-actions { display: flex; gap: 0.5rem; margin-left: auto; }

.rc-btn {
  padding: 0.5rem 0.95rem;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
}
.rc-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.rc-btn-ghost { border: 1px solid #d1d5db; background: #fff; color: #374151; }
.rc-btn-primary { border: none; background: #1d4ed8; color: #fff; }

@media (max-width: 640px) {
  .rc-body { padding: 0.9rem 1rem; }
  .rc-footer { padding: 0.75rem 1rem; }
  .rc-foot-actions { width: 100%; }
  .rc-foot-actions .rc-btn { flex: 1; }
}
</style>
