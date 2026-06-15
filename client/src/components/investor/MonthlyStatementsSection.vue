<template>
  <div class="section statements-section">
    <div class="section-header">
      <div class="section-title">
        <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#129534;</div>
        Monthly Statements
      </div>
      <div class="header-totals">
        <span class="total-pill" title="Sum of every month's computed payout (your share of net profit)">
          All-time: <strong>{{ fmt(totals.owedAllTime) }}</strong>
        </span>
        <span class="total-pill paid" title="Total recorded as paid out to you">
          Paid: <strong>{{ fmt(totals.paid) }}</strong>
        </span>
        <span class="total-pill" :class="totals.outstanding > 0 ? 'pending' : ''" title="Unpaid payouts for completed (past) months">
          Outstanding: <strong>{{ fmt(totals.outstanding) }}</strong>
        </span>
      </div>
    </div>

    <div v-if="!rows.length" class="empty">No monthly statements yet.</div>

    <div v-else class="stmt-table-wrap">
      <table class="stmt-table">
        <thead>
          <tr>
            <th>Month</th>
            <th class="num">Loads</th>
            <th class="num">Revenue</th>
            <th class="num">Your Payout</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.month">
            <td class="month-cell">
              {{ monthLabel(row.month) }}
              <span v-if="row.isCurrentMonth" class="current-tag">current</span>
            </td>
            <td class="num mono">{{ row.loads }}</td>
            <td class="num mono">{{ fmt(row.revenue) }}</td>
            <td class="num mono" :class="row.owed >= 0 ? 'pos' : 'neg'">{{ fmt(row.owed) }}</td>
            <td>
              <span v-if="row.isCurrentMonth && !row.paid" class="badge badge-progress" title="This month is still accruing — the payout is finalized at month end">In progress</span>
              <span
                v-else-if="row.paid"
                class="badge badge-paid"
                :title="paidTooltip(row)"
              >
                Paid {{ shortDate(row.payout?.paidAt) }}
              </span>
              <span v-else class="badge badge-pending" title="Not yet marked as paid by LogisX">Pending</span>
              <div v-if="row.paid && payoutDiffers(row)" class="paid-amount-note">
                {{ fmt(row.payout.amountPaid) }} paid
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="stmt-footnote">
      "Your Payout" is your share of that month's net profit — the same number shown in the Earnings Summary above.
      A month shows <strong>Paid</strong> once LogisX records the transfer.
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { formatCurrency as fmt } from '../../utils/format'

const props = defineProps({
  payouts: { type: Array, default: () => [] },
})

// Newest month first — investors care about the latest statement.
const rows = computed(() => [...props.payouts].sort((a, b) => b.month.localeCompare(a.month)))

const totals = computed(() => {
  const owedAllTime = props.payouts.reduce((s, m) => s + (m.owed || 0), 0)
  const paid = props.payouts.reduce((s, m) => s + (m.paid && m.payout ? (m.payout.amountPaid || 0) : 0), 0)
  // Outstanding = unpaid completed (non-current) months, summed as-is so a
  // loss month nets against gains — mirrors the server's statements totals.
  const outstanding = props.payouts.reduce(
    (s, m) => s + (!m.paid && !m.isCurrentMonth ? (m.owed || 0) : 0), 0
  )
  return { owedAllTime, paid, outstanding }
})

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

function payoutDiffers(row) {
  return row.payout && Math.round(row.payout.amountPaid) !== Math.round(row.owed)
}

function paidTooltip(row) {
  if (!row.payout) return 'Paid'
  const parts = [`Paid ${fmt(row.payout.amountPaid)}`]
  if (row.payout.paidAt) parts.push(`on ${shortDate(row.payout.paidAt)}`)
  if (row.payout.note) parts.push(`— ${row.payout.note}`)
  return parts.join(' ')
}
</script>

<style scoped>
.statements-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.section-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 1rem; flex-wrap: wrap; gap: 0.75rem;
}
.section-title {
  font-size: 0.95rem; font-weight: 700;
  display: flex; align-items: center; gap: 0.5rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: 0.9rem;
}
.header-totals { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.total-pill {
  font-size: 0.68rem; color: var(--text-dim);
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 999px; padding: 0.25rem 0.7rem;
}
.total-pill strong { font-family: 'JetBrains Mono', monospace; color: var(--text); }
.total-pill.paid strong { color: var(--accent); }
.total-pill.pending strong { color: #b45309; }

.stmt-table-wrap { overflow-x: auto; }
.stmt-table {
  width: 100%; border-collapse: separate; border-spacing: 0; font-size: 0.8rem;
}
.stmt-table th {
  text-align: left; padding: 0.5rem 0.6rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.stmt-table td {
  padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.stmt-table tbody tr:last-child td { border-bottom: none; }
.stmt-table tbody tr:hover { background: var(--bg); }
.stmt-table .num { text-align: right; }
.stmt-table th.num { text-align: right; }
.mono { font-family: 'JetBrains Mono', monospace; }
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
  font-size: 0.66rem; font-weight: 700; letter-spacing: 0.02em;
  white-space: nowrap;
}
.badge-paid { background: rgba(16, 185, 129, 0.12); color: #059669; }
.badge-pending { background: rgba(234, 179, 8, 0.14); color: #b45309; }
.badge-progress { background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); }
.paid-amount-note {
  font-size: 0.62rem; color: var(--text-dim); margin-top: 0.15rem;
  font-family: 'JetBrains Mono', monospace;
}

.stmt-footnote {
  margin-top: 0.75rem; font-size: 0.68rem; color: var(--text-dim);
  line-height: 1.45;
}
.empty { text-align: center; color: var(--text-dim); padding: 1.5rem; font-size: 0.85rem; }

@media (max-width: 600px) {
  .stmt-table { font-size: 0.74rem; }
  .stmt-table th, .stmt-table td { padding: 0.45rem 0.4rem; }
  .header-totals { width: 100%; }
}
</style>
