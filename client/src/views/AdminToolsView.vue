<template>
  <div class="admin-page">
    <div class="page-header">
      <h2>Data Cleanup Tools</h2>
      <p class="page-desc">Scan and fix data quality issues in Google Sheets and SQLite before connecting to the production database.</p>
    </div>

    <!-- Tool 1: Duplicate Load IDs -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <div class="section-dot" style="background: var(--danger);"></div>
          Duplicate Load IDs
        </div>
        <button class="btn btn-primary btn-sm" :disabled="store.scanningDuplicates" @click="runDupScan">
          {{ store.scanningDuplicates ? 'Scanning...' : 'Scan' }}
        </button>
      </div>

      <div v-if="store.duplicates" class="card-body">
        <div class="scan-summary">
          <span class="summary-item">{{ store.duplicates.total }} duplicate groups</span>
          <span v-if="store.duplicates.dangerous > 0" class="summary-item danger">{{ store.duplicates.dangerous }} dangerous (mixed statuses)</span>
          <span v-else class="summary-item ok">No dangerous duplicates</span>
        </div>

        <div v-if="store.duplicates.groups.length === 0" class="scan-empty">No duplicates found.</div>

        <div v-else class="dup-list">
          <div
            v-for="group in visibleDupGroups"
            :key="group.loadId"
            :class="['dup-group', { dangerous: group.dangerous }]"
          >
            <div class="dup-group-header">
              <span class="dup-load-id">{{ group.loadId }}</span>
              <span class="dup-count">{{ group.rows.length }} rows</span>
              <span v-if="group.dangerous" class="badge badge-danger">Mixed statuses</span>
            </div>
            <div class="dup-rows">
              <div v-for="row in group.rows" :key="row.row" class="dup-row">
                <span class="dup-row-num">Row {{ row.row }}</span>
                <span class="dup-raw-id">{{ row.rawId }}</span>
                <span :class="['dup-status', statusClass(row.status)]">{{ row.status }}</span>
                <span class="dup-driver">{{ row.driver }}</span>
                <button
                  v-if="canRemoveRow(group, row)"
                  class="btn btn-danger btn-xs"
                  @click="removeRow(group, row)"
                >Remove</button>
                <span v-else class="dup-keep">Keep</span>
              </div>
            </div>
          </div>
          <button
            v-if="store.duplicates.groups.length > dupShowCount"
            class="btn btn-secondary btn-sm show-more"
            @click="dupShowCount += 20"
          >Show more ({{ store.duplicates.groups.length - dupShowCount }} remaining)</button>
        </div>
      </div>
    </div>

    <!-- Tool 2: Driver Name Mismatches -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <div class="section-dot" style="background: var(--amber);"></div>
          Driver Name Mismatches
        </div>
        <button class="btn btn-primary btn-sm" :disabled="store.scanningMismatches" @click="runMismatchScan">
          {{ store.scanningMismatches ? 'Scanning...' : 'Scan' }}
        </button>
      </div>

      <div v-if="store.driverMismatches" class="card-body">
        <div v-if="store.driverMismatches.mismatches.length === 0" class="scan-empty">No mismatches found.</div>

        <div v-else class="mismatch-list">
          <div v-for="m in store.driverMismatches.mismatches" :key="m.name" class="mismatch-item">
            <div class="mismatch-header">
              <span class="mismatch-name">{{ m.name }}</span>
              <span v-if="m.sheetCount" class="mismatch-count">{{ m.sheetCount }} rows in sheet</span>
            </div>
            <div class="mismatch-details">
              <div v-if="m.carrierName" class="detail-row">
                <span class="detail-label">Carrier DB:</span>
                <span>{{ m.carrierName }}</span>
              </div>
              <div v-if="m.sheetName" class="detail-row">
                <span class="detail-label">Sheet:</span>
                <span>{{ m.sheetName }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">User account:</span>
                <span>{{ m.userAccount ? `${m.userAccount} (${m.userDriverName})` : 'None' }}</span>
              </div>
              <div class="mismatch-issues">
                <span v-for="issue in m.issues" :key="issue" class="issue-tag">{{ issue }}</span>
              </div>
            </div>
            <div v-if="m.carrierName && m.sheetName && m.carrierName !== m.sheetName" class="mismatch-actions">
              <button class="btn btn-primary btn-xs" @click="fixName(m.carrierName, m.sheetName)">
                Rename "{{ m.carrierName }}" to "{{ m.sheetName }}"
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tool 3: Orphan Records -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <div class="section-dot" style="background: var(--blue);"></div>
          Orphan Records (SQLite)
        </div>
        <button class="btn btn-primary btn-sm" :disabled="store.scanningOrphans" @click="runOrphanScan">
          {{ store.scanningOrphans ? 'Scanning...' : 'Scan' }}
        </button>
      </div>

      <div v-if="store.orphans" class="card-body">
        <div class="scan-summary">
          <span class="detail-label">Known drivers:</span>
          <span>{{ store.orphans.knownDrivers.join(', ') || 'None' }}</span>
        </div>

        <div v-if="store.orphans.orphans.length === 0" class="scan-empty">No orphan records found.</div>

        <div v-else class="orphan-list">
          <div v-for="o in store.orphans.orphans" :key="o.table" class="orphan-item">
            <div class="orphan-header">
              <span class="orphan-table">{{ o.table }}</span>
              <span class="orphan-col">({{ o.column }})</span>
            </div>
            <div v-for="r in o.records" :key="r.name" class="orphan-record">
              <span class="orphan-name">"{{ r.name }}"</span>
              <span class="orphan-count">{{ r.count }} records</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tool 4: Stale Location Data -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <div class="section-dot" style="background: var(--accent);"></div>
          Stale Location Data
        </div>
        <button class="btn btn-primary btn-sm" :disabled="store.scanningStaleLocations" @click="runStaleScan">
          {{ store.scanningStaleLocations ? 'Scanning...' : 'Scan' }}
        </button>
      </div>

      <div v-if="store.staleLocations" class="card-body">
        <div class="scan-summary">
          <span class="summary-item" :class="store.staleLocations.issues.length > 0 ? 'danger' : 'ok'">
            {{ store.staleLocations.issues.length }} issue{{ store.staleLocations.issues.length !== 1 ? 's' : '' }} found
          </span>
        </div>

        <div v-if="store.staleLocations.issues.length === 0" class="scan-empty">All GPS pings match their loads in Google Sheets.</div>

        <div v-else class="stale-list">
          <div v-for="issue in store.staleLocations.issues" :key="issue.driver + issue.sqliteLoadId" class="stale-item">
            <div class="stale-header">
              <span class="stale-driver">{{ issue.driver }}</span>
              <span class="stale-pings">{{ issue.pings }} GPS pings</span>
            </div>
            <div class="stale-details">
              <div class="detail-row">
                <span class="detail-label">SQLite load_id:</span>
                <span class="mono">{{ issue.sqliteLoadId }}</span>
                <span :class="['dup-status', statusClass(issue.sheetStatus)]">{{ issue.sheetStatus }}</span>
              </div>
              <div v-if="issue.sheetDetails" class="detail-row">
                <span class="detail-label">Sheet route:</span>
                <span>{{ issue.sheetDetails }}</span>
              </div>
              <div v-if="issue.avgLat" class="detail-row">
                <span class="detail-label">GPS avg position:</span>
                <span class="mono">{{ issue.avgLat }}, {{ issue.avgLng }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Time range:</span>
                <span>{{ formatDate(issue.firstPing) }} — {{ formatDate(issue.lastPing) }}</span>
              </div>
              <div class="stale-problems">
                <span v-for="p in issue.problems" :key="p" class="issue-tag">{{ p }}</span>
              </div>
            </div>
            <div v-if="issue.suggestedLoadId" class="stale-actions">
              <button class="btn btn-primary btn-xs" @click="fixStale(issue)">
                Retag {{ issue.pings }} pings → {{ issue.suggestedLoadId }}
              </button>
              <span v-if="issue.suggestedDetails" class="stale-suggested-detail">{{ issue.suggestedDetails }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useAdminToolsStore } from '../stores/adminTools'
import { useToast } from '../composables/useToast'

const store = useAdminToolsStore()
const { show: toast } = useToast()
const dupShowCount = ref(20)

const visibleDupGroups = computed(() =>
  store.duplicates ? store.duplicates.groups.slice(0, dupShowCount.value) : []
)

async function runDupScan() {
  try {
    await store.scanDuplicates()
    dupShowCount.value = 20
    toast(`Found ${store.duplicates.total} duplicate groups`)
  } catch {
    toast('Scan failed', 'error')
  }
}

async function runMismatchScan() {
  try {
    await store.scanDriverMismatches()
    const count = store.driverMismatches.mismatches.length
    toast(count > 0 ? `Found ${count} mismatches` : 'No mismatches found')
  } catch {
    toast('Scan failed', 'error')
  }
}

async function runOrphanScan() {
  try {
    await store.scanOrphans()
    const count = store.orphans.orphans.length
    toast(count > 0 ? `Found ${count} tables with orphans` : 'No orphan records')
  } catch {
    toast('Scan failed', 'error')
  }
}

function statusClass(status) {
  const s = status.toLowerCase()
  if (/completed|delivered|pod received/i.test(s)) return 'status-completed'
  if (/assigned|dispatched/i.test(s)) return 'status-active'
  if (/canceled/i.test(s)) return 'status-canceled'
  return 'status-empty'
}

function canRemoveRow(group, row) {
  if (!group.dangerous) return false
  const s = row.status.toLowerCase()
  return /completed|delivered|pod received|canceled|\(empty\)/i.test(s)
}

async function removeRow(group, row) {
  if (!confirm(`Remove row ${row.row} (${row.rawId}, ${row.status}) from Job Tracking?`)) return
  try {
    await store.removeRows('Job Tracking', [row.row])
    toast(`Row ${row.row} removed`)
    group.rows = group.rows.filter((r) => r.row !== row.row)
    if (group.rows.length <= 1) {
      store.duplicates.groups = store.duplicates.groups.filter((g) => g.loadId !== group.loadId)
      store.duplicates.total = store.duplicates.groups.length
      store.duplicates.dangerous = store.duplicates.groups.filter((g) => g.dangerous).length
    }
  } catch {
    toast('Failed to remove row', 'error')
  }
}

async function runStaleScan() {
  try {
    await store.scanStaleLocations()
    const count = store.staleLocations.issues.length
    toast(count > 0 ? `Found ${count} stale location issue${count !== 1 ? 's' : ''}` : 'No stale location data')
  } catch {
    toast('Scan failed', 'error')
  }
}

async function fixStale(issue) {
  if (!confirm(`Retag ${issue.pings} GPS pings for ${issue.driver} from load ${issue.sqliteLoadId} to ${issue.suggestedLoadId}?`)) return
  try {
    const result = await store.fixStaleLocation(issue.driver, issue.sqliteLoadId, issue.suggestedLoadId)
    toast(`Updated ${result.updated} location records`)
    await runStaleScan()
  } catch {
    toast('Failed to fix stale locations', 'error')
  }
}

function formatDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return isNaN(d) ? ts : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

async function fixName(oldName, newName) {
  if (!confirm(`Rename "${oldName}" to "${newName}" everywhere?`)) return
  try {
    const result = await store.fixDriverName(oldName, newName)
    toast(`Fixed ${result.fixed} sheet rows`)
    await runMismatchScan()
  } catch {
    toast('Failed to fix name', 'error')
  }
}
</script>

<style scoped>
.page-desc {
  font-size: 0.82rem;
  color: var(--text-dim);
  margin-top: 0.25rem;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 1.25rem;
  overflow: hidden;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}

.card-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 700;
  font-size: 0.88rem;
}

.section-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.card-body {
  padding: 1rem 1.25rem;
}

.scan-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1rem;
  font-size: 0.82rem;
}

.summary-item {
  padding: 0.25rem 0.6rem;
  border-radius: 6px;
  font-weight: 600;
  background: var(--bg);
}

.summary-item.danger {
  background: var(--danger-dim);
  color: var(--danger);
}

.summary-item.ok {
  background: var(--accent-dim);
  color: var(--accent);
}

.scan-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.82rem;
  padding: 1.5rem 0;
}

/* Duplicates */
.dup-group {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 0.75rem;
  overflow: hidden;
}

.dup-group.dangerous {
  border-color: var(--danger);
  border-left-width: 3px;
}

.dup-group-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
  background: var(--bg);
  font-size: 0.82rem;
}

.dup-load-id {
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
}

.dup-count {
  color: var(--text-dim);
  font-size: 0.72rem;
}

.badge {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.badge-danger {
  background: var(--danger-dim);
  color: var(--danger);
}

.dup-rows {
  padding: 0.4rem 0.85rem;
}

.dup-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.35rem 0;
  font-size: 0.78rem;
  border-bottom: 1px solid var(--border);
}

.dup-row:last-child {
  border-bottom: none;
}

.dup-row-num {
  font-weight: 600;
  color: var(--text-dim);
  min-width: 50px;
}

.dup-raw-id {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  min-width: 90px;
}

.dup-status {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  min-width: 70px;
  text-align: center;
}

.status-completed { background: var(--accent-dim); color: var(--accent); }
.status-active { background: var(--blue-dim); color: var(--blue); }
.status-canceled { background: var(--danger-dim); color: var(--danger); }
.status-empty { background: var(--bg); color: var(--text-dim); }

.dup-driver {
  flex: 1;
  font-size: 0.75rem;
  color: var(--text-dim);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dup-keep {
  font-size: 0.7rem;
  color: var(--accent);
  font-weight: 600;
}

.show-more {
  width: 100%;
  margin-top: 0.5rem;
}

/* Mismatches */
.mismatch-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.85rem;
  margin-bottom: 0.75rem;
}

.mismatch-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.mismatch-name {
  font-weight: 700;
  font-size: 0.88rem;
}

.mismatch-count {
  font-size: 0.72rem;
  color: var(--text-dim);
}

.mismatch-details {
  font-size: 0.78rem;
}

.detail-row {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 0.2rem;
}

.detail-label {
  font-weight: 600;
  color: var(--text-dim);
  min-width: 90px;
}

.mismatch-issues {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.5rem;
}

.issue-tag {
  font-size: 0.68rem;
  background: var(--amber-dim);
  color: #92400e;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  font-weight: 500;
}

.mismatch-actions {
  margin-top: 0.6rem;
}

/* Orphans */
.orphan-item {
  margin-bottom: 0.75rem;
}

.orphan-header {
  font-weight: 600;
  font-size: 0.82rem;
  margin-bottom: 0.3rem;
}

.orphan-table {
  font-family: 'JetBrains Mono', monospace;
}

.orphan-col {
  color: var(--text-dim);
  font-size: 0.72rem;
}

.orphan-record {
  display: flex;
  gap: 0.5rem;
  font-size: 0.78rem;
  padding: 0.2rem 0 0.2rem 1rem;
}

.orphan-name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
}

.orphan-count {
  color: var(--text-dim);
}

/* Stale locations */
.stale-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  border-left: 3px solid var(--danger);
  padding: 0.85rem;
  margin-bottom: 0.75rem;
}

.stale-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.stale-driver {
  font-weight: 700;
  font-size: 0.88rem;
}

.stale-pings {
  font-size: 0.72rem;
  color: var(--text-dim);
}

.stale-details {
  font-size: 0.78rem;
}

.stale-problems {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.5rem;
}

.stale-actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.6rem;
}

.stale-suggested-detail {
  font-size: 0.72rem;
  color: var(--text-dim);
}

.mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
}

/* Buttons */
.btn {
  padding: 0.45rem 0.85rem;
  border: none;
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn:hover { opacity: 0.9; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-secondary { background: var(--bg); border: 1px solid var(--border); color: var(--text-dim); }
.btn-danger { background: var(--danger); color: #fff; }
.btn-sm { padding: 0.35rem 0.7rem; font-size: 0.75rem; }
.btn-xs { padding: 0.2rem 0.5rem; font-size: 0.7rem; }
</style>
