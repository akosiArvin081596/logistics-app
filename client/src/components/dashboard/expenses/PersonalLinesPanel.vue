<template>
  <!-- The Personal tab (Super Admin): each driver's Personal lines and their
       total, read only. Every amount, total and state is the server's
       (GET /api/expenses/personal/lines); the tag and the sentence are the ones
       the receipts show (lib/personalReceipt.js). -->
  <div ref="rootEl" class="personal-lines">
    <div class="pl-filters">
      <select v-model="filter.driver" class="pl-input" aria-label="Driver" @change="load()">
        <option value="">All drivers</option>
        <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
      </select>
      <input v-model="filter.from" type="date" class="pl-input" :max="filter.to || undefined" aria-label="From date" @change="load()" />
      <input v-model="filter.to" type="date" class="pl-input" :min="filter.from || undefined" aria-label="To date" @change="load()" />
      <button v-if="filter.driver || filter.from || filter.to" type="button" class="pl-clear" @click="clearFilters">Clear filters</button>
    </div>

    <div v-if="totals" class="pl-total" role="status" aria-live="polite">
      <div class="pl-total-scope">{{ scopeText }}</div>
      <div class="pl-total-main">
        <span class="pl-total-label">Total</span>
        <strong class="pl-total-amount">{{ totals.text }}</strong>
        <span class="pl-total-count">{{ totals.lines }} {{ totals.lines === 1 ? 'line' : 'lines' }}</span>
      </div>
      <div v-if="totals.reversed_lines" class="pl-total-reversed">
        Reversed, not counted: {{ totals.reversed_text }} ({{ totals.reversed_lines }} {{ totals.reversed_lines === 1 ? 'line' : 'lines' }})
      </div>
    </div>

    <div v-if="error" class="pl-error" role="alert">{{ error }}</div>
    <div v-else-if="!loaded" class="pl-skeleton"></div>
    <template v-else>
      <div v-if="!lines.length" class="pl-empty">No Personal lines for these filters.</div>
      <!-- A phone, or a panel too narrow for the five columns: one card per line,
           with the full sentence. -->
      <div v-else-if="showCards" class="pl-cards">
        <div v-for="l in paginatedItems" :key="l.line_id" class="pl-card">
          <div class="pl-card-top">
            <div class="pl-card-left">
              <div class="pl-card-date">{{ fmtYmd(l.receipt_date) }}</div>
              <div class="pl-card-driver">{{ l.driver || '—' }}</div>
              <div v-if="l.merchant" class="pl-card-vendor">{{ l.merchant }}</div>
            </div>
            <div class="pl-card-amount">{{ l.personal.amount_text }}</div>
          </div>
          <div class="pl-card-state pl-pill" :class="`pl-${l.personal.state}`">{{ personalPillText(l.personal) }}</div>
        </div>
      </div>
      <!-- Wide: the table, the short tag with its full sentence on hover. -->
      <table v-else class="pl-table">
        <colgroup>
          <col class="col-date" />
          <col class="col-driver" />
          <col />
          <col class="col-amount" />
          <col class="col-state" />
        </colgroup>
        <thead>
          <tr>
            <th>Receipt date</th>
            <th>Driver</th>
            <th>Vendor</th>
            <th>Personal amount</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in paginatedItems" :key="l.line_id" class="pl-row">
            <td class="pl-mono">{{ fmtYmd(l.receipt_date) }}</td>
            <td>{{ l.driver || '—' }}</td>
            <td class="pl-vendor" :title="l.merchant || ''">{{ l.merchant || '—' }}</td>
            <td class="pl-mono">{{ l.personal.amount_text }}</td>
            <td><span class="pl-pill" :class="`pl-${l.personal.state}`" :title="personalPillText(l.personal)">{{ personalShortText(l.personal) }}</span></td>
          </tr>
        </tbody>
      </table>
      <PaginationBar :page="page" :page-size="pageSize" :total="lines.length" :total-pages="totalPages" @go="goTo" @size="setSize" />
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useApi } from '../../../composables/useApi'
import { useViewport } from '../../../composables/useViewport'
import { useElementWidth } from '../../../composables/useElementWidth'
import { useSocketRefresh } from '../../../composables/useSocketRefresh'
import { usePagination } from '../../../composables/usePagination'
import PaginationBar from '../../shared/PaginationBar.vue'
import { personalLinesQuery, personalPillText, personalShortText } from '../../../lib/personalReceipt'
import { fmtYmd } from '../../../utils/datetime'

const props = defineProps({
  // Whether its tab is the one shown: a change elsewhere re-reads it only then.
  active: { type: Boolean, default: false },
})

const api = useApi()
const { isMobile } = useViewport()
// Below this panel width the five columns are too thin to read, so cards show.
const CARDS_BELOW = 640
const rootEl = ref(null)
const { width } = useElementWidth(rootEl)
const showCards = computed(() => isMobile.value || (width.value > 0 && width.value < CARDS_BELOW))

const filter = reactive({ driver: '', from: '', to: '' })
// The filters the list on screen answers, for the line above the total.
const shown = ref({ driver: '', from: '', to: '' })
const drivers = ref([])
const lines = ref([])
const totals = ref(null)
const loaded = ref(false)
const error = ref('')
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(lines, 25)
watch(totalPages, (tp) => { if (page.value > tp) goTo(tp) })

const scopeText = computed(() => {
  const s = shown.value
  const dates = s.from && s.to ? `${fmtYmd(s.from)} to ${fmtYmd(s.to)}`
    : s.from ? `from ${fmtYmd(s.from)}`
      : s.to ? `to ${fmtYmd(s.to)}` : 'all dates'
  return `${s.driver || 'All drivers'} · ${dates}`
})

// The newest request wins: an answer to filters already changed is dropped.
let seq = 0
async function load({ quiet = false } = {}) {
  const mine = ++seq
  const asked = { ...filter }
  try {
    const data = await api.get(`/api/expenses/personal/lines${personalLinesQuery(filter)}`)
    if (mine !== seq) return
    lines.value = Array.isArray(data.lines) ? data.lines : []
    totals.value = data.totals || null
    drivers.value = Array.isArray(data.drivers) ? data.drivers : []
    shown.value = asked
    error.value = ''
    if (!quiet) goTo(1)
  } catch (err) {
    if (mine !== seq) return
    // No total is left on screen for filters it does not answer.
    lines.value = []
    totals.value = null
    error.value = (err && err.message) || 'The Personal lines could not be loaded.'
  } finally {
    if (mine === seq) loaded.value = true
  }
}

function clearFilters() {
  filter.driver = ''
  filter.from = ''
  filter.to = ''
  load()
}

function refreshIfOpen() {
  if (props.active) load({ quiet: true })
}
useSocketRefresh('expenses:changed', refreshIfOpen)
useSocketRefresh('invoices:changed', refreshIfOpen)
// Back on the tab: what changed while it was hidden.
watch(() => props.active, (open) => { if (open) load({ quiet: true }) })
onMounted(() => load())
</script>

<style scoped>
.personal-lines { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
.pl-filters { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.pl-input {
  min-width: 0;
  max-width: 100%;
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.78rem;
  background: var(--bg);
  color: var(--text);
}
.pl-clear {
  padding: 0.3rem 0.6rem;
  font-size: 0.72rem;
  font-weight: 600;
  font-family: inherit;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-dim);
  cursor: pointer;
}
.pl-clear:hover { color: var(--text); }
.pl-total {
  padding: 0.7rem 0.9rem;
  border: 1px solid #fcd34d;
  border-radius: 8px;
  background: #fffbeb;
  color: #78350f;
}
.pl-total-scope { font-size: 0.75rem; overflow-wrap: anywhere; }
.pl-total-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; margin-top: 0.15rem; }
.pl-total-label { font-size: 0.8rem; font-weight: 600; }
.pl-total-amount { font-family: 'JetBrains Mono', monospace; font-size: 1.15rem; color: #92400e; }
.pl-total-count { font-size: 0.75rem; }
.pl-total-reversed { margin-top: 0.2rem; font-size: 0.75rem; color: #374151; }
.pl-error { padding: 0.75rem 0.9rem; border: 1px solid #fca5a5; border-radius: 8px; background: #fef2f2; color: #991b1b; font-size: 0.8rem; }
.pl-empty { text-align: center; color: var(--text-dim); font-size: 0.85rem; padding: 2rem 1rem; }
.pl-skeleton { height: 120px; border-radius: var(--radius); background: var(--bg); }

.pl-table { table-layout: fixed; width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.pl-table th {
  text-align: left;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  padding: 0.5rem;
  border-bottom: 1px solid var(--border);
}
.pl-table td { padding: 0.55rem 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; overflow: hidden; overflow-wrap: break-word; }
.pl-table col.col-date { width: 7.5rem; }
.pl-table col.col-driver { width: 9rem; }
.pl-table col.col-amount { width: 8rem; }
.pl-table col.col-state { width: 15rem; }
.pl-mono { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; }
.pl-vendor { white-space: nowrap; text-overflow: ellipsis; }

.pl-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
  gap: 0.65rem;
}
.pl-card {
  min-width: 0;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.85rem 0.95rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.pl-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; }
.pl-card-left { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; flex: 1; }
.pl-card-date { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: #64748b; }
.pl-card-driver { font-size: 0.92rem; font-weight: 600; color: #0f172a; overflow-wrap: anywhere; }
.pl-card-vendor { font-size: 0.78rem; font-weight: 600; color: #475569; overflow-wrap: anywhere; }
.pl-card-amount { font-family: 'JetBrains Mono', monospace; font-size: 0.95rem; font-weight: 700; color: #0f172a; flex-shrink: 0; }

/* The receipts' Personal pill (PersonalReceiptActions.vue), in the same colors. */
.pl-pill {
  display: inline-block;
  max-width: 100%;
  padding: 0.1rem 0.5rem;
  border-radius: 0.6rem;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.35;
  white-space: normal;
  overflow-wrap: break-word;
  background: #fef3c7;
  color: #92400e;
}
.pl-pill.pl-needs_correction { background: #fee2e2; color: #991b1b; }
.pl-pill.pl-carried { background: #e0e7ff; color: #3730a3; }
.pl-pill.pl-reversed { background: #e5e7eb; color: #374151; }
.pl-card-state { align-self: flex-start; }
</style>
