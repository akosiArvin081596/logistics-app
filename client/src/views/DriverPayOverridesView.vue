<template>
  <div class="admin-page">
    <!-- ============================== -->
    <!-- LIST VIEW: drivers grid         -->
    <!-- ============================== -->
    <template v-if="!selectedDriverKey">
      <div class="page-header">
        <h2>Driver Pay Overrides</h2>
        <p class="page-desc">
          Pick a driver to view their monthly activity calendar and add or remove day overrides. Every change flows in lockstep through the investor portal, company P&amp;L, and weekly invoices.
        </p>
      </div>

      <div class="filter-bar">
        <div class="search-wrap">
          <span class="search-icon" aria-hidden="true">&#128269;</span>
          <input
            v-model="search"
            type="search"
            placeholder="Search drivers by name…"
            class="search-input"
            @keydown.escape="search = ''"
          />
        </div>
        <span class="result-count">
          {{ filteredDrivers.length }} of {{ allDrivers.length }} driver{{ allDrivers.length === 1 ? '' : 's' }}
        </span>
      </div>

      <!-- Loading skeleton -->
      <div v-if="loading && !allDrivers.length" class="driver-grid">
        <div v-for="i in 6" :key="i" class="driver-card skeleton">
          <div class="skel-line skel-name"></div>
          <div class="skel-stats">
            <div class="skel-line"></div>
            <div class="skel-line"></div>
            <div class="skel-line"></div>
          </div>
        </div>
      </div>

      <div v-else-if="filteredDrivers.length === 0" class="empty-state">
        <div class="empty-icon">&#128100;</div>
        <div class="empty-title">{{ allDrivers.length === 0 ? 'No drivers in the fleet yet' : 'No drivers match your search' }}</div>
        <div class="empty-sub" v-if="allDrivers.length > 0">
          Try a different name, or <button class="link-btn" @click="search = ''">clear the search</button>.
        </div>
      </div>

      <div v-else class="driver-grid">
        <button
          v-for="d in filteredDrivers"
          :key="d.driverKey"
          type="button"
          class="driver-card"
          :aria-label="`Open ${d.displayName}'s pay overrides`"
          @click="selectDriver(d.driverKey)"
        >
          <div class="driver-card-top">
            <div class="avatar" :style="{ background: avatarColor(d.driverKey) }">
              {{ initials(d.displayName) }}
            </div>
            <div class="driver-id">
              <div class="driver-name">{{ d.displayName }}</div>
              <div class="driver-sub">
                {{ d.payType === 'percentage' ? `${d.payPercentage}% of net` : `$${d.dailyRate || 250}/day` }}
              </div>
            </div>
            <span v-if="d.overrideCount > 0" class="ovr-badge" :title="`${d.addCount} added · ${d.removeCount} excluded`">
              {{ d.overrideCount }}
            </span>
          </div>

          <div class="driver-card-stats">
            <div class="stat">
              <span class="stat-val">{{ d.activeDays }}</span>
              <span class="stat-label">Active days</span>
            </div>
            <div class="stat">
              <span class="stat-val">{{ fmt(d.totalPay) }}</span>
              <span class="stat-label">Total pay</span>
            </div>
            <div class="stat">
              <span class="stat-val">
                <span v-if="d.source === 'eld'" class="src-dot eld" title="ELD-verified"></span>
                <span v-else-if="d.source === 'mixed'" class="src-dot mixed" title="Partly ELD-verified"></span>
                <span v-else class="src-dot est" title="Estimated"></span>
                <span class="src-text">{{ d.source === 'eld' ? 'ELD' : d.source === 'mixed' ? 'Mixed' : 'Est.' }}</span>
              </span>
              <span class="stat-label">Source</span>
            </div>
          </div>

          <div class="driver-card-cta">
            Manage overrides &rarr;
          </div>
        </button>
      </div>
    </template>

    <!-- ============================== -->
    <!-- DETAIL VIEW: single driver       -->
    <!-- ============================== -->
    <template v-else-if="detail">
      <!-- Sticky header with back nav + month picker -->
      <div class="detail-header">
        <button class="back-btn" @click="closeDetail">
          <span aria-hidden="true">&#8592;</span> All drivers
        </button>
        <div class="detail-title">
          <div class="avatar lg" :style="{ background: avatarColor(detail.driverKey) }">
            {{ initials(detail.displayName) }}
          </div>
          <div>
            <h2>{{ detail.displayName }}</h2>
            <div class="detail-meta">
              <span class="meta-pill">
                {{ detail.payType === 'percentage' ? `${detail.payPercentage}% of net` : `$${detail.dailyRate || 250}/day` }}
              </span>
              <span class="meta-pill">{{ detail.activeDays }} active day{{ detail.activeDays === 1 ? '' : 's' }} all-time</span>
              <span class="meta-pill strong">{{ fmt(detail.totalPay) }} earned</span>
            </div>
          </div>
        </div>

        <div class="month-nav" role="navigation" aria-label="Month selector">
          <button
            class="nav-btn"
            :disabled="selectedMonthIdx <= 0"
            aria-label="Previous month"
            @click="selectedMonthIdx--"
          >&#9664;</button>
          <select v-model.number="selectedMonthIdx" class="month-select" :title="`${months.length} months of activity`">
            <option v-for="(m, i) in months" :key="m.month" :value="i">
              {{ monthLabel(m.month) }}{{ m.isCurrentMonth ? ' (current)' : '' }}
            </option>
          </select>
          <button
            class="nav-btn"
            :disabled="selectedMonthIdx >= months.length - 1"
            aria-label="Next month"
            @click="selectedMonthIdx++"
          >&#9654;</button>
        </div>
      </div>

      <!-- Monthly summary banner -->
      <div v-if="monthDetail" class="month-banner">
        <div class="banner-stat primary">
          <span class="banner-val">{{ monthDetail.activeDays }}</span>
          <span class="banner-lbl">Active day{{ monthDetail.activeDays === 1 ? '' : 's' }}</span>
        </div>
        <div class="banner-times">&times;</div>
        <div class="banner-stat">
          <span class="banner-val">${{ monthDetail.dailyRate || 250 }}</span>
          <span class="banner-lbl">per day</span>
        </div>
        <div class="banner-eq">=</div>
        <div class="banner-stat total">
          <span class="banner-val">{{ fmt(monthDetail.totalPay) }}</span>
          <span class="banner-lbl">{{ monthLabel(selected.month) }} pay</span>
        </div>
        <div class="banner-spacer"></div>
        <span v-if="monthDetail.source === 'eld'" class="src-tag eld">ELD-verified</span>
        <span v-else-if="monthDetail.source === 'mixed'" class="src-tag mixed">Partly ELD-verified</span>
        <span v-else class="src-tag est">Estimated</span>
      </div>

      <!-- Calendar grid -->
      <div class="card calendar-card">
        <div class="cal-legend">
          <span class="legend-item"><span class="swatch active"></span> Active (ELD)</span>
          <span class="legend-item"><span class="swatch estimated"></span> Estimated</span>
          <span class="legend-item"><span class="swatch added"></span> Added by admin</span>
          <span class="legend-item"><span class="swatch excluded"></span> Excluded by admin</span>
          <span class="legend-item"><span class="swatch empty"></span> No activity</span>
        </div>

        <div class="calendar">
          <div class="cal-row cal-head">
            <div v-for="d in WEEKDAYS" :key="d" class="cal-head-cell">{{ d }}</div>
          </div>
          <div v-for="(week, wi) in calendar" :key="wi" class="cal-row">
            <div
              v-for="(cell, ci) in week"
              :key="ci"
              :class="cellClass(cell)"
              :tabindex="cell ? 0 : -1"
              :aria-label="cellAriaLabel(cell)"
              :title="cellTitle(cell)"
              role="button"
              @click="cell && openCell(cell)"
              @keyup.enter="cell && openCell(cell)"
              @keyup.space.prevent="cell && openCell(cell)"
            >
              <template v-if="cell">
                <span class="cal-day-num">{{ cell.day }}</span>
                <span v-if="cell.loadIds && cell.loadIds.length" class="cal-load-count">{{ cell.loadIds.length }}</span>
                <span v-if="cell.state === 'excluded'" class="cal-marker excl">&times;</span>
                <span v-else-if="cell.state === 'added'" class="cal-marker addm">+</span>
              </template>
            </div>
          </div>
        </div>

        <!-- Inline action panel for selected cell -->
        <div v-if="activeCell" class="cell-panel" :class="`for-${activeCell.state}`">
          <button class="cell-close" aria-label="Close" @click="closeCell">&times;</button>
          <div class="cell-panel-head">
            <div class="cell-panel-title">{{ formatDayLabel(activeCell.date) }}</div>
            <div class="cell-panel-state">
              <span v-if="activeCell.state === 'active'">Active day (ELD-verified)</span>
              <span v-else-if="activeCell.state === 'estimated'">Estimated active day</span>
              <span v-else-if="activeCell.state === 'added'">Added by admin</span>
              <span v-else-if="activeCell.state === 'excluded'">Excluded by admin</span>
              <span v-else>No activity</span>
            </div>
          </div>

          <div v-if="activeCell.loadIds && activeCell.loadIds.length" class="cell-loads">
            <span class="cell-loads-label">Load{{ activeCell.loadIds.length === 1 ? '' : 's' }}:</span>
            <span class="cell-loads-list">{{ activeCell.loadIds.join(', ') }}</span>
          </div>

          <div v-if="activeCell.overrideRow && activeCell.overrideRow.reason" class="cell-reason-text">
            <span class="cell-reason-label">Reason:</span> {{ activeCell.overrideRow.reason }}
          </div>

          <!-- Add / exclude / restore options -->
          <div class="cell-actions">
            <!-- Active or Estimated → can Exclude -->
            <template v-if="activeCell.state === 'active' || activeCell.state === 'estimated'">
              <textarea
                v-model="actionReason"
                class="cell-reason"
                rows="2"
                placeholder="Reason (optional, recorded in audit log)"
              ></textarea>
              <button
                type="button"
                class="cell-btn danger"
                :disabled="actionBusy"
                @click="doExclude"
              >{{ actionBusy ? 'Excluding…' : '− Exclude this day' }}</button>
            </template>

            <!-- Empty → can Add -->
            <template v-else-if="activeCell.state === 'empty'">
              <textarea
                v-model="actionReason"
                class="cell-reason"
                rows="2"
                placeholder="Reason (e.g. 'Truck ELD offline')"
              ></textarea>
              <button
                type="button"
                class="cell-btn primary"
                :disabled="actionBusy"
                @click="doAdd"
              >{{ actionBusy ? 'Adding…' : '+ Add this day' }}</button>
            </template>

            <!-- Excluded → can Restore -->
            <template v-else-if="activeCell.state === 'excluded'">
              <button
                type="button"
                class="cell-btn primary"
                :disabled="actionBusy"
                @click="doRestore"
              >{{ actionBusy ? '…' : '↺ Restore this day' }}</button>
            </template>

            <!-- Added → can Remove -->
            <template v-else-if="activeCell.state === 'added'">
              <button
                type="button"
                class="cell-btn danger"
                :disabled="actionBusy"
                @click="doRestore"
              >{{ actionBusy ? '…' : '− Remove this admin-added day' }}</button>
            </template>
          </div>
        </div>
      </div>

      <!-- Override history list (compact, all overrides for this driver) -->
      <div v-if="driverOverrides.length" class="card">
        <div class="card-header">
          <div class="card-title">Override history ({{ driverOverrides.length }})</div>
        </div>
        <div class="history-list">
          <div v-for="row in driverOverrides" :key="row.id" class="history-row">
            <span :class="['history-badge', row.action]">{{ row.action === 'add' ? '+ Added' : '− Excluded' }}</span>
            <span class="history-date">{{ formatDayLabel(row.excluded_date) }}</span>
            <span class="history-reason">{{ row.reason || '(no reason)' }}</span>
            <span class="history-meta">{{ row.excluded_by || '?' }} · {{ formatTs(row.excluded_at) }}</span>
            <button class="cell-btn xs" :disabled="busyId === row.id" @click="restoreRow(row)">
              {{ busyId === row.id ? '…' : 'Undo' }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Detail view fallback -->
    <div v-else class="empty-state">
      <div class="empty-icon">&#9203;</div>
      <div class="empty-title">Loading driver data…</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useInvestorStore } from '../stores/investor'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import { formatCurrency as fmt } from '../utils/format'

const api = useApi()
const { show: toast } = useToast()
const investorStore = useInvestorStore()

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const loading = ref(false)
const selectedDriverKey = ref(null)
const search = ref('')
const overrides = ref([])

// Load investor data (Super Admin → fleet-wide) + override rows
async function loadAll() {
  loading.value = true
  try {
    if (investorStore.isPreview) investorStore.clearPreview()
    const tasks = [loadOverrides()]
    if (!investorStore.data) tasks.push(investorStore.load())
    await Promise.all(tasks)
  } catch (err) {
    toast(err?.message || 'Failed to load driver data', 'error')
  } finally {
    loading.value = false
  }
}

async function loadOverrides() {
  try {
    const r = await api.get('/api/admin/driver-day-overrides')
    overrides.value = r.overrides || []
  } catch (err) {
    overrides.value = []
  }
}

const months = computed(() => investorStore.data?.production?.monthlyEarnings || [])
const driverPayDetails = computed(() => investorStore.data?.production?.driverPayDetails || {})

// Build a per-driver index of overrides for quick lookup (driver → date → row)
const overridesByDriverDate = computed(() => {
  const map = {}
  for (const o of overrides.value) {
    const dn = (o.driver_name || '').toLowerCase()
    if (!map[dn]) map[dn] = {}
    map[dn][o.excluded_date] = o
  }
  return map
})

// All drivers list
const allDrivers = computed(() => {
  const dpd = driverPayDetails.value
  const list = []
  for (const [key, d] of Object.entries(dpd)) {
    let addCount = 0, removeCount = 0
    let displayName = key
    for (const m of months.value) {
      const det = (m.driverDetails || {})[key]
      if (!det) continue
      addCount += (det.addedDays || []).length
      removeCount += (det.excludedDays || []).length
      if (det.displayDriverName && displayName === key) displayName = det.displayDriverName
    }
    list.push({
      driverKey: key,
      displayName: titleCase(displayName),
      activeDays: d.activeDays || 0,
      dailyRate: d.dailyRate || 250,
      totalPay: d.totalPay || 0,
      payType: d.payType || 'fixed',
      payPercentage: d.payPercentage || 0,
      source: d.source || 'estimated',
      addCount,
      removeCount,
      overrideCount: addCount + removeCount,
    })
  }
  list.sort((a, b) => {
    if (a.overrideCount !== b.overrideCount) return b.overrideCount - a.overrideCount
    return a.displayName.localeCompare(b.displayName)
  })
  return list
})

const filteredDrivers = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return allDrivers.value
  return allDrivers.value.filter(d => d.displayName.toLowerCase().includes(q))
})

const detail = computed(() => {
  if (!selectedDriverKey.value) return null
  return allDrivers.value.find(d => d.driverKey === selectedDriverKey.value) || null
})

// Month state
const selectedMonthIdx = ref(0)
watch(months, (v) => {
  if (v.length) selectedMonthIdx.value = v.length - 1
}, { immediate: true })
const selected = computed(() => months.value[selectedMonthIdx.value] || null)
const monthDetail = computed(() => {
  if (!selected.value || !selectedDriverKey.value) return null
  return (selected.value.driverDetails || {})[selectedDriverKey.value] || null
})

// Build the calendar matrix for the selected month + driver
// Cell shape: { day, date, state, loadIds, overrideRow } or null (filler)
const calendar = computed(() => {
  if (!selected.value || !selectedDriverKey.value) return []
  const [y, m] = selected.value.month.split('-').map(Number)
  if (!y || !m) return []
  const firstDow = new Date(y, m - 1, 1).getDay() // 0=Sun
  const daysInMonth = new Date(y, m, 0).getDate()

  // Index this month's data
  const md = monthDetail.value || {}
  const dayLoadsMap = {} // YYYY-MM-DD → [loadIds] (from server's dayBreakdown, post-overrides)
  for (const r of (md.dayBreakdown || [])) dayLoadsMap[r.date] = r.loadIds
  const overrideForDate = overridesByDriverDate.value[selectedDriverKey.value] || {}

  const pad = (n) => String(n).padStart(2, '0')
  const cells = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${pad(m)}-${pad(d)}`
    const ovr = overrideForDate[dateStr]
    let state = 'empty'
    if (ovr && ovr.action === 'add') state = 'added'
    else if (ovr && ovr.action === 'remove') state = 'excluded'
    else if (dayLoadsMap[dateStr]) {
      // dayBreakdown already filtered by source: if it's there post-override, it's an active day.
      // Source flag at the month level tells us ELD vs estimated.
      state = md.source === 'eld' ? 'active' : md.source === 'mixed' ? 'active' : 'estimated'
    }
    cells.push({
      day: d,
      date: dateStr,
      state,
      loadIds: dayLoadsMap[dateStr] || [],
      overrideRow: ovr || null,
    })
  }
  // Pad the last week
  while (cells.length % 7 !== 0) cells.push(null)
  // Chunk into weeks
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
})

// Override history just for the selected driver
const driverOverrides = computed(() => {
  if (!selectedDriverKey.value) return []
  return overrides.value
    .filter(o => (o.driver_name || '').toLowerCase() === selectedDriverKey.value)
    .sort((a, b) => b.excluded_date.localeCompare(a.excluded_date))
})

// --- Cell interaction ---
const activeCell = ref(null)
const actionReason = ref('')
const actionBusy = ref(false)
const busyId = ref(0)

function openCell(cell) {
  if (!cell) return
  actionReason.value = ''
  activeCell.value = cell
}
function closeCell() {
  if (actionBusy.value) return
  activeCell.value = null
  actionReason.value = ''
}

async function doExclude() {
  if (!activeCell.value || actionBusy.value) return
  actionBusy.value = true
  try {
    await api.post('/api/admin/excluded-days', {
      driverName: selectedDriverKey.value,
      date: activeCell.value.date,
      reason: actionReason.value || '',
      action: 'remove',
    })
    toast(`Excluded ${formatDayLabel(activeCell.value.date)}`)
    activeCell.value = null
    await refreshAfterChange()
  } catch (err) {
    toast(err?.message || 'Failed to exclude', 'error')
  } finally {
    actionBusy.value = false
  }
}

async function doAdd() {
  if (!activeCell.value || actionBusy.value) return
  actionBusy.value = true
  try {
    await api.post('/api/admin/excluded-days', {
      driverName: selectedDriverKey.value,
      date: activeCell.value.date,
      reason: actionReason.value || '',
      action: 'add',
    })
    toast(`Added ${formatDayLabel(activeCell.value.date)}`)
    activeCell.value = null
    await refreshAfterChange()
  } catch (err) {
    toast(err?.message || 'Failed to add', 'error')
  } finally {
    actionBusy.value = false
  }
}

async function doRestore() {
  if (!activeCell.value || !activeCell.value.overrideRow || actionBusy.value) return
  actionBusy.value = true
  try {
    await api.del(`/api/admin/excluded-days/${activeCell.value.overrideRow.id}`)
    toast(`Restored ${formatDayLabel(activeCell.value.date)}`)
    activeCell.value = null
    await refreshAfterChange()
  } catch (err) {
    toast(err?.message || 'Failed to restore', 'error')
  } finally {
    actionBusy.value = false
  }
}

async function restoreRow(row) {
  if (busyId.value) return
  busyId.value = row.id
  try {
    await api.del(`/api/admin/excluded-days/${row.id}`)
    toast(`Undone: ${formatDayLabel(row.excluded_date)}`)
    await refreshAfterChange()
  } catch (err) {
    toast(err?.message || 'Failed', 'error')
  } finally {
    busyId.value = 0
  }
}

async function refreshAfterChange() {
  await Promise.all([investorStore.load(), loadOverrides()])
}

function selectDriver(key) {
  selectedDriverKey.value = key
  activeCell.value = null
  actionReason.value = ''
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
function closeDetail() {
  selectedDriverKey.value = null
  activeCell.value = null
}

// Keyboard nav for month
function onKeydown(e) {
  if (!selectedDriverKey.value) return
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
  if (e.key === 'ArrowLeft' && selectedMonthIdx.value > 0) {
    selectedMonthIdx.value--
    e.preventDefault()
  } else if (e.key === 'ArrowRight' && selectedMonthIdx.value < months.value.length - 1) {
    selectedMonthIdx.value++
    e.preventDefault()
  } else if (e.key === 'Escape') {
    if (activeCell.value) closeCell()
    else closeDetail()
  }
}
onMounted(() => {
  loadAll()
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// --- Helpers ---
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function monthLabel(mk) {
  if (!mk) return ''
  const [y, m] = mk.split('-')
  return `${MONTH_NAMES[parseInt(m) - 1] || m} ${y}`
}
function formatDayLabel(ymd) {
  if (!ymd) return ''
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return ymd
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}
function formatTs(iso) {
  if (!iso) return '?'
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return iso
  const ageSec = Math.round((Date.now() - d.getTime()) / 1000)
  if (ageSec < 60) return 'just now'
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`
  if (ageSec < 86400 * 30) return `${Math.round(ageSec / 86400)}d ago`
  return d.toLocaleDateString()
}
function titleCase(s) {
  return (s || '').replace(/\b\w/g, c => c.toUpperCase())
}
function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
// Deterministic avatar color per driver — same name always gets same color
const AVATAR_COLORS = [
  '#6366f1', '#ec4899', '#8b5cf6', '#14b8a6', '#f59e0b', '#ef4444',
  '#10b981', '#3b82f6', '#a855f7', '#06b6d4', '#84cc16', '#f97316',
]
function avatarColor(key) {
  if (!key) return AVATAR_COLORS[0]
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0xffff
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
function cellClass(cell) {
  if (!cell) return 'cal-cell empty filler'
  const cls = ['cal-cell', cell.state]
  if (activeCell.value && activeCell.value.date === cell.date) cls.push('selected')
  const today = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  if (cell.date === todayStr) cls.push('today')
  return cls.join(' ')
}
function cellAriaLabel(cell) {
  if (!cell) return ''
  const label = formatDayLabel(cell.date)
  const stateLabel = {
    active: 'active day, ELD-verified',
    estimated: 'estimated active day',
    added: 'added by admin',
    excluded: 'excluded by admin',
    empty: 'no activity',
  }[cell.state] || ''
  return `${label}, ${stateLabel}. Click to manage.`
}
function cellTitle(cell) {
  if (!cell) return ''
  const parts = [formatDayLabel(cell.date)]
  if (cell.loadIds && cell.loadIds.length) parts.push(`Loads: ${cell.loadIds.join(', ')}`)
  if (cell.overrideRow && cell.overrideRow.reason) parts.push(`Reason: ${cell.overrideRow.reason}`)
  return parts.join(' · ')
}
</script>

<style scoped>
.admin-page {
  padding: 1.5rem; max-width: 1200px; margin: 0 auto;
}
.page-header { margin-bottom: 1.25rem; }
.page-header h2 { margin: 0 0 0.4rem; font-size: 1.5rem; }
.page-desc { color: var(--text-dim); font-size: 0.92rem; line-height: 1.5; margin: 0; max-width: 720px; }

/* Filter bar */
.filter-bar {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 1rem; gap: 0.75rem;
}
.search-wrap { position: relative; flex: 1; max-width: 380px; }
.search-icon {
  position: absolute; left: 0.7rem; top: 50%; transform: translateY(-50%);
  font-size: 0.9rem; opacity: 0.5; pointer-events: none;
}
.search-input {
  width: 100%; box-sizing: border-box;
  font-family: inherit; font-size: 0.92rem;
  padding: 0.55rem 0.7rem 0.55rem 2.1rem;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text);
  transition: border-color 0.12s;
}
.search-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
.result-count { font-size: 0.82rem; color: var(--text-dim); white-space: nowrap; }

/* Empty state */
.empty-state {
  text-align: center; padding: 3rem 1rem;
  color: var(--text-dim);
}
.empty-icon { font-size: 2.5rem; margin-bottom: 0.75rem; opacity: 0.5; }
.empty-title { font-size: 1rem; font-weight: 600; color: var(--text); margin-bottom: 0.25rem; }
.empty-sub { font-size: 0.85rem; }
.link-btn {
  background: none; border: none; padding: 0; cursor: pointer;
  color: var(--accent); text-decoration: underline; font: inherit;
}

/* Driver grid */
.driver-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.9rem;
}
.driver-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1rem 1.1rem;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  color: var(--text);
  transition: all 0.18s ease;
  display: flex; flex-direction: column; gap: 0.85rem;
  position: relative;
  overflow: hidden;
}
.driver-card::before {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(135deg, transparent 0%, var(--accent-dim) 100%);
  opacity: 0; transition: opacity 0.18s;
  pointer-events: none;
}
.driver-card:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
  box-shadow: 0 6px 16px -4px rgba(0,0,0,0.12);
}
.driver-card:hover::before { opacity: 0.5; }
.driver-card:focus-visible {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
.driver-card-top {
  display: flex; align-items: center; gap: 0.75rem;
  position: relative; z-index: 1;
}
.avatar {
  width: 42px; height: 42px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: white; font-weight: 700; font-size: 0.95rem;
  flex-shrink: 0;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}
.avatar.lg { width: 56px; height: 56px; font-size: 1.2rem; }
.driver-id { flex: 1; min-width: 0; }
.driver-name { font-weight: 700; font-size: 1.02rem; line-height: 1.2; }
.driver-sub { font-size: 0.78rem; color: var(--text-dim); margin-top: 0.15rem; }
.ovr-badge {
  background: rgba(234, 179, 8, 0.18); color: rgb(150, 110, 0);
  font-size: 0.78rem; font-weight: 700;
  width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  flex-shrink: 0;
}
.driver-card-stats {
  display: grid; grid-template-columns: 1fr 1fr 1fr;
  gap: 0.4rem;
  padding: 0.65rem 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  position: relative; z-index: 1;
}
.stat { display: flex; flex-direction: column; gap: 0.15rem; }
.stat-val {
  font-size: 1rem; font-weight: 700;
  display: flex; align-items: center; gap: 0.3rem;
}
.stat-label {
  font-size: 0.68rem; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.src-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
}
.src-dot.eld { background: rgb(34, 197, 94); }
.src-dot.mixed { background: rgb(234, 179, 8); }
.src-dot.est { background: rgb(148, 163, 184); }
.src-text { font-size: 0.85rem; }
.driver-card-cta {
  font-size: 0.78rem; font-weight: 600;
  color: var(--accent); opacity: 0.7;
  position: relative; z-index: 1;
}
.driver-card:hover .driver-card-cta { opacity: 1; }

/* Skeleton */
.driver-card.skeleton { pointer-events: none; }
.skel-line {
  background: linear-gradient(90deg, var(--border) 25%, var(--bg) 50%, var(--border) 75%);
  background-size: 200% 100%;
  animation: skel 1.4s infinite;
  height: 12px; border-radius: 4px;
}
.skel-name { width: 60%; height: 16px; margin-bottom: 0.5rem; }
.skel-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.5rem; }
@keyframes skel {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Detail header (sticky) */
.detail-header {
  position: sticky; top: 0; z-index: 10;
  background: var(--bg);
  margin: -1.5rem -1.5rem 1.25rem;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border);
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 1rem;
}
.back-btn {
  background: transparent; border: 1px solid var(--border); border-radius: 8px;
  padding: 0.5rem 0.85rem; font-family: inherit; font-size: 0.88rem;
  color: var(--text); cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
}
.back-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
.detail-title { display: flex; align-items: center; gap: 0.85rem; min-width: 0; }
.detail-title h2 { margin: 0 0 0.3rem; font-size: 1.35rem; line-height: 1; }
.detail-meta {
  display: flex; gap: 0.4rem; flex-wrap: wrap;
}
.meta-pill {
  font-size: 0.78rem;
  padding: 0.18rem 0.55rem;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.meta-pill.strong { color: var(--accent); border-color: var(--accent); font-weight: 600; }

.month-nav { display: flex; align-items: center; gap: 0.4rem; }
.nav-btn {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 0.4rem 0.75rem; font-family: inherit; cursor: pointer;
  color: var(--text);
  transition: all 0.12s;
}
.nav-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.nav-btn:disabled { opacity: 0.35; cursor: default; }
.month-select {
  font-family: inherit; font-size: 0.92rem; font-weight: 600;
  padding: 0.45rem 0.7rem;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text);
  cursor: pointer;
}

/* Month summary banner */
.month-banner {
  display: flex; align-items: center; gap: 1rem;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  background: linear-gradient(135deg, var(--surface) 0%, var(--accent-dim) 200%);
  border: 1px solid var(--border);
  border-radius: 12px;
  flex-wrap: wrap;
}
.banner-stat { display: flex; flex-direction: column; gap: 0.15rem; }
.banner-stat.primary .banner-val { color: var(--accent); }
.banner-stat.total .banner-val { font-size: 1.5rem; color: var(--accent); }
.banner-val { font-size: 1.3rem; font-weight: 700; line-height: 1; }
.banner-lbl { font-size: 0.72rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.banner-times, .banner-eq {
  font-size: 1.4rem; color: var(--text-dim); font-weight: 300;
}
.banner-spacer { flex: 1; }
.src-tag {
  font-size: 0.72rem; font-weight: 700;
  padding: 0.25rem 0.55rem; border-radius: 4px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.src-tag.eld { background: rgba(34, 197, 94, 0.15); color: rgb(22, 163, 74); }
.src-tag.mixed { background: rgba(234, 179, 8, 0.15); color: rgb(180, 130, 0); }
.src-tag.est { background: var(--border); color: var(--text-dim); }

/* Card wrapper */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 1.25rem;
  overflow: hidden;
}
.card-header {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.card-title { font-weight: 700; font-size: 0.95rem; }
.calendar-card { padding: 1.25rem; }

/* Calendar legend */
.cal-legend {
  display: flex; flex-wrap: wrap; gap: 1rem;
  margin-bottom: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px dashed var(--border);
  font-size: 0.78rem; color: var(--text-dim);
}
.legend-item { display: flex; align-items: center; gap: 0.4rem; }
.swatch {
  width: 14px; height: 14px; border-radius: 3px;
  display: inline-block;
}
.swatch.active { background: rgb(34, 197, 94); }
.swatch.estimated { background: rgba(34, 197, 94, 0.35); }
.swatch.added { background: white; border: 2px solid rgb(34, 197, 94); }
.swatch.excluded { background: rgba(234, 179, 8, 0.35); border: 1px solid rgb(234, 179, 8); }
.swatch.empty { background: var(--bg); border: 1px solid var(--border); }

/* Calendar grid */
.calendar { width: 100%; }
.cal-row {
  display: grid; grid-template-columns: repeat(7, 1fr);
  gap: 0.35rem;
  margin-bottom: 0.35rem;
}
.cal-head-cell {
  font-size: 0.7rem; font-weight: 700;
  text-align: center; padding: 0.3rem 0;
  color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em;
}
.cal-cell {
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  display: flex; align-items: flex-start; justify-content: flex-start;
  padding: 0.4rem 0.5rem;
  position: relative;
  cursor: pointer;
  transition: all 0.12s;
  font-size: 0.9rem;
}
.cal-cell.filler { background: transparent; border-color: transparent; cursor: default; pointer-events: none; }
.cal-cell:not(.filler):hover {
  border-color: var(--accent);
  transform: scale(1.04);
  box-shadow: 0 2px 6px rgba(0,0,0,0.1);
  z-index: 2;
}
.cal-cell:focus-visible {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
.cal-cell.today {
  border-color: rgb(59, 130, 246);
  box-shadow: 0 0 0 1px rgb(59, 130, 246);
}
.cal-cell.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
  z-index: 3;
}
.cal-cell.active { background: rgba(34, 197, 94, 0.6); color: white; font-weight: 700; }
.cal-cell.estimated { background: rgba(34, 197, 94, 0.25); }
.cal-cell.added {
  background: white;
  border: 2px solid rgb(34, 197, 94);
  font-weight: 700; color: rgb(22, 163, 74);
}
.cal-cell.excluded {
  background: rgba(234, 179, 8, 0.25);
  border-color: rgb(234, 179, 8);
  color: rgb(150, 110, 0);
  text-decoration: line-through;
  text-decoration-thickness: 2px;
}
.cal-day-num { font-weight: inherit; }
.cal-load-count {
  position: absolute; bottom: 0.3rem; right: 0.4rem;
  font-size: 0.65rem; opacity: 0.85; font-weight: 600;
  background: rgba(0,0,0,0.15); padding: 0.05rem 0.3rem; border-radius: 4px;
  color: white;
}
.cal-cell.estimated .cal-load-count { background: rgba(34, 197, 94, 0.5); }
.cal-cell.added .cal-load-count { display: none; }
.cal-marker {
  position: absolute; top: 0.3rem; right: 0.4rem;
  font-size: 0.85rem; font-weight: 800;
}
.cal-cell.excluded .cal-marker.excl { color: rgb(150, 110, 0); }
.cal-cell.added .cal-marker.addm { color: rgb(22, 163, 74); }

/* Cell action panel */
.cell-panel {
  margin-top: 1.25rem;
  padding: 1rem 1.1rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  position: relative;
  animation: slideIn 0.18s ease-out;
}
.cell-panel.for-active, .cell-panel.for-estimated { border-color: rgba(239, 68, 68, 0.3); }
.cell-panel.for-added { border-color: rgba(34, 197, 94, 0.3); }
.cell-panel.for-excluded { border-color: rgba(234, 179, 8, 0.3); }
.cell-panel.for-empty { border-color: rgba(34, 197, 94, 0.3); }
@keyframes slideIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
.cell-close {
  position: absolute; top: 0.5rem; right: 0.6rem;
  background: none; border: none; cursor: pointer;
  font-size: 1.4rem; line-height: 1; color: var(--text-dim);
  padding: 0.15rem 0.4rem; border-radius: 4px;
}
.cell-close:hover { background: var(--border); color: var(--text); }
.cell-panel-head { margin-bottom: 0.6rem; }
.cell-panel-title { font-weight: 700; font-size: 1rem; }
.cell-panel-state { font-size: 0.82rem; color: var(--text-dim); margin-top: 0.1rem; }
.cell-loads {
  font-size: 0.82rem; color: var(--text-dim);
  margin-bottom: 0.5rem;
}
.cell-loads-label { font-weight: 600; }
.cell-loads-list { font-family: ui-monospace, SFMono-Regular, monospace; }
.cell-reason-text {
  font-size: 0.82rem; color: var(--text-dim);
  margin-bottom: 0.6rem;
  font-style: italic;
}
.cell-reason-label { font-weight: 600; font-style: normal; }
.cell-reason {
  width: 100%; box-sizing: border-box;
  font-family: inherit; font-size: 0.88rem;
  padding: 0.5rem 0.6rem;
  margin-bottom: 0.6rem;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--text);
  resize: vertical;
}
.cell-reason:focus { outline: none; border-color: var(--accent); }
.cell-actions { display: flex; flex-direction: column; gap: 0.4rem; }
.cell-btn {
  font-family: inherit; font-size: 0.9rem; font-weight: 600;
  padding: 0.55rem 1rem;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--surface); color: var(--text);
  cursor: pointer;
  transition: all 0.12s;
}
.cell-btn:disabled { opacity: 0.5; cursor: default; }
.cell-btn.primary {
  background: rgb(22, 163, 74); color: white; border-color: rgb(22, 163, 74);
}
.cell-btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
.cell-btn.danger {
  background: var(--surface); color: var(--danger); border-color: var(--danger);
}
.cell-btn.danger:hover:not(:disabled) { background: var(--danger); color: white; }
.cell-btn.xs { font-size: 0.75rem; padding: 0.25rem 0.55rem; }

/* History list */
.history-list { max-height: 320px; overflow-y: auto; }
.history-row {
  display: grid;
  grid-template-columns: auto auto 1fr auto auto;
  gap: 0.6rem;
  align-items: center;
  padding: 0.55rem 1rem;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--border);
}
.history-row:last-child { border-bottom: none; }
.history-row:hover { background: var(--bg); }
.history-badge {
  font-size: 0.7rem; font-weight: 700;
  padding: 0.18rem 0.5rem; border-radius: 4px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.history-badge.add { background: rgba(34, 197, 94, 0.15); color: rgb(22, 163, 74); }
.history-badge.remove { background: rgba(234, 179, 8, 0.15); color: rgb(180, 130, 0); }
.history-date { font-weight: 600; white-space: nowrap; }
.history-reason {
  font-style: italic; color: var(--text-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.history-meta { font-size: 0.75rem; color: var(--text-dim); white-space: nowrap; }

@media (max-width: 768px) {
  .driver-grid { grid-template-columns: 1fr; }
  .detail-header { grid-template-columns: 1fr; gap: 0.75rem; }
  .month-nav { justify-content: stretch; }
  .month-select { flex: 1; }
  .month-banner { gap: 0.5rem; padding: 0.85rem; }
  .banner-stat { flex: 1; min-width: 0; }
  .banner-times, .banner-eq { display: none; }
  .banner-spacer { display: none; }
  .calendar-card { padding: 0.85rem; }
  .cal-row { gap: 0.2rem; }
  .cal-cell { padding: 0.25rem; font-size: 0.78rem; }
  .cal-load-count { font-size: 0.6rem; padding: 0.02rem 0.2rem; }
  .history-row { grid-template-columns: 1fr; gap: 0.2rem; padding: 0.7rem 1rem; }
  .history-meta { font-size: 0.7rem; }
}
</style>
