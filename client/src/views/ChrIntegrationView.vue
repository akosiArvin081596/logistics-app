<template>
  <div class="admin-page chr-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header chr-header">
      <div class="chr-heading">
        <h2>C.H. Robinson</h2>
        <p class="chr-desc">What LogisX would send C.H. Robinson about its loads, and what it has sent. No driver names or phone numbers are ever sent.</p>
      </div>
      <div v-if="status && status.enabled" class="chr-stop">
        <button v-if="!confirmStop" type="button" class="btn btn-danger btn-sm" :disabled="busy" @click="confirmStop = true">Stop everything</button>
        <template v-else>
          <span class="chr-stop-ask">Turn every kind of update Off?</span>
          <button type="button" class="btn btn-danger btn-sm" :disabled="busy" @click="stopEverything">Yes, stop</button>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" @click="confirmStop = false">Cancel</button>
        </template>
      </div>
    </div>

    <p v-if="loadError" class="chr-error" role="alert">
      <span>Couldn't load the C.H. Robinson page ({{ loadError }}).</span>
      <button type="button" class="btn btn-secondary btn-sm" @click="refreshAll">Retry</button>
    </p>
    <p v-if="actionError" class="chr-error" role="alert">{{ actionError }}</p>

    <div v-if="!status && !loadError" class="chr-note">Loading…</div>

    <template v-else-if="status && !status.enabled">
      <section class="chr-card">
        <div class="chr-chips">
          <span class="chr-chip chr-chip--muted">Milestones: Off: server setting</span>
          <span class="chr-chip chr-chip--muted">Location: Off: server setting</span>
        </div>
        <p class="chr-note">The C.H. Robinson recorder is off on the server. Nothing is recorded or sent.</p>
      </section>
    </template>

    <template v-else-if="status">
      <section class="chr-card" aria-labelledby="chr-state-title">
        <h3 id="chr-state-title" class="chr-title">Status</h3>
        <div class="chr-chips">
          <span class="chr-chip" :class="`chr-chip--${milestoneChip.tone}`">Milestones: {{ milestoneChip.label }}</span>
          <span class="chr-chip" :class="`chr-chip--${locationChip.tone}`">Location: {{ locationChip.label }}</span>
        </div>
        <dl class="chr-facts">
          <div><dt>Last check</dt><dd>{{ status.lastTickAt ? fmt(status.lastTickAt) : 'Not yet' }}</dd></div>
          <div v-if="status.lastErrorCode"><dt>Last problem</dt><dd>{{ status.lastErrorCode }}</dd></div>
          <div><dt>Today</dt><dd>{{ todayText }}</dd></div>
        </dl>
      </section>

      <section class="chr-card" aria-labelledby="chr-controls-title">
        <h3 id="chr-controls-title" class="chr-title">Settings</h3>
        <div class="chr-form">
          <label class="chr-field">
            <span>Milestones</span>
            <select v-model="draft.milestones" :disabled="busy">
              <option value="off">Off</option>
              <option value="dry_run">Dry run</option>
              <option value="live" :disabled="!status.live || !status.live.allowed">Live</option>
            </select>
          </label>
          <p v-if="status.live && !status.live.allowed" class="chr-hint">Live is not available: {{ liveReason }}</p>
          <label class="chr-check">
            <input v-model="draft.arrivedPickup" type="checkbox" :disabled="busy" />
            <span>Send "Arrived at pickup" (off until C.H. Robinson says whether it counts as a check-in for the DVIR charge)</span>
          </label>
          <label class="chr-check">
            <input v-model="draft.positionsInMilestones" type="checkbox" :disabled="busy || !status.locationEnabled" />
            <span>Add the truck's position at the facility to each update<template v-if="!status.locationEnabled"> (off on the server)</template></span>
          </label>
          <label class="chr-field">
            <span>Wait before deciding (minutes, 0 to 15)</span>
            <input v-model.number="draft.settleMin" type="number" min="0" max="15" step="1" :disabled="busy" />
          </label>
          <div class="chr-actions">
            <button type="button" class="btn btn-primary btn-sm" :disabled="busy || !dirty" @click="saveSettings">Save</button>
          </div>
        </div>
      </section>

      <section class="chr-card" aria-labelledby="chr-held-title">
        <h3 id="chr-held-title" class="chr-title">Held updates</h3>
        <p v-if="!held.length" class="chr-note">None. A held update waits for a person, who posts it in Navisphere if it is right.</p>
        <ul v-else class="chr-list">
          <li v-for="row in held" :key="row.id" class="chr-row">
            <div class="chr-row-main">
              <button type="button" class="chr-link" @click="openLoad(row.loadId)">{{ row.loadId }}</button>
              <span>{{ eventText(row) }} · {{ stopText(row) }}</span>
              <span class="chr-dim">{{ fmt(row.eventAt) }}</span>
            </div>
            <div class="chr-row-sub">{{ rowStatusText(row, fmt) }}</div>
          </li>
        </ul>
      </section>

      <section class="chr-card" aria-labelledby="chr-loads-title">
        <h3 id="chr-loads-title" class="chr-title">CHR loads (last 14 days)</h3>
        <p v-if="!loads.length" class="chr-note">No CHR load yet.</p>
        <ul v-else class="chr-list">
          <li v-for="l in loads" :key="l.loadId" class="chr-row">
            <div class="chr-row-main">
              <button type="button" class="chr-link" @click="openLoad(l.loadId)">{{ l.loadId }}</button>
              <span>{{ l.lastEvent ? eventWords[l.lastEvent] || l.lastEvent : 'No update yet' }}</span>
              <span v-if="l.multiStop" class="chr-chip chr-chip--warn">Multi-stop</span>
              <span v-if="l.hold" class="chr-chip chr-chip--warn">On hold</span>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="detail" class="chr-card" aria-labelledby="chr-load-title">
        <h3 id="chr-load-title" class="chr-title">Load {{ detail.load.loadId }}</h3>
        <ol class="chr-ladder">
          <li v-for="step in ladder" :key="step.event">
            <strong>{{ step.label }}</strong>
            <span class="chr-dim">{{ step.row ? rowStatusText(step.row, fmt) : 'Not yet' }}</span>
          </li>
        </ol>
        <dl class="chr-facts">
          <div><dt>Multi-stop</dt><dd>{{ detail.load.multiStop ? 'Yes' : 'No' }}</dd></div>
          <div><dt>POD</dt><dd>{{ detail.pod ? `${detail.pod.count} live` : 'Unknown' }}</dd></div>
          <div><dt>Invoice draft</dt><dd>{{ draftText }}</dd></div>
          <div v-if="detail.load.hold"><dt>On hold</dt><dd>{{ detail.load.holdReason }} ({{ detail.load.holdBy }}, {{ fmt(detail.load.holdAt) }})</dd></div>
        </dl>
        <div class="chr-form">
          <label class="chr-field">
            <span>Reason ({{ detail.load.hold ? 'to release' : 'to hold' }})</span>
            <input v-model="holdReason" type="text" maxlength="200" :disabled="busy" />
          </label>
          <div class="chr-actions">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="busy || !holdReason.trim()" @click="setHold(!detail.load.hold)">
              {{ detail.load.hold ? 'Release' : 'Hold this load' }}
            </button>
            <button type="button" class="btn btn-secondary btn-sm" @click="closeLoad">Close</button>
          </div>
        </div>
      </section>

      <section class="chr-card" aria-labelledby="chr-log-title">
        <h3 id="chr-log-title" class="chr-title">Send log</h3>
        <div class="chr-filters">
          <label class="chr-field">
            <span>Status</span>
            <select v-model="filter.status" @change="reloadEvents">
              <option value="">Any</option>
              <option v-for="(label, code) in statusWords" :key="code" :value="code">{{ label }}</option>
            </select>
          </label>
          <label class="chr-field">
            <span>Load</span>
            <input v-model="filter.loadId" type="text" maxlength="40" @keyup.enter="reloadEvents" />
          </label>
          <button type="button" class="btn btn-secondary btn-sm" @click="reloadEvents">Show</button>
        </div>
        <p v-if="!events.length" class="chr-note">No updates recorded.</p>
        <ul v-else class="chr-list">
          <li v-for="row in events" :key="row.id" class="chr-row">
            <div class="chr-row-main">
              <button type="button" class="chr-link" @click="openLoad(row.loadId)">{{ row.loadId }}</button>
              <span>{{ eventText(row) }} · {{ stopText(row) }}</span>
              <span class="chr-dim">{{ fmt(row.eventAt) }}</span>
              <span class="chr-chip" :class="row.mode === 'live' ? 'chr-chip--live' : 'chr-chip--dry'">{{ row.mode === 'live' ? 'Live' : 'Dry run' }}</span>
            </div>
            <div class="chr-row-sub">
              {{ rowStatusText(row, fmt) }}
              <template v-if="verifyWords[row.verify]"> · {{ verifyWords[row.verify] }}</template>
              <template v-if="row.source"> · from {{ row.source }}</template>
              <template v-if="row.attempts"> · {{ row.attempts }} attempt(s)</template>
              <template v-if="row.fieldsDropped"> · {{ row.fieldsDropped }} field(s) dropped</template>
            </div>
          </li>
        </ul>
        <div v-if="nextBefore" class="chr-actions">
          <button type="button" class="btn btn-secondary btn-sm" @click="moreEvents">Older</button>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import { fmtAppInstant } from '../utils/datetime'
import {
  CHR_API, CHR_EVENT_WORDS, CHR_STATUS_WORDS, CHR_VERIFY_WORDS, CHR_LIVE_REASONS,
  kindChip, rowStatusText, stopText, ladderOf, eventsQuery, loadSummaryUrl,
} from '../lib/chrIntegration.js'

// The C.H. Robinson page: Super Admin only (router meta and requireRole on every
// route). Every figure and sentence comes from the server's codes.
const api = useApi()
const route = useRoute()
const router = useRouter()

const status = ref(null)
const events = ref([])
const nextBefore = ref(null)
const held = ref([])
const loads = ref([])
const detail = ref(null)
const loadError = ref('')
const actionError = ref('')
const busy = ref(false)
const confirmStop = ref(false)
const holdReason = ref('')
const filter = reactive({ status: '', loadId: '' })
const draft = reactive({ milestones: 'dry_run', arrivedPickup: false, positionsInMilestones: false, settleMin: 5 })

const statusWords = CHR_STATUS_WORDS
const eventWords = CHR_EVENT_WORDS
const verifyWords = CHR_VERIFY_WORDS
const fmt = (v) => (v ? fmtAppInstant(v) : '—')
const eventText = (row) => CHR_EVENT_WORDS[row.event] || row.event

const milestoneChip = computed(() => kindChip(status.value, 'milestones'))
const locationChip = computed(() => kindChip(status.value, 'location'))
const liveReason = computed(() => CHR_LIVE_REASONS[status.value?.live?.reason] || '')
const ladder = computed(() => ladderOf(detail.value?.events))
const todayText = computed(() => {
  const t = status.value?.today || {}
  const parts = Object.entries(t).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${(CHR_STATUS_WORDS[k] || k).toLowerCase()}`)
  return parts.length ? parts.join(', ') : 'Nothing yet'
})
const draftText = computed(() => {
  const d = detail.value?.draft
  if (!d) return 'None made'
  return `Made ${fmt(d.at)}${d.toChr ? ', to a chrobinson.com address' : ''}`
})
const FIELDS = ['milestones', 'arrivedPickup', 'positionsInMilestones', 'settleMin']
const dirty = computed(() => Boolean(status.value?.settings) && FIELDS.some((k) => draft[k] !== status.value.settings[k]))

function syncDraft() {
  const s = status.value?.settings
  if (!s) return
  for (const k of FIELDS) draft[k] = s[k]
}

async function loadStatus() {
  status.value = await api.get(`${CHR_API}/status`)
  syncDraft()
}

async function reloadEvents() {
  const r = await api.get(eventsQuery({ status: filter.status, loadId: filter.loadId }))
  events.value = r.events || []
  nextBefore.value = r.next
}

async function moreEvents() {
  const r = await api.get(eventsQuery({ status: filter.status, loadId: filter.loadId, before: nextBefore.value }))
  events.value = events.value.concat(r.events || [])
  nextBefore.value = r.next
}

async function loadDetail(id) {
  if (!id) { detail.value = null; return }
  try {
    detail.value = await api.get(loadSummaryUrl(id))
  } catch (e) {
    detail.value = null
    if (e.status !== 404) actionError.value = e.message
  }
}

async function refreshAll() {
  loadError.value = ''
  try {
    await loadStatus()
    if (!status.value.enabled) return
    const [h, l] = await Promise.all([api.get(eventsQuery({ status: 'held' })), api.get(`${CHR_API}/loads`), reloadEvents()])
    held.value = h.events || []
    loads.value = l.loads || []
    if (route.query.load) await loadDetail(String(route.query.load))
  } catch (e) {
    loadError.value = e.message
  }
}

async function act(fn) {
  actionError.value = ''
  busy.value = true
  try {
    await fn()
  } catch (e) {
    actionError.value = e.message
  } finally {
    busy.value = false
  }
}

function saveSettings() {
  return act(async () => {
    const patch = {}
    for (const k of FIELDS) if (draft[k] !== status.value.settings[k]) patch[k] = draft[k]
    await api.put(`${CHR_API}/settings`, patch)
    await refreshAll()
  })
}

function stopEverything() {
  return act(async () => {
    await api.post(`${CHR_API}/stop`, {})
    confirmStop.value = false
    await refreshAll()
  })
}

function setHold(hold) {
  const id = detail.value?.load?.loadId
  return act(async () => {
    await api.post(`${loadSummaryUrl(id)}/hold`, { hold, reason: holdReason.value.trim() })
    holdReason.value = ''
    await refreshAll()
    await loadDetail(id)
  })
}

function openLoad(id) {
  filter.loadId = id
  router.replace({ query: { ...route.query, load: id } })
}

function closeLoad() {
  router.replace({ query: Object.fromEntries(Object.entries(route.query).filter(([k]) => k !== 'load')) })
}

watch(() => route.query.load, (id) => {
  if (id) filter.loadId = String(id)
  if (status.value?.enabled) {
    loadDetail(id ? String(id) : '')
    reloadEvents().catch((e) => { actionError.value = e.message })
  }
})

useSocketRefresh('chr:changed', () => refreshAll())
if (route.query.load) filter.loadId = String(route.query.load)
refreshAll()
</script>

<style scoped>
.chr-header { align-items: flex-start; gap: 0.75rem; flex-wrap: wrap; }
.chr-heading { min-width: 0; flex: 1 1 18rem; }
.chr-desc { margin: 0.25rem 0 0; font-size: 0.82rem; color: var(--text-dim); }
.chr-stop { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.chr-stop-ask { font-size: 0.8rem; font-weight: 600; }
.chr-card {
  margin: 0 0 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface, #fff);
  min-width: 0;
}
.chr-title { margin: 0 0 0.6rem; font-size: 0.95rem; font-weight: 700; color: var(--text); }
.chr-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem; }
.chr-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 0.74rem;
  font-weight: 600;
}
.chr-chip--live { border-color: #86efac; background: #f0fdf4; color: #166534; }
.chr-chip--dry { border-color: #93c5fd; background: #eff6ff; color: #1e40af; }
.chr-chip--warn { border-color: #fcd34d; background: #fffbeb; color: #92400e; }
.chr-chip--muted { color: var(--text-dim); }
.chr-facts { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.35rem; margin: 0; font-size: 0.8rem; }
.chr-facts div { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.chr-facts dt { font-weight: 600; min-width: 7rem; }
.chr-facts dd { margin: 0; overflow-wrap: anywhere; }
.chr-form { display: flex; flex-direction: column; gap: 0.6rem; font-size: 0.82rem; }
.chr-field { display: flex; flex-direction: column; gap: 0.2rem; max-width: 22rem; }
.chr-field input, .chr-field select { padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius); font-size: 0.82rem; }
.chr-check { display: flex; gap: 0.5rem; align-items: flex-start; }
.chr-hint { margin: -0.3rem 0 0; font-size: 0.76rem; color: var(--text-dim); }
.chr-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.4rem; }
.chr-filters { display: flex; gap: 0.6rem; align-items: flex-end; flex-wrap: wrap; margin-bottom: 0.6rem; font-size: 0.82rem; }
.chr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.chr-row { padding: 0.5rem 0.6rem; border: 1px solid var(--border); border-radius: var(--radius); font-size: 0.8rem; min-width: 0; }
.chr-row-main { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.chr-row-sub { margin-top: 0.25rem; color: var(--text-dim); overflow-wrap: anywhere; }
.chr-link { background: none; border: none; padding: 0; color: var(--accent, #2563eb); font-weight: 600; cursor: pointer; font-size: inherit; }
.chr-dim { color: var(--text-dim); }
.chr-note { margin: 0; font-size: 0.82rem; color: var(--text-dim); }
.chr-ladder { margin: 0 0 0.6rem; padding-left: 1.2rem; display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.8rem; }
.chr-ladder li span { display: block; }
.chr-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0 0 1rem;
  padding: 0.6rem 0.85rem;
  border-radius: var(--radius);
  background: var(--danger-dim);
  color: #b91c1c;
  font-size: 0.8rem;
}
@media (min-width: 768px) {
  .chr-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
