<template>
  <details class="form-accordion kpi-settings">
    <summary class="form-toggle kpi-settings-toggle">
      <span>KPI settings</span>
      <span class="form-toggle-note">{{ summary }}</span>
    </summary>

    <form class="kpi-settings-body" novalidate @submit.prevent="save">
      <div class="kpi-settings-grid">
        <!-- AI dispatch start: worked out from the data unless an admin sets it. -->
        <fieldset class="kpi-field">
          <legend class="form-label">AI dispatch start</legend>
          <div class="kpi-field-current">
            <strong>{{ settings.aiDispatchStart?.value ? fmtYmd(settings.aiDispatchStart.value) : 'Not found in the data' }}</strong>
            <KpiBadge
              :label="settings.aiDispatchStart?.source === 'admin' ? 'Set by admin' : 'From data'"
              :tone="settings.aiDispatchStart?.source === 'admin' ? 'proxy' : 'real'"
            />
          </div>
          <p v-if="settings.aiDispatchStart?.evidence" class="kpi-field-hint">{{ settings.aiDispatchStart.evidence }}</p>
          <div class="kpi-field-row">
            <input
              v-model="form.aiDispatchStart"
              type="date"
              class="form-input"
              aria-label="AI dispatch start set by an admin"
              :aria-invalid="!!errorFor('aiDispatchStart')"
              :aria-describedby="errorFor('aiDispatchStart') ? 'kpi-err-aiDispatchStart' : 'kpi-hint-aiDispatchStart'"
              @input="clearServerError('aiDispatchStart')"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              class="text-[12px]"
              :disabled="!form.aiDispatchStart"
              @click="useData"
            >Use data</Button>
          </div>
          <p id="kpi-hint-aiDispatchStart" class="kpi-field-hint">Set a date to override the one found in the data; “Use data” clears the override.</p>
          <p v-if="errorFor('aiDispatchStart')" id="kpi-err-aiDispatchStart" class="kpi-field-error" role="alert">{{ errorFor('aiDispatchStart') }}</p>
        </fieldset>

        <div class="kpi-field">
          <label for="kpi-dedicated" class="form-label">Dedicated contracts start</label>
          <div class="kpi-field-row">
            <input
              id="kpi-dedicated"
              v-model="form.dedicatedStart"
              type="date"
              class="form-input"
              :aria-invalid="!!errorFor('dedicatedStart')"
              :aria-describedby="errorFor('dedicatedStart') ? 'kpi-err-dedicatedStart' : 'kpi-hint-dedicatedStart'"
              @input="clearServerError('dedicatedStart')"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              class="text-[12px]"
              :disabled="!form.dedicatedStart"
              @click="clearField('dedicatedStart')"
            >Clear</Button>
          </div>
          <p id="kpi-hint-dedicatedStart" class="kpi-field-hint">Not in the data. Empty leaves the dedicated-contracts before/after unset.</p>
          <p v-if="errorFor('dedicatedStart')" id="kpi-err-dedicatedStart" class="kpi-field-error" role="alert">{{ errorFor('dedicatedStart') }}</p>
        </div>

        <div class="kpi-field">
          <label for="kpi-mpg" class="form-label">Baseline MPG</label>
          <input
            id="kpi-mpg"
            v-model="form.baselineMpg"
            type="number"
            inputmode="decimal"
            :min="MPG_MIN"
            :max="MPG_MAX"
            step="0.1"
            class="form-input"
            :aria-invalid="!!errorFor('baselineMpg')"
            :aria-describedby="errorFor('baselineMpg') ? 'kpi-err-baselineMpg' : 'kpi-hint-baselineMpg'"
            @input="clearServerError('baselineMpg')"
          />
          <p id="kpi-hint-baselineMpg" class="kpi-field-hint">{{ MPG_MIN }} to {{ MPG_MAX }}, or empty. Diesel dollars saved stays “missing” until it is set.</p>
          <p v-if="errorFor('baselineMpg')" id="kpi-err-baselineMpg" class="kpi-field-error" role="alert">{{ errorFor('baselineMpg') }}</p>
        </div>

        <div class="kpi-field">
          <label for="kpi-recipients" class="form-label">Digest recipients</label>
          <textarea
            id="kpi-recipients"
            v-model="form.recipients"
            rows="4"
            class="form-textarea"
            spellcheck="false"
            autocomplete="off"
            :aria-invalid="!!errorFor('recipients')"
            :aria-describedby="errorFor('recipients') ? 'kpi-err-recipients' : 'kpi-hint-recipients'"
            @input="clearServerError('recipients')"
          ></textarea>
          <p id="kpi-hint-recipients" class="kpi-field-hint">
            One email per line, up to {{ RECIPIENTS_MAX }}. Empty = the admin inbox (ADMIN_NOTIFY_EMAIL).
            {{ settings.defaultRecipientConfigured ? 'The admin inbox is set on this server.' : 'No admin inbox is set on this server, so an empty list sends the digest to no one.' }}
          </p>
          <p v-if="errorFor('recipients')" id="kpi-err-recipients" class="kpi-field-error" role="alert">{{ errorFor('recipients') }}</p>
        </div>
      </div>

      <p v-if="formError" class="kpi-field-error" role="alert">{{ formError }}</p>

      <div class="kpi-settings-actions">
        <span class="kpi-field-hint" aria-live="polite">{{ pendingText }}</span>
        <Button type="button" variant="outline" class="text-[12px]" :disabled="(!pending.changed.length && !Object.keys(pending.errors).length) || saving" @click="reset">Discard changes</Button>
        <Button type="submit" class="text-[12px]" :disabled="!canSave">{{ saving ? 'Saving…' : 'Save settings' }}</Button>
      </div>
    </form>
  </details>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import KpiBadge from './KpiBadge.vue'
import { useKpisStore } from '../../stores/kpis'
import {
  MPG_MAX, MPG_MIN, RECIPIENTS_MAX, parseRecipients, settingsChanges, settingsFormFrom,
} from '../../lib/kpiView.js'
import { fmtYmd } from '../../utils/datetime'

// The four KPI settings (PUT /api/admin/kpis/settings). Save sends only the
// fields that changed. The checks here only say early what the server will say;
// the server checks everything again, and its 400 sentence is shown on the field
// it names.
const props = defineProps({
  settings: { type: Object, required: true },
})
const store = useKpisStore()
const saving = computed(() => store.settingsSaving)

// The settings the form was filled from: changes are measured against these.
const base = ref(props.settings)
const form = reactive(settingsFormFrom(props.settings))
const serverError = ref({ field: null, message: '' })

const pending = computed(() => settingsChanges(base.value, form))
const canSave = computed(() => !saving.value && pending.value.changed.length > 0 && !Object.keys(pending.value.errors).length)

function fill(settings) {
  base.value = settings
  Object.assign(form, settingsFormFrom(settings))
  serverError.value = { field: null, message: '' }
}

// A live update refills the form only while nobody is editing it.
watch(() => props.settings, (next) => {
  if (!pending.value.changed.length && !Object.keys(pending.value.errors).length) fill(next)
})

function errorFor(field) {
  return pending.value.errors[field] || (serverError.value.field === field ? serverError.value.message : '')
}
const formError = computed(() => (serverError.value.message && !serverError.value.field ? serverError.value.message : ''))

function clearServerError(field) {
  if (serverError.value.field === field || !serverError.value.field) serverError.value = { field: null, message: '' }
}

function clearField(field) {
  form[field] = ''
  clearServerError(field)
}

function useData() {
  clearField('aiDispatchStart')
}

function reset() {
  fill(props.settings)
}

const pendingText = computed(() => {
  const n = pending.value.changed.length
  return n ? `${n} unsaved change${n === 1 ? '' : 's'}` : ''
})

const summary = computed(() => {
  const s = props.settings
  const ai = s.aiDispatchStart?.value
    ? `${fmtYmd(s.aiDispatchStart.value)} (${s.aiDispatchStart.source === 'admin' ? 'set by admin' : 'from data'})`
    : 'not found'
  const dedicated = s.dedicatedStart?.value ? fmtYmd(s.dedicatedStart.value) : 'not set'
  const mpg = typeof s.baselineMpg === 'number' ? String(s.baselineMpg) : 'not set'
  const count = parseRecipients((s.recipients || []).join('\n')).length
  const recipients = count ? `${count} recipient${count === 1 ? '' : 's'}` : 'admin inbox'
  return `AI dispatch ${ai} · dedicated ${dedicated} · baseline MPG ${mpg} · digest to ${recipients}`
})

async function save() {
  if (!canSave.value) return
  serverError.value = { field: null, message: '' }
  const result = await store.saveSettings({ ...pending.value.body })
  // On success the store holds the saved settings (read from the store: the prop
  // follows only on the next render).
  if (result.ok) fill(store.settings || props.settings)
  else serverError.value = { field: result.field, message: result.message }
}
</script>

<style scoped>
.kpi-settings { margin-bottom: 1.25rem; }
.kpi-settings-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.75rem;
}
.kpi-settings-body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1rem;
}
.kpi-settings-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem 1.25rem;
}
@media (min-width: 768px) {
  .kpi-settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.kpi-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.kpi-field .form-label { margin-bottom: 0; padding: 0; }
.kpi-field-current {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.86rem;
}
.kpi-field-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.kpi-field-row .form-input { flex: 1 1 auto; min-width: 0; }
.kpi-field-hint {
  margin: 0;
  font-size: 0.74rem;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.kpi-field-error {
  margin: 0;
  font-size: 0.76rem;
  font-weight: 600;
  color: #b91c1c;
}
.kpi-settings-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}
.kpi-settings-actions .kpi-field-hint { margin-right: auto; }
</style>
