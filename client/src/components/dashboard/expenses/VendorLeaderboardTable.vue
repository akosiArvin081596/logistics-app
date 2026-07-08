<template>
  <div class="exp-card">
    <div class="exp-card-head">
      <div class="exp-card-titles">
        <h3 class="exp-card-title">Vendor Leaderboard</h3>
        <div class="exp-card-sub">Every vendor &mdash; click a row to drill in</div>
      </div>
    </div>

    <div v-if="!sorted.length" class="exp-empty">
      No vendor data yet &mdash; vendors appear as receipts are scanned or the backfill runs.
    </div>

    <template v-else>
      <!-- Mobile: card list -->
      <div v-if="isMobile" class="vlt-cards">
        <button
          v-for="v in paginatedItems"
          :key="v.vendor"
          type="button"
          class="vlt-card"
          :aria-label="`Filter analytics by ${v.vendor}`"
          @click="$emit('select-vendor', v.vendor)"
        >
          <div class="vlt-card-top">
            <span class="vlt-card-name">{{ v.vendor }}</span>
            <span class="vlt-card-spend">{{ formatCurrency(v.spend) }}</span>
          </div>
          <div class="vlt-card-meta">
            <span class="meta-item"><span class="meta-label">Visits</span>{{ fmtInt(v.visits) }}</span>
            <span class="meta-item"><span class="meta-label">Gallons</span>{{ num(v.gallons) > 0 ? fmtGal(v.gallons) : '—' }}</span>
            <span class="meta-item"><span class="meta-label">$/gal</span>{{ num(v.avgPerGallon) > 0 ? '$' + num(v.avgPerGallon).toFixed(2) : '—' }}</span>
            <span class="meta-item"><span class="meta-label">Last visit</span>{{ fmtDate(v.lastDate) }}</span>
          </div>
          <div v-if="stateList(v).length" class="vlt-chips">
            <span v-for="s in stateList(v).slice(0, 3)" :key="s" class="state-chip">{{ s }}</span>
            <span v-if="stateList(v).length > 3" class="state-chip more" :title="stateList(v).slice(3).join(', ')">
              +{{ stateList(v).length - 3 }}
            </span>
          </div>
        </button>
      </div>

      <!-- Desktop: sortable table -->
      <div v-else class="vlt-table-wrap">
        <table class="vlt-table">
          <thead>
            <tr>
              <th
                v-for="c in COLUMNS"
                :key="c.key"
                :class="{ num: c.numeric }"
                :aria-sort="ariaSort(c.key)"
              >
                <button type="button" class="th-btn" :class="{ num: c.numeric }" @click="sortBy(c.key)">
                  {{ c.label }}
                  <span v-if="sortKey === c.key" class="sort-arrow" aria-hidden="true">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="v in paginatedItems"
              :key="v.vendor"
              class="vlt-row"
              tabindex="0"
              :aria-label="`Filter analytics by ${v.vendor}`"
              @click="$emit('select-vendor', v.vendor)"
              @keyup.enter="$emit('select-vendor', v.vendor)"
            >
              <td class="vendor-cell">{{ v.vendor }}</td>
              <td class="num">{{ fmtInt(v.visits) }}</td>
              <td class="num">{{ formatCurrency(v.spend) }}</td>
              <td class="num">{{ num(v.gallons) > 0 ? fmtGal(v.gallons) : '—' }}</td>
              <td class="num">{{ num(v.avgPerGallon) > 0 ? '$' + num(v.avgPerGallon).toFixed(2) : '—' }}</td>
              <td>
                <span class="vlt-chips">
                  <span v-for="s in stateList(v).slice(0, 3)" :key="s" class="state-chip">{{ s }}</span>
                  <span v-if="stateList(v).length > 3" class="state-chip more" :title="stateList(v).slice(3).join(', ')">
                    +{{ stateList(v).length - 3 }}
                  </span>
                  <span v-if="!stateList(v).length" class="dim">—</span>
                </span>
              </td>
              <td class="date-cell">{{ fmtDate(v.lastDate) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <PaginationBar
        :page="page"
        :page-size="pageSize"
        :total="sorted.length"
        :total-pages="totalPages"
        @go="goTo"
        @size="setSize"
      />
    </template>
  </div>
</template>

<script setup>
// The table-view twin of TopVendorsCard — every metric readable without hover,
// sortable, paginated (usePagination + shared PaginationBar), and a card list
// below the md breakpoint (useViewport singleton).
import { ref, computed, watch } from 'vue'
import { formatCurrency } from '../../../utils/format'
import { usePagination } from '../../../composables/usePagination'
import { useViewport } from '../../../composables/useViewport'
import PaginationBar from '../../shared/PaginationBar.vue'

const props = defineProps({
  // Rows: { vendor, visits, spend, gallons, avgPerGallon, states[], lastDate }
  vendors: { type: Array, default: () => [] },
})

defineEmits(['select-vendor'])

const { isMobile } = useViewport()

const COLUMNS = [
  { key: 'vendor', label: 'Vendor', numeric: false },
  { key: 'visits', label: 'Visits', numeric: true },
  { key: 'spend', label: 'Spend', numeric: true },
  { key: 'gallons', label: 'Gallons', numeric: true },
  { key: 'avgPerGallon', label: '$/gal', numeric: true },
  { key: 'states', label: 'States', numeric: false },
  { key: 'lastDate', label: 'Last visit', numeric: false },
]

const sortKey = ref('spend')
const sortDir = ref('desc')

function num(v) {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function stateList(v) {
  return Array.isArray(v?.states) ? v.states.filter(Boolean) : []
}

function sortValue(v, key) {
  if (key === 'vendor') return String(v.vendor || '')
  if (key === 'states') return stateList(v).length
  if (key === 'lastDate') return String(v.lastDate || '')
  return num(v[key])
}

const sorted = computed(() => {
  const dir = sortDir.value === 'asc' ? 1 : -1
  return [...(props.vendors || [])]
    .filter((v) => v && v.vendor)
    .sort((a, b) => {
      const av = sortValue(a, sortKey.value)
      const bv = sortValue(b, sortKey.value)
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * dir
      }
      return (av - bv) * dir
    })
})

const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(sorted, 10)

function sortBy(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    // Numeric/date columns lead with the biggest/newest; names lead A→Z.
    sortDir.value = key === 'vendor' ? 'asc' : 'desc'
  }
}

function ariaSort(key) {
  if (sortKey.value !== key) return 'none'
  return sortDir.value === 'asc' ? 'ascending' : 'descending'
}

// Re-clamp the page when a sort change or a refetch shrinks the list.
watch([sortKey, sortDir], () => goTo(1))
watch(
  () => props.vendors,
  () => goTo(page.value)
)

const fmtInt = (v) => num(v).toLocaleString('en-US')
const fmtGal = (g) => num(g).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

// Format 'YYYY-MM-DD' without new Date(): UTC parsing would shift the day in
// negative-offset timezones.
function fmtDate(iso) {
  const [yy, mm, dd] = String(iso || '').split('-')
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const name = names[(parseInt(mm, 10) || 0) - 1]
  if (!name || !yy || !dd) return '—'
  return `${name} ${parseInt(dd, 10)}, ${yy}`
}
</script>

<style scoped>
.exp-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem 1.1rem;
  min-width: 0;
}
.exp-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.85rem;
}
.exp-card-titles { min-width: 0; }
.exp-card-title {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text);
}
.exp-card-sub {
  font-size: 0.7rem;
  color: var(--text-dim);
  margin-top: 2px;
}
.exp-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.8rem;
  line-height: 1.5;
  padding: 1.75rem 1rem;
}

/* Desktop table */
.vlt-table-wrap { overflow-x: auto; }
.vlt-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}
.vlt-table th {
  padding: 0.45rem 0.75rem;
  border-bottom: 2px solid var(--border);
  text-align: left;
  white-space: nowrap;
}
.vlt-table th.num { text-align: right; }
.th-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
  font-size: 0.64rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  cursor: pointer;
  transition: color 0.15s;
}
.th-btn:hover { color: var(--text); }
.th-btn.num { justify-content: flex-end; width: 100%; }
.sort-arrow { font-size: 0.55rem; }

.vlt-table td {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  vertical-align: middle;
}
.vlt-table td.num {
  text-align: right;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  white-space: nowrap;
}
.vlt-row { cursor: pointer; transition: background 0.12s; }
.vlt-row:hover { background: var(--surface-hover); }
.vlt-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.vlt-table tbody tr:last-child td { border-bottom: none; }
.vendor-cell { font-weight: 600; }
.date-cell { color: var(--text-dim); white-space: nowrap; }
.dim { color: var(--text-dim); }

/* States chips */
.vlt-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
}
.state-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--text-dim);
  line-height: 1.5;
}
.state-chip.more { color: var(--text); }

/* Mobile card list */
.vlt-cards {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.vlt-card {
  display: block;
  width: 100%;
  padding: 0.7rem 0.8rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s;
}
.vlt-card:hover,
.vlt-card:focus-visible { border-color: var(--accent); }
.vlt-card-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.75rem;
}
.vlt-card-name {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vlt-card-spend {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  font-size: 0.8rem;
  color: var(--text);
  flex-shrink: 0;
}
.vlt-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 1rem;
  margin-top: 0.4rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  color: var(--text);
}
.meta-item { display: inline-flex; align-items: baseline; gap: 0.3rem; }
.meta-label {
  font-family: 'DM Sans', sans-serif;
  font-size: 0.6rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.vlt-card .vlt-chips { margin-top: 0.45rem; }
</style>
