<template>
  <div class="table-scroll">
    <table class="data-table mileage-table">
      <thead>
        <tr>
          <th class="sticky-col">
            <button class="th-btn" :aria-label="`Sort by ${label}`" @click="sortBy('name')">
              {{ label }}<span class="sort-arrow">{{ arrow('name') }}</span>
            </button>
          </th>
          <th
            v-for="p in periods" :key="p.key"
            class="num" :class="{ 'col-on': selectedPeriod === p.key }"
            :aria-sort="ariaSort(p.key)"
          >
            <button class="th-btn" :aria-label="`Sort by ${p.label}`" @click="sortBy(p.key)">
              {{ p.label }}<span class="sort-arrow">{{ arrow(p.key) }}</span>
            </button>
          </th>
          <th class="num total-col" :aria-sort="ariaSort('total')">
            <button class="th-btn" aria-label="Sort by total" @click="sortBy('total')">
              Total<span class="sort-arrow">{{ arrow('total') }}</span>
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in sorted" :key="r.id">
          <td class="sticky-col">
            <div class="row-name">{{ r.name }}</div>
            <div v-if="r.sub" class="row-sub">{{ r.sub }}</div>
          </td>
          <td
            v-for="p in periods" :key="p.key"
            class="num"
            :class="{ muted: cellMiles(r, p) == null, 'cell-click': canDrill(r, p), 'col-on': selectedPeriod === p.key }"
            :role="canDrill(r, p) ? 'button' : undefined"
            :tabindex="canDrill(r, p) ? 0 : undefined"
            :title="canDrill(r, p) ? `See the days behind ${r.name}, ${p.label}` : undefined"
            @click="canDrill(r, p) && $emit('drill', { row: r, period: p })"
            @keyup.enter="canDrill(r, p) && $emit('drill', { row: r, period: p })"
            @keyup.space.prevent="canDrill(r, p) && $emit('drill', { row: r, period: p })"
          >
            {{ fmtMi(cellMiles(r, p)) }}<span
              v-if="cellPartial(r, p)" class="cell-flag"
              title="Part of this period was not observed — the real figure is higher."
            >*</span>
          </td>
          <td
            class="num total-col"
            :class="{ 'cell-click': canDrillTotal(r) }"
            :role="canDrillTotal(r) ? 'button' : undefined"
            :tabindex="canDrillTotal(r) ? 0 : undefined"
            :title="canDrillTotal(r) ? `See every day for ${r.name}` : undefined"
            @click="canDrillTotal(r) && $emit('drill', { row: r, period: null })"
            @keyup.enter="canDrillTotal(r) && $emit('drill', { row: r, period: null })"
            @keyup.space.prevent="canDrillTotal(r) && $emit('drill', { row: r, period: null })"
          >
            {{ fmtMi(r.total && r.total.miles) }}
            <span class="basis-badge" :class="'b-' + basisOf(r).cls" :title="basisOf(r).title">{{ basisOf(r).label }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
// ⚠️ THIS IS A REAL SFC, NOT A FUNCTIONAL COMPONENT BUILT WITH h(). Vue's scoped
// CSS works by stamping a data attribute onto elements the TEMPLATE COMPILER
// emits; vnodes created by h() inside <script setup> never receive it, so every
// scoped rule silently does nothing — numbers render left-aligned, columns lose
// their widths and the header row runs together. That has now been introduced
// and fixed twice on this page. Keep the markup in a template.
//
// Header buttons + aria-sort follow VendorLeaderboardTable rather than
// FinancialsView, whose <th>-carries-the-click version is not keyboard-reachable.
import { ref, computed } from 'vue'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  periods: { type: Array, default: () => [] },
  label: { type: String, default: '' },
  selectedPeriod: { type: String, default: '' },
})
defineEmits(['drill'])

const sortKey = ref('total')
const sortDir = ref('desc')

function sortBy(key) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  // A name sorts A→Z first; a quantity sorts biggest-first. Defaulting both the
  // same way makes one of them useless on the first click.
  else { sortKey.value = key; sortDir.value = key === 'name' ? 'asc' : 'desc' }
}
function arrow(key) { return sortKey.value === key ? (sortDir.value === 'asc' ? ' ▲' : ' ▼') : '' }
function ariaSort(key) {
  if (sortKey.value !== key) return 'none'
  return sortDir.value === 'asc' ? 'ascending' : 'descending'
}

function valueFor(row, key) {
  if (key === 'name') return String(row.name || '').toLowerCase()
  if (key === 'total') return row.total ? row.total.miles : null
  const c = row.series.get(key)
  return c ? c.miles : null
}

const sorted = computed(() => {
  const rows = [...props.rows]
  const key = sortKey.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  return rows.sort((a, b) => {
    const av = valueFor(a, key)
    const bv = valueFor(b, key)
    if (key === 'name') return String(av).localeCompare(String(bv)) * dir
    // ⚠️ null sorts LAST in both directions. It means "we could not measure
    // this", not "zero" — letting it fall to the bottom of an ascending sort
    // would rank an unmeasured truck as the worst performer.
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    // (av - bv) is ASCENDING; dir flips it. Writing (bv - av) here — already
    // descending — and then multiplying by dir inverts the meaning, so the
    // arrow says one thing and the rows do the other.
    return (av - bv) * dir
  })
})

function cellMiles(row, p) {
  const c = row.series.get(p.key)
  return c ? c.miles : null
}
function cellPartial(row, p) {
  const c = row.series.get(p.key)
  return !!c && c.basis === 'partial'
}
// A dash leads nowhere — offering a click on it wastes the click and implies
// there is something to see.
function canDrill(row, p) {
  return cellMiles(row, p) != null && !!(row.vehicleId || row.driverKey)
}
function canDrillTotal(row) {
  return row.total && row.total.miles != null && !!(row.vehicleId || row.driverKey)
}

const BASIS = {
  eld: { label: 'ELD', cls: 'ok', title: 'Every day in this period was fully observed by the ELD.' },
  partial: { label: 'partly', cls: 'warn', title: 'Some of this period was not observed — the ELD was dark, or a reading was rejected. The real figure is higher.' },
  'no-data': { label: 'no data', cls: 'none', title: 'No ELD coverage at all for this period. This is not zero miles — it is an unknown.' },
}
function basisOf(row) { return BASIS[row.total && row.total.basis] || BASIS['no-data'] }
function fmtMi(v) { return v == null ? '—' : Number(v).toLocaleString('en-US') }
</script>

<style scoped>
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.data-table { width: 100%; border-collapse: collapse; }
.mileage-table { font-size: 0.86rem; }
.mileage-table th, .mileage-table td { padding: 0.45rem 0.85rem; white-space: nowrap; }
.mileage-table thead th.num, .mileage-table td.num { min-width: 96px; }
.mileage-table .sticky-col { min-width: 150px; }
.mileage-table thead th {
  font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em;
  color: var(--text-dim, #6b7085); border-bottom: 1px solid var(--border, #d8dbe3);
  padding: 0; user-select: none;
}
.th-btn {
  width: 100%; border: 0; background: none; cursor: pointer;
  font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit;
  padding: 0.45rem 0.85rem; text-align: inherit;
}
.mileage-table thead th.num .th-btn { text-align: right; }
.th-btn:hover { color: var(--text, #1f2937); }
.th-btn:focus-visible { outline: 2px solid var(--accent, #2563eb); outline-offset: -2px; }
.sort-arrow { font-size: 0.62rem; }

.mileage-table tbody tr { border-bottom: 1px solid var(--border-soft, #eef0f4); }
.mileage-table tbody tr:hover { background: rgba(148, 163, 184, 0.06); }
.mileage-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.mileage-table .num.muted { color: var(--text-dim, #9aa0ae); }
.mileage-table .total-col { font-weight: 700; }
.sticky-col { position: sticky; left: 0; background: var(--surface, #fff); text-align: left; z-index: 1; }
.row-name { font-weight: 600; }
.row-sub { font-size: 0.72rem; color: var(--text-dim, #6b7085); }
.cell-flag { color: #b45309; margin-left: 0.15rem; font-weight: 700; }

.cell-click { cursor: pointer; }
.cell-click:hover { background: rgba(37, 99, 235, 0.09); }
.cell-click:focus-visible { outline: 2px solid var(--accent, #2563eb); outline-offset: -2px; }
.col-on { background: rgba(37, 99, 235, 0.06); }

.basis-badge { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 999px; font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
.b-ok { background: #dcfce7; color: #166534; }
.b-warn { background: #fef3c7; color: #92400e; }
.b-none { background: #e5e7eb; color: #4b5563; }

@media (max-width: 768px) {
  .mileage-table { font-size: 0.78rem; }
  .mileage-table th, .mileage-table td { padding: 0.35rem 0.5rem; }
  .th-btn { padding: 0.35rem 0.5rem; }
}
</style>
