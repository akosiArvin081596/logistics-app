<template>
  <!-- The pass's report (GET /api/admin/receipt-auto-approve), Super Admin only. In shadow the route
       sends counts only, so no verdict reaches the people it is compared with. Every figure is the server's. -->
  <details class="aa-panel" role="region" aria-label="Fuel receipts approved by rule">
    <summary class="aa-summary">
      <span class="aa-title">Fuel receipts approved by rule</span>
      <span :class="['aa-mode', 'aa-mode--' + shownMode]">{{ shownMode === 'on' ? 'On' : 'Shadow' }}</span>
      <span v-if="c" class="aa-headline">{{ headline }}</span>
    </summary>
    <p class="aa-note">{{ shownMode === 'on'
      ? 'The hourly pass approves a Pending fuel receipt only when every rule holds. A person can undo any of them until the month closes.'
      : 'Shadow: the hourly pass records what it would approve and changes no receipt. People approve as usual; only counts show here.' }}</p>
    <p v-if="error" class="aa-warn">{{ error }}</p>
    <template v-else-if="report">
      <p v-if="report.missing" class="aa-warn">Not started: {{ MISSING[report.missing] || report.missing }}.</p>
      <p v-if="report.refused" class="aa-warn">On was refused because the status recorder is off, so the pass runs as shadow.</p>
      <p class="aa-last">
        {{ report.lastPassAt ? `Last pass ${fmtTimestamp(report.lastPassAt)}` : 'No pass since the server started' }}<template v-if="skipText">, {{ skipText }}</template><template v-if="report.lastError">; the last pass failed ({{ report.lastError }})</template>.
      </p>
      <dl v-if="c" class="aa-counts">
        <div><dt>Judged</dt><dd>{{ c.judged }}</dd></div>
        <div><dt>{{ shownMode === 'on' ? 'Passed every rule' : 'Would approve' }}</dt><dd>{{ c.approve }}</dd></div>
        <div v-if="shownMode === 'on'"><dt>Approved by the pass</dt><dd>{{ c.applied }}</dd></div>
        <div><dt>Held for a person</dt><dd>{{ c.hold }}</dd></div>
        <div><dt>Waiting</dt><dd>{{ c.wait }}</dd></div>
        <div><dt>Receipts read</dt><dd>{{ c.reads }}</dd></div>
        <div v-if="shownMode === 'on'"><dt>Undone after approval</dt><dd>{{ c.undone }}</dd></div>
        <div><dt>Decided before the pass could judge</dt><dd>{{ c.decidedBefore }}</dd></div>
        <div><dt>Rejected receipts judged</dt><dd>{{ c.rejectedJudged }}</dd></div>
        <div :class="{ 'aa-alert': c.s3 > 0 }"><dt>Would approve, but a person rejected or undid it</dt><dd>{{ c.s3 }}</dd></div>
      </dl>
      <div v-if="c && c.agreement" class="aa-block">
        <div class="aa-block-title">Against what people did (receipts judged before anyone decided)</div>
        <p class="aa-line">{{ shownMode === 'on' ? 'Passed' : 'Would approve' }}: now Approved {{ c.agreement.approve.Approved }}, Rejected {{ c.agreement.approve.Rejected }}, Pending {{ c.agreement.approve.Pending }}, undone {{ c.agreement.approve.undone }}.</p>
        <p class="aa-line">Held: approved by a person {{ c.agreement.hold.Approved }}, rejected {{ c.agreement.hold.Rejected }}, still Pending {{ c.agreement.hold.Pending }}.</p>
      </div>
      <div v-if="reasonRows.length" class="aa-block">
        <div class="aa-block-title">Why receipts were held</div>
        <ul class="aa-list">
          <li v-for="r in reasonRows" :key="r.code">{{ r.words }}: {{ r.n }}</li>
        </ul>
      </div>
      <div v-if="notAppliedRows.length" class="aa-block">
        <div class="aa-block-title">Passed, but not approved by the pass</div>
        <ul class="aa-list">
          <li v-for="r in notAppliedRows" :key="r.code">{{ r.words }}: {{ r.n }}</li>
        </ul>
      </div>
      <!-- The route lists receipts in on mode only. -->
      <div v-if="receipts.length" class="aa-block">
        <div class="aa-block-title">Receipts judged</div>
        <div class="aa-table-wrap">
          <table class="aa-table">
            <thead><tr><th>Receipt</th><th>Date</th><th>Truck</th><th>Verdict</th><th>Status now</th><th>Why held</th></tr></thead>
            <tbody>
              <tr v-for="r in receipts" :key="r.id">
                <td>#{{ r.id }}</td>
                <td>{{ fmtYmd(r.date) }}</td>
                <td>{{ r.truckUnit ? '#' + r.truckUnit : '—' }}</td>
                <td>{{ verdictWords(r) }}</td>
                <td>{{ r.status || '—' }}<template v-if="r.decidedBefore"> (decided first)</template></td>
                <td>{{ (r.reasons || []).map(reasonShort).join('; ') || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
    <p v-else class="aa-last">Loading…</p>
    <button type="button" class="aa-refresh" :disabled="loading" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
  </details>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useApi } from '../../../composables/useApi'
import { fmtTimestamp, fmtYmd } from '../../../utils/datetime'
import { reasonShort, AUTO_NOT_APPLIED } from '../../../lib/receiptAutoReview'

const props = defineProps({
  // The list's autoApprove.mode, until the report's own arrives.
  mode: { type: String, default: 'shadow' },
})

const api = useApi()
const report = ref(null)
const error = ref('')
const loading = ref(false)

const shownMode = computed(() => (report.value && report.value.mode === 'on') || (!report.value && props.mode === 'on') ? 'on' : 'shadow')
const c = computed(() => (report.value && report.value.counts) || null)
const receipts = computed(() => (report.value && Array.isArray(report.value.receipts) ? report.value.receipts : []))
const headline = computed(() => {
  if (!c.value) return ''
  return shownMode.value === 'on'
    ? `${c.value.approve} of ${c.value.judged} judged passed; ${c.value.applied} approved`
    : `would approve ${c.value.approve} of ${c.value.judged} judged`
})
const SKIPS = { close_running: 'skipped while the month close ran', sweep_running: 'skipped while the fuel sweep ran' }
// The server's start-up reasons (lib/receipt-auto-approve-pass.js readConfig), in plain words.
const MISSING = { 'FUEL_EVENTS_ENABLED is off': 'the ELD fuel-event sweep is off', 'no Gemini key is set': 'no receipt reader key is set' }
const skipText = computed(() => (report.value && SKIPS[report.value.lastSkip]) || '')
const rowsOf = (counts, words) => Object.entries(counts || {})
  .filter(([, n]) => Number(n) > 0)
  .map(([code, n]) => ({ code, n, words: words(code) }))
const reasonRows = computed(() => rowsOf(c.value && c.value.reasons, reasonShort))
const notAppliedRows = computed(() => rowsOf(c.value && c.value.notApplied, (code) => AUTO_NOT_APPLIED[code] || code))

function verdictWords(r) {
  if (r.verdict === 'approve') return r.appliedAt ? (r.undoneAt ? 'approved, then undone' : 'approved') : 'passed, not approved'
  if (r.verdict === 'hold') return 'held'
  return 'waiting'
}

async function load() {
  if (loading.value) return
  loading.value = true
  try {
    report.value = await api.get('/api/admin/receipt-auto-approve')
    error.value = ''
  } catch (err) {
    error.value = (err && err.message) || 'The report could not be read.'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.aa-panel {
  margin: 0 0 0.9rem;
  padding: 0.6rem 0.9rem;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  background: #eef2ff;
  font-size: 0.8rem;
  color: #312e81;
}
.aa-summary { cursor: pointer; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.aa-title { font-weight: 700; font-size: 0.85rem; }
.aa-mode { padding: 0.05rem 0.45rem; border-radius: 999px; font-size: 0.7rem; font-weight: 700; background: #e0e7ff; }
.aa-mode--on { background: #dcfce7; color: #166534; }
.aa-headline { color: #4338ca; }
.aa-note, .aa-last, .aa-line { margin: 0.35rem 0; }
.aa-warn { margin: 0.35rem 0; color: #991b1b; font-weight: 600; }
.aa-counts { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); gap: 0.25rem 1rem; margin: 0.5rem 0; }
.aa-counts div { display: flex; justify-content: space-between; gap: 0.5rem; }
.aa-counts dt { margin: 0; }
.aa-counts dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.aa-alert { color: #991b1b; }
.aa-block { margin: 0.5rem 0; }
.aa-block-title { font-weight: 700; }
.aa-list { margin: 0.25rem 0; padding-left: 1.1rem; }
.aa-table-wrap { max-height: 18rem; overflow: auto; margin-top: 0.25rem; }
.aa-table { width: 100%; border-collapse: collapse; }
.aa-table th, .aa-table td { text-align: left; padding: 0.2rem 0.4rem; border-bottom: 1px solid #e0e7ff; vertical-align: top; }
.aa-refresh {
  margin-top: 0.35rem;
  padding: 0.2rem 0.7rem;
  border-radius: 6px;
  border: 1px solid #6366f1;
  background: #fff;
  color: #3730a3;
  font-weight: 600;
  font-size: 0.75rem;
  cursor: pointer;
}
.aa-refresh:disabled { opacity: 0.5; cursor: default; }
</style>
