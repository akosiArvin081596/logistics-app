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
          <td><span :class="['type-pill', 'type-' + (e.type || 'other').toLowerCase()]">{{ e.type || 'Other' }}</span></td>
          <td class="desc-cell">{{ e.description || '—' }}</td>
          <td class="mono-sm">${{ Number(e.amount).toLocaleString('en-US', { minimumFractionDigits: 2 }) }}</td>
          <td>
            <img v-if="e.photo_data" :src="e.photo_data" class="receipt-thumb" @click="previewImg = e.photo_data" />
            <span v-else class="dim">—</span>
          </td>
          <td>
            <span :class="['status-pill', 'st-' + (e.status || 'Pending').toLowerCase()]">{{ e.status || 'Pending' }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <div class="totals-footer">
      <div class="totals-row">
        <span class="totals-label">Total of displayed rows</span>
        <span class="totals-value">${{ displayedTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}</span>
      </div>
      <div class="totals-disclaimer">
        Raw expense entries against your trucks. The Cash Flow total above reflects bottom-line P&amp;L (completed-load expenses + maintenance + compliance) and may differ.
      </div>
    </div>
    </template>

    <Teleport to="body">
      <div v-if="previewImg" class="preview-overlay" @click="previewImg = null">
        <img :src="previewImg" class="preview-img" />
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useApi } from '../../composables/useApi'

const props = defineProps({
  trucks: { type: Array, default: () => [] },
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

.totals-footer {
  margin-top: 0.85rem;
  padding: 0.85rem 1rem;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
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

.preview-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center;
  z-index: 300; cursor: pointer;
}
.preview-img {
  max-width: 90vw; max-height: 90vh;
  border-radius: 8px;
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
