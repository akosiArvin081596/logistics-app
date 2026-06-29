<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: #fee2e2; color: #b91c1c;">&#128221;</div>
      Expenses
      <span class="section-sub">scoped to your truck{{ trucks.length === 1 ? '' : 's' }}</span>
    </div>

    <div class="filter-row">
      <select v-model="filter.truck" class="filter-select" @change="loadExpenses">
        <option value="">All My Trucks</option>
        <option v-for="t in truckUnits" :key="t" :value="t">#{{ t }}</option>
      </select>
      <select v-model="filter.type" class="filter-select" @change="loadExpenses">
        <option value="">All Types</option>
        <option v-for="t in expenseTypes" :key="t" :value="t">{{ t }}</option>
      </select>
      <select v-model="filter.status" class="filter-select" @change="loadExpenses">
        <option value="">All Status</option>
        <option>Pending</option>
        <option>Approved</option>
        <option>Rejected</option>
      </select>
      <input v-model="filter.from" type="date" class="filter-date" :max="filter.to || todayIso" @change="loadExpenses" />
      <input v-model="filter.to" type="date" class="filter-date" :min="filter.from" :max="todayIso" @change="loadExpenses" />
      <span class="filter-count">{{ expenses.length }} {{ expenses.length === 1 ? 'expense' : 'expenses' }}</span>
    </div>

    <div v-if="loading" class="skeleton skeleton-card"></div>
    <div v-else-if="expenses.length === 0" class="empty-msg">No expenses found for the selected filters.</div>
    <template v-else>
    <table class="data-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Driver</th>
          <th>Truck</th>
          <th>City / State</th>
          <th>Type</th>
          <th>Description</th>
          <th>Amount</th>
          <th>Receipt</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in expenses" :key="e.id">
          <td class="mono-sm">{{ fmtDate(e.date) }}</td>
          <td>{{ e.driver }}</td>
          <td class="mono-sm">{{ e.truck_unit ? '#' + e.truck_unit : '—' }}</td>
          <td class="mono-sm">{{ fmtLocation(e) }}</td>
          <td><span :class="['type-pill', 'type-' + (e.type || 'other').toLowerCase()]">{{ e.type || 'Other' }}</span></td>
          <td class="desc-cell">{{ e.description || '—' }}</td>
          <td class="mono-sm">${{ Number(e.amount).toLocaleString('en-US', { minimumFractionDigits: 2 }) }}</td>
          <td>
            <a v-if="isPdfReceipt(e.photo_data)" class="receipt-pdf-chip" :href="e.photo_data" target="_blank" rel="noopener">PDF</a>
            <img v-else-if="e.photo_data" :src="e.photo_data" class="receipt-thumb" @click="previewImg = e.photo_data" />
            <span v-else class="dim">—</span>
          </td>
          <td>
            <span :class="['status-pill', 'st-' + (e.status || 'Pending').toLowerCase()]">{{ e.status || 'Pending' }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <div
      class="totals-footer clickable"
      role="button" tabindex="0"
      title="Click for an explanation of this total"
      @click="openDetail('expensesTotal')"
      @keyup.enter="openDetail('expensesTotal')"
      @keyup.space.prevent="openDetail('expensesTotal')"
    >
      <div class="totals-row">
        <span class="totals-label">Total of displayed rows <span class="info-marker" aria-hidden="true">i</span></span>
        <span class="totals-value">${{ displayedTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}</span>
      </div>
      <div class="totals-disclaimer">
        Raw expense entries against your trucks. The Cash Flow total above reflects bottom-line P&amp;L (completed-load expenses + maintenance + compliance) and may differ.
      </div>
    </div>
    </template>

    <ZoomableImage :src="previewImg" alt="Receipt" @close="previewImg = null" />

    <!-- Detail modal -->
    <MetricInfoDialog
      :open="!!detailType"
      :title="modalTitle"
      :subtitle="modalSubtitle"
      @update:open="v => { if (!v) detailType = '' }"
    >
      <template v-if="detailType === 'expensesTotal'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            "Total of displayed rows" is the simple sum of the <strong>amount</strong> column for every expense currently visible in the table.
          </div>
          <div class="step-label">What's Included</div>
          <div class="modal-explain-sm">
            Only the expenses your active filters allow through &mdash; if you've narrowed by truck, type, status, or date range, the total reflects that subset. Clear the filters to see the unfiltered all-time total.
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Displayed Total ({{ expenses.length }} {{ expenses.length === 1 ? 'expense' : 'expenses' }})</span>
            <span class="val danger">${{ displayedTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}</span>
          </div>
          <div class="modal-callout warning">
            This figure will <strong>not</strong> match the "Total Expenses" on Cash Flow above. That number is bottom-line P&amp;L &mdash; only expenses tied to completed loads, plus maintenance and compliance fees. This footer shows every expense entry, regardless of whether the load completed.
          </div>
        </div>
      </template>
    </MetricInfoDialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useApi } from '../../composables/useApi'
import MetricInfoDialog from './MetricInfoDialog.vue'
import ZoomableImage from '../shared/ZoomableImage.vue'

const props = defineProps({
  trucks: { type: Array, default: () => [] },
  // Super Admin previewing an investor's portal — appended to the expenses
  // fetch so the backend scopes to that investor's trucks.
  previewUserId: { type: Number, default: null },
})

const api = useApi()
const expenses = ref([])
const loading = ref(true)
const previewImg = ref(null)

const expenseTypes = ['Fuel', 'Repair', 'Maintenance', 'Wear & Tear', 'Toll', 'Food', 'Other']
const todayIso = computed(() => new Date().toISOString().slice(0, 10))
const filter = reactive({ truck: '', type: '', status: '', from: '', to: '' })

const truckUnits = computed(() => {
  const units = (props.trucks || [])
    .map(t => t.unit_number || t.UnitNumber || t.unit)
    .filter(Boolean)
  return [...new Set(units)].sort()
})

// Sum of currently displayed rows. Surfaced as a footer so investors can
// see what this list adds up to. NOTE: this will NOT match the Cash Flow
// section's totalExpenses above — that figure is bottom-line P&L and
// scopes to expenses on completed loads + maintenance + compliance fees.
// The disclaimer below the footer calls this out.
const displayedTotal = computed(() =>
  expenses.value.reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
)

async function loadExpenses() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (filter.truck) params.set('truck', filter.truck)
    if (filter.type) params.set('type', filter.type)
    if (filter.status) params.set('status', filter.status)
    if (filter.from) params.set('from', filter.from)
    if (filter.to) params.set('to', filter.to)
    if (props.previewUserId) params.set('as_user_id', String(props.previewUserId))
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await api.get(`/api/investor/expenses${qs}`)
    expenses.value = data.expenses || []
  } catch (err) {
    console.error('Failed to load investor expenses:', err)
    expenses.value = []
  }
  loading.value = false
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// City/State display: both -> "City, ST"; one -> that one; neither -> em-dash.
// Read defensively — location_city/location_state may be absent until the
// backend lane lands.
function fmtLocation(e) {
  const city = (e?.location_city || '').trim()
  const state = (e?.location_state || '').trim()
  if (city && state) return `${city}, ${state}`
  return city || state || '—'
}

// PDF receipts (admin/dispatcher uploads) render as a link chip instead of a
// broken <img>. Mirrors ExpensesTab.vue's helper.
function isPdfReceipt(p) {
  return typeof p === 'string' && (/\.pdf$/i.test(p) || p.startsWith('data:application/pdf'))
}

// --- Detail modal ---
const detailType = ref('')
function openDetail(type) { detailType.value = type }

const MODAL_CONFIG = {
  expensesTotal: { title: 'Total of Displayed Rows', subtitle: 'How this footer total is computed' },
}

const modalTitle = computed(() => MODAL_CONFIG[detailType.value]?.title || '')
const modalSubtitle = computed(() => MODAL_CONFIG[detailType.value]?.subtitle || '')

onMounted(loadExpenses)
</script>

<style scoped>
.section {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
  margin-bottom: 1.25rem;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1rem;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 1rem;
}
.section-icon {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 7px; font-size: 0.95rem; font-weight: 700;
}
.section-sub {
  font-size: 0.75rem;
  font-weight: 500;
  color: #64748b;
  margin-left: auto;
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.85rem;
}
.filter-select, .filter-date {
  padding: 0.45rem 0.65rem;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 0.8rem;
  font-family: inherit;
  background: #fff;
  color: #0f172a;
}
.filter-count {
  margin-left: auto;
  font-size: 0.72rem;
  font-weight: 600;
  color: #64748b;
  font-family: 'JetBrains Mono', monospace;
}

.empty-msg {
  padding: 1.5rem;
  text-align: center;
  color: #94a3b8;
  font-size: 0.85rem;
  background: #f8fafc;
  border-radius: 8px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
.data-table thead {
  background: #f8fafc;
}
.data-table th {
  text-align: left;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid #e2e8f0;
}
.data-table td {
  padding: 0.65rem 0.75rem;
  border-bottom: 1px solid #f1f5f9;
  color: #0f172a;
  vertical-align: middle;
}
.mono-sm { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; }
.desc-cell { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim { color: #cbd5e1; }

.type-pill, .status-pill {
  display: inline-block;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.2rem 0.55rem;
  border-radius: 10px;
  white-space: nowrap;
}
.type-pill.type-fuel { background: #dbeafe; color: #1e40af; }
.type-pill.type-repair, .type-pill.type-maintenance, .type-pill.type-wear { background: #fed7aa; color: #9a3412; }
.type-pill.type-toll { background: #ddd6fe; color: #5b21b6; }
.type-pill.type-food { background: #dcfce7; color: #166534; }
.type-pill.type-other { background: #e2e8f0; color: #475569; }
.status-pill.st-pending { background: #fef3c7; color: #92400e; }
.status-pill.st-approved { background: #dcfce7; color: #166534; }
.status-pill.st-rejected { background: #fee2e2; color: #b91c1c; }

.receipt-thumb {
  width: 40px; height: 40px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
  cursor: zoom-in;
  display: block;
}

.receipt-pdf-chip {
  display: inline-flex; align-items: center;
  padding: 0.25rem 0.55rem; border-radius: 6px;
  background: #fee2e2; color: #b91c1c;
  font-size: 0.66rem; font-weight: 700; letter-spacing: 0.04em;
  text-decoration: none; border: 1px solid transparent;
  transition: border-color 0.15s;
}
.receipt-pdf-chip:hover { border-color: #b91c1c; }

.totals-footer {
  margin-top: 0.85rem;
  padding: 0.85rem 1rem;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}
.totals-footer.clickable {
  cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease;
}
.totals-footer.clickable:hover { background: #f1f5f9; border-color: #cbd5e1; }
.totals-footer.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.info-marker {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--accent-dim); color: var(--accent);
  font-size: 0.6rem; font-weight: 800; font-style: normal;
  margin-left: 0.25rem; text-transform: lowercase;
}
.totals-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 0.35rem;
}
.totals-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #64748b;
}
.totals-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.05rem;
  font-weight: 700;
  color: #0f172a;
}
.totals-disclaimer {
  font-size: 0.72rem;
  color: #94a3b8;
  line-height: 1.5;
  font-style: italic;
}

.skeleton {
  background: linear-gradient(90deg, #f1f5f9, #e2e8f0, #f1f5f9);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 8px;
}
.skeleton-card { height: 160px; }
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@media (max-width: 768px) {
  .data-table { font-size: 0.78rem; }
  .data-table th, .data-table td { padding: 0.45rem 0.5rem; }
  .desc-cell { max-width: 140px; }
}
</style>
