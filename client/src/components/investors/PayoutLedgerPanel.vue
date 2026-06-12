<template>
  <div class="card payout-ledger">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--accent);"></div>
      Monthly Payout Ledger
      <button class="btn-reload" :disabled="store.payoutsLoading" @click="store.loadPayouts()">
        {{ store.payoutsLoading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>
    <p class="ledger-sub">
      Per investor, per month: loads hauled, revenue, and the payout owed — the same number the
      investor's own portal shows. Mark a month <strong>Paid</strong> once the transfer is made;
      the investor sees the status in their Monthly Statements. Undo reverts a mistaken mark.
    </p>

    <SkeletonLoader v-if="store.payoutsLoading && !store.payoutStatements.length" :rows="3" :cols="6" />
    <EmptyState v-else-if="!store.payoutStatements.length">
      No investor portal accounts yet — statements appear once an investor has a login.
    </EmptyState>

    <div v-else class="inv-blocks">
      <details
        v-for="s in store.payoutStatements"
        :key="s.investorUserId"
        class="inv-block"
        :open="store.payoutStatements.length === 1"
      >
        <summary class="inv-summary">
          <span class="inv-name">{{ s.fullName }}</span>
          <span class="inv-user">@{{ s.username }}</span>
          <span class="summary-pills">
            <span class="pill" :class="s.totals.outstanding > 0 ? 'pill-pending' : 'pill-ok'">
              Outstanding: <strong>{{ fmt(s.totals.outstanding) }}</strong>
            </span>
            <span class="pill">Paid to date: <strong>{{ fmtExact(s.totals.paid) }}</strong></span>
          </span>
        </summary>

        <table class="ledger-table">
          <thead>
            <tr>
              <th>Month</th>
              <th class="num">Loads</th>
              <th class="num">Revenue</th>
              <th class="num">Owed</th>
              <th>Status</th>
              <th class="act"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in visibleMonths(s)" :key="row.month">
              <td class="month-cell">
                {{ monthLabel(row.month) }}
                <span v-if="row.isCurrentMonth" class="current-tag">current</span>
              </td>
              <td class="num mono" :class="{ 'has-split': hasTruckSplit(row) }" :title="loadsTooltip(row)">{{ row.loads }}</td>
              <td class="num mono">{{ fmt(row.revenue) }}</td>
              <td class="num mono" :class="row.owed >= 0 ? 'pos' : 'neg'">{{ fmt(row.owed) }}</td>
              <td>
                <template v-if="row.paid">
                  <span class="badge badge-paid" :title="paidTooltip(row)">
                    Paid {{ shortDate(row.payout?.paidAt) }}
                  </span>
                  <div class="paid-meta">
                    {{ fmtExact(row.payout?.amountPaid) }}
                    <template v-if="row.payout?.markedBy"> · by {{ row.payout.markedBy }}</template>
                  </div>
                </template>
                <span
                  v-else-if="row.isCurrentMonth"
                  class="badge badge-progress"
                  title="This month is still accruing — the owed figure can change until month end"
                >In progress</span>
                <span v-else class="badge badge-pending">Pending</span>
              </td>
              <td class="act">
                <button v-if="!row.paid" class="btn-mark" @click="openMark(s, row)">Mark paid</button>
                <button v-else class="btn-undo" title="Revert this month to Pending" @click="undoTarget = { investor: s, row }">Undo</button>
              </td>
            </tr>
          </tbody>
        </table>

        <button
          v-if="s.months.length > MONTHS_SHOWN"
          class="btn-show-all"
          @click="toggleShowAll(s.investorUserId)"
        >
          {{ showAll[s.investorUserId] ? 'Show recent months only' : `Show all ${s.months.length} months` }}
        </button>
      </details>
    </div>

    <!-- Mark-as-Paid dialog -->
    <Teleport to="body">
      <div v-if="markTarget" class="mark-overlay" @click.self="closeMark">
        <div class="mark-dialog">
          <h3>Mark payout as paid</h3>
          <p class="mark-sub">
            {{ markTarget.investor.fullName }} — <strong>{{ monthLabel(markTarget.row.month) }}</strong>
          </p>
          <div class="owed-line">
            Computed owed: <strong :class="markTarget.row.owed >= 0 ? 'pos' : 'neg'">{{ fmt(markTarget.row.owed) }}</strong>
            <span class="owed-detail">({{ markTarget.row.loads }} load{{ markTarget.row.loads === 1 ? '' : 's' }}, {{ fmt(markTarget.row.revenue) }} revenue)</span>
          </div>
          <div v-if="markTarget.row.isCurrentMonth" class="mark-warn">
            This month is still in progress — the owed amount can grow until month end. Marking it
            paid now records today's figure; you can Undo and re-mark later.
          </div>
          <div v-if="markTarget.row.owed <= 0" class="mark-warn">
            This month computed {{ markTarget.row.owed < 0 ? 'a loss' : 'no payout' }} — recording
            $0 closes it out as settled with nothing transferred.
          </div>

          <label class="f-label">Amount paid</label>
          <div class="amount-wrap">
            <span class="amount-prefix">$</span>
            <input v-model.number="markAmount" type="number" min="0" step="0.01" class="f-input" />
          </div>

          <label class="f-label">Note (optional)</label>
          <textarea
            v-model="markNote"
            rows="2"
            maxlength="500"
            class="f-input"
            placeholder="e.g. Zelle transfer #1234, paid via check"
          ></textarea>

          <div class="mark-actions">
            <button class="btn btn-secondary" :disabled="busy" @click="closeMark">Cancel</button>
            <button class="btn btn-primary" :disabled="busy || !amountValid" @click="confirmMark">
              {{ busy ? 'Saving…' : 'Confirm — Mark Paid' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Undo confirm -->
    <ConfirmModal
      :open="!!undoTarget"
      title="Undo paid mark"
      :message="undoMessage"
      confirm-text="Undo"
      :danger="true"
      @confirm="confirmUndo"
      @cancel="undoTarget = null"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useInvestorsStore } from '../../stores/investors'
import { useToast } from '../../composables/useToast'
import { formatCurrency as fmt } from '../../utils/format'
import SkeletonLoader from '../shared/SkeletonLoader.vue'
import EmptyState from '../shared/EmptyState.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'

const MONTHS_SHOWN = 12

const store = useInvestorsStore()
const { show: toast } = useToast()

const showAll = reactive({})
const markTarget = ref(null) // { investor, row }
const markAmount = ref(0)
const markNote = ref('')
const undoTarget = ref(null) // { investor, row }
const busy = ref(false)

const amountValid = computed(() => Number.isFinite(markAmount.value) && markAmount.value >= 0)

const undoMessage = computed(() => {
  if (!undoTarget.value) return ''
  const { investor, row } = undoTarget.value
  return `Remove the paid record of ${fmtExact(row.payout?.amountPaid)} for ${investor.fullName} — ${monthLabel(row.month)}? The month reverts to Pending. The original mark stays in the audit trail.`
})

// Newest month first — the months you act on are the most recent ones.
function visibleMonths(statement) {
  const sorted = [...statement.months].sort((a, b) => b.month.localeCompare(a.month))
  return showAll[statement.investorUserId] ? sorted : sorted.slice(0, MONTHS_SHOWN)
}

function toggleShowAll(investorUserId) {
  showAll[investorUserId] = !showAll[investorUserId]
}

function openMark(investor, row) {
  markTarget.value = { investor, row }
  // Prefill with the computed owed; a loss/zero month prefills $0 (the server
  // rejects negative amounts — recording $0 closes the month as settled).
  markAmount.value = Math.max(0, Math.round((row.owed || 0) * 100) / 100)
  markNote.value = ''
}

function closeMark() {
  if (busy.value) return
  markTarget.value = null
}

async function confirmMark() {
  if (!markTarget.value || !amountValid.value) return
  busy.value = true
  try {
    await store.markPayoutPaid({
      investorUserId: markTarget.value.investor.investorUserId,
      month: markTarget.value.row.month,
      amount: markAmount.value,
      note: markNote.value.trim(),
    })
    toast(`${monthLabel(markTarget.value.row.month)} marked paid for ${markTarget.value.investor.fullName}`)
    markTarget.value = null
  } catch (err) {
    toast(err.message || 'Failed to mark payout as paid', 'error')
  } finally {
    busy.value = false
  }
}

async function confirmUndo() {
  const target = undoTarget.value
  if (!target?.row?.payout?.id) { undoTarget.value = null; return }
  try {
    await store.unmarkPayout(target.row.payout.id)
    toast(`${monthLabel(target.row.month)} reverted to Pending for ${target.investor.fullName}`)
  } catch (err) {
    toast(err.message || 'Failed to undo paid mark', 'error')
  } finally {
    undoTarget.value = null
  }
}

// Exact-amount formatter — shows cents only when present ($1,250.50 vs $1,250).
function fmtExact(n) {
  const v = Number(n || 0)
  const cents = Math.abs(v % 1) > 0.004
  const prefix = v < 0 ? '-$' : '$'
  return prefix + Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function monthLabel(mk) {
  if (!mk) return ''
  const [y, m] = mk.split('-')
  return `${MONTH_NAMES[parseInt(m) - 1] || m} ${y}`
}

function shortDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function hasTruckSplit(row) {
  return Object.keys(row.perTruck || {}).length > 0
}

// Per-truck "Truck 104: 7 loads — $21,300" lines, biggest earner first.
function loadsTooltip(row) {
  const entries = Object.entries(row.perTruck || {})
    .sort((a, b) => (b[1]?.revenue || 0) - (a[1]?.revenue || 0))
  if (!entries.length) return ''
  return entries
    .map(([unit, v]) => `${unit === 'Unassigned' ? 'No truck recorded' : 'Truck ' + unit}: ${v?.loads || 0} load${(v?.loads || 0) === 1 ? '' : 's'} — ${fmt(v?.revenue)}`)
    .join('\n')
}

function paidTooltip(row) {
  if (!row.payout) return 'Paid'
  const parts = [`Paid ${fmtExact(row.payout.amountPaid)}`]
  if (row.payout.paidAt) parts.push(`on ${shortDate(row.payout.paidAt)}`)
  if (row.payout.markedBy) parts.push(`by ${row.payout.markedBy}`)
  if (row.payout.note) parts.push(`— ${row.payout.note}`)
  if (Math.round(row.payout.owedSnapshot) !== Math.round(row.payout.amountPaid)) {
    parts.push(`(owed at mark-time: ${fmtExact(row.payout.owedSnapshot)})`)
  }
  return parts.join(' ')
}

onMounted(() => {
  store.loadPayouts()
})
</script>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.admin-section-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-weight: 700; font-size: 0.88rem; margin-bottom: 0.35rem;
}
.section-dot { width: 8px; height: 8px; border-radius: 50%; }
.btn-reload {
  margin-left: auto; padding: 0.3rem 0.8rem; font-size: 0.72rem; font-weight: 600;
  font-family: inherit; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--text-dim); cursor: pointer;
}
.btn-reload:hover { background: var(--bg); color: var(--text); }
.btn-reload:disabled { opacity: 0.5; cursor: not-allowed; }
.ledger-sub {
  font-size: 0.74rem; color: var(--text-dim); line-height: 1.5; margin-bottom: 1rem;
  max-width: 60rem;
}

.inv-blocks { display: flex; flex-direction: column; gap: 0.6rem; }
.inv-block {
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
}
.inv-summary {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  padding: 0.7rem 0.9rem; cursor: pointer; user-select: none; list-style: none;
}
.inv-summary::-webkit-details-marker { display: none; }
.inv-summary::before {
  content: '▸'; color: var(--text-dim); font-size: 0.75rem;
  transition: transform 0.15s;
}
.inv-block[open] > .inv-summary::before { transform: rotate(90deg); }
.inv-name { font-weight: 700; font-size: 0.85rem; }
.inv-user { font-size: 0.72rem; color: var(--text-dim); }
.summary-pills { margin-left: auto; display: flex; gap: 0.4rem; flex-wrap: wrap; }
.pill {
  font-size: 0.68rem; color: var(--text-dim);
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 999px; padding: 0.2rem 0.65rem;
}
.pill strong { font-family: 'JetBrains Mono', monospace; color: var(--text); }
.pill-pending strong { color: #b45309; }
.pill-ok strong { color: var(--accent); }

.ledger-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.8rem; border-top: 1px solid var(--border);
}
.ledger-table th {
  text-align: left; padding: 0.5rem 0.9rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.ledger-table td {
  padding: 0.55rem 0.9rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.ledger-table tbody tr:last-child td { border-bottom: none; }
.ledger-table tbody tr:hover { background: var(--bg); }
.ledger-table .num { text-align: right; }
.ledger-table th.num { text-align: right; }
.ledger-table .act { text-align: right; white-space: nowrap; }
.mono { font-family: 'JetBrains Mono', monospace; }
.has-split { cursor: help; text-decoration: underline dotted var(--text-dim); text-underline-offset: 3px; }
.month-cell { font-weight: 600; white-space: nowrap; }
.current-tag {
  display: inline-block; margin-left: 0.4rem; padding: 0 0.4rem;
  font-size: 0.6rem; font-weight: 700; color: var(--text-dim);
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 999px; vertical-align: middle;
}
.pos { color: var(--accent); font-weight: 600; }
.neg { color: var(--danger); font-weight: 600; }

.badge {
  display: inline-flex; align-items: center;
  padding: 0.18rem 0.55rem; border-radius: 999px;
  font-size: 0.66rem; font-weight: 700; letter-spacing: 0.02em; white-space: nowrap;
}
.badge-paid { background: rgba(16, 185, 129, 0.12); color: #059669; }
.badge-pending { background: rgba(234, 179, 8, 0.14); color: #b45309; }
.badge-progress { background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); }
.paid-meta {
  font-size: 0.62rem; color: var(--text-dim); margin-top: 0.15rem;
  font-family: 'JetBrains Mono', monospace;
}

.btn-mark {
  padding: 0.3rem 0.7rem; font-size: 0.7rem; font-weight: 700; font-family: inherit;
  border: 1px solid rgba(16, 185, 129, 0.4); border-radius: 6px;
  background: rgba(16, 185, 129, 0.1); color: #059669; cursor: pointer;
  transition: all 0.15s;
}
.btn-mark:hover { background: rgba(16, 185, 129, 0.2); }
.btn-undo {
  padding: 0.3rem 0.7rem; font-size: 0.7rem; font-weight: 600; font-family: inherit;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--text-dim); cursor: pointer;
  transition: all 0.15s;
}
.btn-undo:hover { border-color: var(--danger); color: var(--danger); }

.btn-show-all {
  display: block; width: 100%; padding: 0.5rem; font-size: 0.7rem; font-weight: 600;
  font-family: inherit; color: var(--text-dim); background: var(--bg);
  border: none; border-top: 1px solid var(--border); cursor: pointer;
  border-radius: 0 0 8px 8px;
}
.btn-show-all:hover { color: var(--text); }

/* Mark-as-Paid dialog */
.mark-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.3);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.mark-dialog {
  background: var(--surface); border-radius: var(--radius); padding: 1.5rem;
  max-width: 440px; width: 90%; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
}
.mark-dialog h3 { font-size: 1rem; margin-bottom: 0.35rem; }
.mark-sub { font-size: 0.82rem; color: var(--text-dim); margin-bottom: 0.75rem; }
.owed-line { font-size: 0.82rem; margin-bottom: 0.75rem; }
.owed-detail { font-size: 0.72rem; color: var(--text-dim); margin-left: 0.3rem; }
.mark-warn {
  font-size: 0.72rem; line-height: 1.45; color: #b45309;
  background: rgba(234, 179, 8, 0.1); border: 1px solid rgba(234, 179, 8, 0.3);
  border-radius: 6px; padding: 0.5rem 0.65rem; margin-bottom: 0.75rem;
}
.f-label {
  display: block; font-size: 0.68rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.3rem;
}
.amount-wrap { position: relative; margin-bottom: 0.75rem; }
.amount-prefix {
  position: absolute; left: 0.65rem; top: 50%; transform: translateY(-50%);
  font-size: 0.85rem; color: var(--text-dim);
}
.amount-wrap .f-input { padding-left: 1.5rem; }
.f-input {
  width: 100%; padding: 0.5rem 0.65rem; font-size: 0.85rem; font-family: inherit;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text);
}
.f-input:focus { outline: none; border-color: var(--accent); }
textarea.f-input { resize: vertical; margin-bottom: 0.75rem; }
.mark-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem; }
.btn {
  padding: 0.5rem 1rem; font-size: 0.78rem; font-weight: 600; font-family: inherit;
  border: none; border-radius: 6px; cursor: pointer;
}
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.9; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
.btn-secondary:hover { background: var(--bg); }

@media (max-width: 700px) {
  .ledger-table { font-size: 0.72rem; }
  .ledger-table th, .ledger-table td { padding: 0.45rem 0.5rem; }
  .summary-pills { margin-left: 0; width: 100%; }
}
</style>
