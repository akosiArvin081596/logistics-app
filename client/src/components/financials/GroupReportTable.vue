<template>
  <div>
    <p class="table-head-note">{{ headNote }}</p>

    <div class="table-scroll" role="region" :aria-label="`Financials ${title}`" tabindex="0">
      <table class="data-table group-table">
        <thead>
          <tr>
            <th scope="col" class="sticky-col" :aria-sort="ariaSort('label')">
              <button type="button" class="sort-btn" @click="sortBy('label')">{{ labelHeading }}<span aria-hidden="true">{{ sortIcon('label') }}</span></button>
            </th>
            <th v-for="c in GROUP_COLUMNS" :key="c.key" scope="col" class="num" :aria-sort="ariaSort(c.key)">
              <button type="button" class="sort-btn" @click="sortBy(c.key)">{{ c.label }}<span aria-hidden="true">{{ sortIcon(c.key) }}</span></button>
            </th>
          </tr>
        </thead>

        <tbody v-if="!rows.visible.length && !rows.other.length">
          <tr><td :colspan="GROUP_COLUMNS.length + 1" class="empty-cell">Nothing recorded in this range.</td></tr>
        </tbody>

        <tbody v-for="g in rows.visible" :key="g.key" class="group-body">
          <GroupRow :group="g" :expanded="expanded.has(g.key)" :periods="periods" @toggle="toggle(g.key)" />
        </tbody>

        <tbody v-if="rows.other.length" class="other-head">
          <tr>
            <th scope="rowgroup" class="sticky-col section-label">Shared and unallocated</th>
            <td :colspan="GROUP_COLUMNS.length"></td>
          </tr>
        </tbody>
        <tbody v-for="g in rows.other" :key="g.key" class="group-body">
          <GroupRow :group="g" :expanded="expanded.has(g.key)" :periods="periods" muted @toggle="toggle(g.key)" />
        </tbody>

        <tfoot>
          <tr class="total-row">
            <th scope="row" class="sticky-col">Total</th>
            <td v-for="c in GROUP_COLUMNS" :key="c.key" class="num" :class="c.signed ? signClass(total[c.key]) : ''">
              {{ formatColumn(total, c) }}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div v-if="rows.hidden > 0" class="show-all">
      <button type="button" class="btn btn-secondary btn-sm" @click="showAll = true">
        Show all {{ formatCount(rows.namedCount) }} {{ noun }}
      </button>
    </div>
    <div v-else-if="showAll && rows.namedCount > GROUP_ROW_LIMIT" class="show-all">
      <button type="button" class="btn btn-secondary btn-sm" @click="showAll = false">
        Show the first {{ GROUP_ROW_LIMIT }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import GroupRow from './GroupReportRow.vue'
import {
  GROUP_COLUMNS, GROUP_ROW_LIMIT, GROUPINGS,
  formatColumn, formatCount, groupRows, signClass,
} from '../../lib/financialsView'

// One row per group (truck, driver, load, state or owner) with its totals; a
// row opens to its figures by period. Every figure is the server's
// (report.groups[].total / .byPeriod, report.total); sorting only compares.
const props = defineProps({
  report: { type: Object, required: true },
})

const grouping = computed(() => GROUPINGS.find((g) => g.key === props.report.groupBy) || GROUPINGS[0])
const noun = computed(() => grouping.value.noun)
const title = computed(() => grouping.value.title.toLowerCase())
const labelHeading = computed(() => ({
  truck: 'Truck', driver: 'Driver', load: 'Load', pickupState: 'Pickup state', deliveryState: 'Delivery state', owner: 'Owner',
}[props.report.groupBy] || 'Group'))
const periods = computed(() => props.report.periods || [])
const total = computed(() => props.report.total || {})

const sortKey = ref('revenue')
const sortDir = ref('desc')
const showAll = ref(false)
const expanded = ref(new Set())

// A new grouping starts fresh; a refresh of the same one keeps what is open.
watch(() => props.report.groupBy, () => {
  sortKey.value = 'revenue'
  sortDir.value = 'desc'
  showAll.value = false
  expanded.value = new Set()
})

const rows = computed(() => groupRows(props.report.groups, {
  sortKey: sortKey.value,
  sortDir: sortDir.value,
  showAll: showAll.value,
}))

const sortLabel = computed(() => (sortKey.value === 'label'
  ? labelHeading.value
  : (GROUP_COLUMNS.find((c) => c.key === sortKey.value)?.label || '')))

const headNote = computed(() => {
  const r = rows.value
  const shown = r.hidden > 0
    ? `Showing ${formatCount(r.visible.length)} of ${formatCount(r.namedCount)} ${noun.value}`
    : `${formatCount(r.namedCount)} ${noun.value}`
  const order = sortKey.value === 'label'
    ? (sortDir.value === 'asc' ? 'A to Z' : 'Z to A')
    : (sortDir.value === 'asc' ? 'low to high' : 'high to low')
  return `${shown}, sorted by ${sortLabel.value} (${order}). Select a row for its figures by period.`
})

function sortBy(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = key === 'label' ? 'asc' : 'desc'
  }
}
function sortIcon(key) {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? ' ↑' : ' ↓'
}
function ariaSort(key) {
  if (sortKey.value !== key) return 'none'
  return sortDir.value === 'asc' ? 'ascending' : 'descending'
}
function toggle(key) {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}
</script>

<style scoped>
.table-head-note {
  margin: 0 0 0.6rem;
  font-size: 0.75rem;
  color: var(--text-dim);
}
.table-scroll {
  overflow-x: auto;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.table-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.8rem;
}
.data-table :deep(th),
.data-table :deep(td) {
  padding: 0.5rem 0.65rem;
  border-bottom: 1px solid var(--bg);
}
.data-table thead th {
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 2px solid var(--border);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  background: var(--surface);
  text-align: left;
}
.data-table thead th.num { text-align: right; }
.data-table :deep(td.num) {
  text-align: right;
  font-family: 'JetBrains Mono', monospace;
  white-space: nowrap;
}
.data-table :deep(td.pos) { color: var(--accent); font-weight: 600; }
.data-table :deep(td.neg) { color: var(--danger, #dc2626); font-weight: 600; }
.data-table :deep(.sticky-col) {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--surface);
  box-shadow: 1px 0 0 var(--border);
  min-width: 12rem;
  max-width: 22rem;
  text-align: left;
}
.sort-btn {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-transform: inherit;
  letter-spacing: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.sort-btn:hover { color: var(--text); }
.sort-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.section-label {
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  padding-top: 0.85rem !important;
}
.other-head td { border-bottom: 1px solid var(--bg); }
.total-row > th, .total-row > td {
  font-weight: 700;
  background: var(--bg) !important;
  border-top: 2px solid var(--border);
}
.empty-cell {
  text-align: center;
  color: var(--text-dim);
  padding: 1.5rem 0 !important;
}
.show-all {
  margin-top: 0.75rem;
  display: flex;
  justify-content: center;
}
</style>
