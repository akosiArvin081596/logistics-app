<template>
  <!-- A driver's own time off (R11 follow-up). variant "card" is the Kit tab's
       "My time off"; variant "banner" is the one line at the top of the Loads
       list while he is off and in the 7 days before. Rows go through
       driverTimeOffRows(), which keeps his current and upcoming rows and, of
       each, only the dates, the kind and whether he is off now. DriverView
       renders this only when the payload carried `timeOff` (the server's
       DRIVER_TIME_OFF_SCREEN_ENABLED). While the payload also carries
       `requests` (the server's DRIVER_TIME_OFF_REQUESTS_ENABLED), the card
       lists his waiting and declined requests and offers "Request days off";
       every day limit is the one the server sent. -->
  <div v-if="variant === 'banner'" role="status" class="time-off-live">
    <p v-if="bannerText" :class="['time-off-banner', offNow ? 'time-off-banner-now' : 'time-off-banner-next']">
      <span class="time-off-banner-icon" aria-hidden="true">&#128197;</span>
      <span class="time-off-banner-text">{{ bannerText }}</span>
    </p>
  </div>

  <section v-else class="card time-off-card" :aria-labelledby="titleId">
    <div class="time-off-header">
      <div class="time-off-icon" aria-hidden="true">&#128197;</div>
      <h3 :id="titleId" class="time-off-title">My time off</h3>
    </div>

    <p v-if="loadFailed" class="time-off-empty">Your time off couldn't be loaded. Try again later.</p>
    <ul v-else-if="rows.length" class="time-off-list">
      <li v-for="r in rows" :key="r.id" class="time-off-row">
        <span class="time-off-range">{{ availabilityRangeText(r.from, r.to) }}</span>
        <span class="time-off-meta">
          <span class="time-off-kind">{{ kindLabel(r.kind) }}</span>
          <span :class="['time-off-tag', r.status === 'current' ? 'time-off-tag-now' : 'time-off-tag-next']">{{ r.status === 'current' ? 'Off now' : 'Upcoming' }}</span>
        </span>
      </li>
    </ul>
    <p v-else class="time-off-empty">No time off recorded.</p>

    <template v-if="requestsOn && !loadFailed">
      <h4 v-if="requests.length" class="time-off-subtitle">Your requests</h4>
      <ul v-if="requests.length" class="time-off-list">
        <li v-for="r in requests" :key="`request-${r.id}`" class="time-off-row">
          <span class="time-off-range">{{ availabilityRangeText(r.from, r.to) }}</span>
          <span class="time-off-meta">
            <span class="time-off-kind">{{ kindLabel(r.kind) }}</span>
            <span :class="['time-off-tag', r.request === 'waiting' ? 'time-off-tag-wait' : 'time-off-tag-no']">{{ driverRequestStatusText(r) }}</span>
          </span>
          <button v-if="r.canCancel" type="button" class="time-off-btn time-off-btn-quiet" :disabled="busy" @click="withdraw(r)">Cancel request</button>
        </li>
      </ul>

      <form v-if="formOpen" class="time-off-form" novalidate @submit.prevent="send">
        <label class="time-off-label">
          First day off
          <input v-model="form.from" type="date" class="time-off-input" :min="bounds.fromMin || undefined" :max="bounds.fromMax || undefined" required data-time-off-first />
        </label>
        <label class="time-off-label">
          Last day off
          <input v-model="form.to" type="date" class="time-off-input" :min="bounds.toMin || undefined" :max="bounds.toMax || undefined" required />
        </label>
        <label class="time-off-label">
          Kind
          <select v-model="form.kind" class="time-off-input">
            <option v-for="k in AVAILABILITY_KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
          </select>
        </label>
        <p v-if="error" class="time-off-error" role="alert">{{ error }}</p>
        <div class="time-off-actions">
          <button type="button" class="time-off-btn time-off-btn-quiet" :disabled="busy" @click="closeForm">Back</button>
          <button type="submit" class="time-off-btn time-off-btn-main" :disabled="busy || !canSend">Send request</button>
        </div>
      </form>
      <button v-else-if="timeOff.canRequest === true" type="button" class="time-off-btn time-off-btn-main" :disabled="busy" @click="openForm">Request days off</button>
      <p v-if="!formOpen && error" class="time-off-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="time-off-note" role="status">{{ notice }}</p>
    </template>

    <p class="time-off-hint">{{ requestsOn ? REQUEST_HINT : RECORDED_HINT }}</p>
    <button type="button" class="time-off-btn" @click="emit('message-dispatch')">Message dispatch</button>
  </section>
</template>

<script setup>
import { computed, nextTick, reactive, ref, useId, watch } from 'vue'
import {
  AVAILABILITY_KINDS, RECORDED_HINT, REQUEST_HINT, availabilityRangeText, canSendRequest, driverRequestRows,
  driverRequestStatusText, driverTimeOffBanner, driverTimeOffRows, kindLabel, requestBody, requestFormBounds, requestFormStart,
} from '../../lib/availabilityText'
import { useDriverStore } from '../../stores/driver'

const props = defineProps({
  // The payload's `timeOff`: { today, rows }, or { today, rows: [], error: true }
  // when the server could not read it; with requests on, also { requests,
  // requestLimits, canRequest }.
  timeOff: { type: Object, required: true },
  variant: { type: String, default: 'card' },
})
const emit = defineEmits(['message-dispatch'])
const driverStore = useDriverStore()

const titleId = useId()
const loadFailed = computed(() => props.timeOff.error === true)
const rows = computed(() => driverTimeOffRows(props.timeOff.rows))
const bannerText = computed(() => driverTimeOffBanner(rows.value, props.timeOff.today))
const offNow = computed(() => rows.value.some((r) => r.from <= props.timeOff.today && props.timeOff.today <= r.to))

// The request keys' presence is the server's flag.
const requestsOn = computed(() => Array.isArray(props.timeOff.requests))
const requests = computed(() => driverRequestRows(props.timeOff.requests))
const limits = computed(() => props.timeOff.requestLimits || null)
const formOpen = ref(false)
const form = reactive({ kind: 'off_duty', from: '', to: '' })
const bounds = computed(() => requestFormBounds(limits.value, form))
const canSend = computed(() => canSendRequest(form, limits.value))
const busy = ref(false)
const error = ref('')
const notice = ref('')

async function openForm() {
  Object.assign(form, requestFormStart(limits.value))
  error.value = ''
  notice.value = ''
  formOpen.value = true
  await nextTick()
  const first = document.querySelector('[data-time-off-first]')
  if (first) first.focus()
}

function closeForm() {
  formOpen.value = false
  error.value = ''
}

// A last day before the first is moved up to it, so the two fields never disagree.
function keepOrder() {
  if (form.from && form.to && form.to < form.from) form.to = form.from
}
watch(() => form.from, keepOrder)

async function send() {
  keepOrder()
  if (!canSend.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await driverStore.requestTimeOff(requestBody(form))
    formOpen.value = false
    notice.value = 'Request sent. Dispatch will answer in the app.'
  } catch (err) {
    error.value = (err && err.message) || 'Your request could not be sent. Try again, or message dispatch.'
    // Refused over its days: the form takes the server's current limits again.
    if (err && (err.code === 'TIME_OFF_TOO_SOON' || err.code === 'TIME_OFF_TOO_FAR')) await driverStore.refreshTimeOffLimits()
  } finally {
    busy.value = false
  }
}

async function withdraw(r) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await driverStore.cancelTimeOffRequest(r.id)
    notice.value = `Request for ${availabilityRangeText(r.from, r.to)} withdrawn.`
  } catch (err) {
    error.value = (err && err.message) || 'The request could not be withdrawn. Try again, or message dispatch.'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.time-off-card {
  margin-top: 1rem;
}
.time-off-header {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin-bottom: 0.75rem;
}
.time-off-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--accent-dim);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  flex-shrink: 0;
}
.time-off-title {
  font-size: 0.95rem;
  font-weight: 700;
  margin: 0;
}
.time-off-subtitle {
  font-size: 0.85rem;
  font-weight: 700;
  margin: 0 0 0.5rem;
}
.time-off-list {
  list-style: none;
  margin: 0 0 0.75rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.time-off-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem 0.75rem;
  padding: 0.7rem 0.85rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  min-width: 0;
}
.time-off-range {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
  overflow-wrap: anywhere;
}
.time-off-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.time-off-kind {
  font-size: 0.8rem;
  color: var(--text-dim);
}
.time-off-tag {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.15rem 0.55rem;
  border-radius: 12px;
  white-space: normal;
}
.time-off-tag-now {
  background: var(--amber-dim);
  color: #92400e;
}
.time-off-tag-next {
  background: var(--accent-dim);
  color: #0369a1;
}
.time-off-tag-wait {
  background: #f1f5f9;
  color: #334155;
}
.time-off-tag-no {
  background: #fef2f2;
  color: #991b1b;
}
.time-off-empty {
  font-size: 0.85rem;
  color: var(--text-dim);
  margin: 0 0 0.75rem;
}
.time-off-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin: 0 0 0.75rem;
}
.time-off-label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text);
  min-width: 0;
}
.time-off-input {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: var(--radius, 8px);
  background: var(--surface, #fff);
  color: var(--text);
  font-family: inherit;
  font-size: 1rem;
}
.time-off-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.time-off-error {
  font-size: 0.82rem;
  color: #991b1b;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: var(--radius, 8px);
  padding: 0.5rem 0.65rem;
  margin: 0 0 0.6rem;
  overflow-wrap: anywhere;
}
.time-off-note {
  font-size: 0.82rem;
  color: var(--text-dim);
  margin: 0 0 0.6rem;
}
.time-off-hint {
  font-size: 0.8rem;
  color: var(--text-dim);
  margin: 0 0 0.6rem;
}
.time-off-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--accent);
  border-radius: var(--radius, 8px);
  background: transparent;
  color: #0369a1;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.time-off-btn + .time-off-btn,
.time-off-btn-main {
  margin-bottom: 0.6rem;
}
.time-off-btn-main {
  background: var(--accent);
  color: #fff;
}
.time-off-btn-quiet {
  border-color: var(--border);
  color: var(--text);
}
.time-off-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.time-off-btn:hover:not(:disabled) {
  background: var(--accent-dim);
}
.time-off-btn-main:hover:not(:disabled) {
  background: var(--accent);
  filter: brightness(0.95);
}
.time-off-btn:focus-visible,
.time-off-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.time-off-banner {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0 0 0.75rem;
  padding: 0.6rem 0.8rem;
  border-radius: var(--radius, 8px);
  font-size: 0.85rem;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.time-off-banner-now {
  background: var(--amber-dim);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: #92400e;
}
.time-off-banner-next {
  background: var(--accent-dim);
  border: 1px solid rgba(56, 189, 248, 0.35);
  color: #0369a1;
}
.time-off-banner-icon {
  flex-shrink: 0;
}
.time-off-banner-text {
  min-width: 0;
}
@media (min-width: 768px) {
  .time-off-btn {
    width: auto;
    padding: 0.5rem 1.25rem;
  }
  .time-off-actions {
    flex-direction: row;
  }
}
</style>
