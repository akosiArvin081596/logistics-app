<template>
  <div class="admin-page">
    <div class="page-header">
      <h2>Data Cleanup Tools</h2>
      <p class="page-desc">Scan and fix data quality issues in Google Sheets and SQLite before connecting to the production database.</p>
      <!-- The scan-on-click tools below are for sheet/SQLite hygiene. The
           always-on detectors (duplicate receipts, rate cons with no load,
           failed onboarding documents, unattributed GPS, fuel range accuracy)
           are a standing queue rather than a scan, so they live on their own
           page. -->
      <router-link to="/admin/data-issues" class="cross-link">
        Data Issues &mdash; duplicate receipts and other detected problems &rarr;
      </router-link>
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

    <!-- Routemate ELD Integration -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <div class="section-dot" style="background: #16a34a;"></div>
          Routemate ELD Integration
        </div>
        <button
          class="btn btn-primary btn-sm"
          :disabled="rmSyncBusy || !rmHealth?.enabled"
          @click="runRoutemateSync"
        >{{ rmSyncBusy ? 'Syncing...' : 'Sync Vehicles Now' }}</button>
      </div>
      <div class="card-body">
        <div v-if="rmHealthLoading" class="scan-empty">Loading status...</div>
        <div v-else-if="!rmHealth" class="scan-empty">Status unavailable.</div>
        <div v-else>
          <div class="rm-status-grid">
            <div class="rm-status-row">
              <span class="rm-status-label">Kill switch</span>
              <span :class="['rm-pill', rmHealth.enabled ? 'rm-pill-on' : 'rm-pill-off']">
                {{ rmHealth.enabled ? 'ENABLED' : 'DISABLED' }}
              </span>
            </div>
            <div class="rm-status-row">
              <span class="rm-status-label">API key</span>
              <span :class="['rm-pill', rmHealth.hasKey ? 'rm-pill-on' : 'rm-pill-off']">
                {{ rmHealth.hasKey ? 'CONFIGURED' : 'MISSING' }}
              </span>
            </div>
            <div class="rm-status-row">
              <span class="rm-status-label">Base URL</span>
              <span class="rm-status-mono">{{ rmHealth.baseUrl || '—' }}</span>
            </div>
            <div class="rm-status-row">
              <span class="rm-status-label">Last vehicles sync</span>
              <span class="rm-status-mono">{{ formatRmTs(rmHealth.lastSync?.vehicles) }}</span>
            </div>
            <div class="rm-status-row">
              <span class="rm-status-label">Last telemetry sync</span>
              <span class="rm-status-mono">{{ formatRmTs(rmHealth.lastSync?.telemetry) }}</span>
            </div>
            <div class="rm-status-row">
              <span class="rm-status-label">Errors (last 24h)</span>
              <span :class="['rm-status-mono', rmHealth.errorsLast24h > 0 ? 'rm-error-text' : '']">
                {{ rmHealth.errorsLast24h ?? 0 }}
              </span>
            </div>
          </div>
          <div v-if="rmHealth.lastError" class="rm-last-error">
            <strong>{{ rmHealth.lastError.source || 'error' }}:</strong>
            {{ rmHealth.lastError.message }}
            <span v-if="rmHealth.lastError.status">(HTTP {{ rmHealth.lastError.status }})</span>
          </div>
          <p class="rm-help">
            Sync pulls the company vehicle inventory into LogisX so trucks can be linked
            to Routemate devices on the <code>/trucks</code> page. Live GPS auto-syncs every 60s
            once the kill switch is on.
          </p>
        </div>
      </div>
    </div>

    <!-- ScanKit Document Scanning -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <div class="section-dot" style="background: #7c3aed;"></div>
          ScanKit Document Scanning
        </div>
      </div>
      <div class="card-body">
        <div v-if="skHealthLoading" class="scan-empty">Loading status...</div>
        <div v-else-if="!skHealth" class="scan-empty">Status unavailable.</div>
        <div v-else>
          <div class="rm-status-grid">
            <div class="rm-status-row">
              <span class="rm-status-label">Kill switch</span>
              <span :class="['rm-pill', skHealth.enabled ? 'rm-pill-on' : 'rm-pill-off']">
                {{ skHealth.enabled ? 'ENABLED' : 'DISABLED' }}
              </span>
            </div>
            <div class="rm-status-row">
              <span class="rm-status-label">API key</span>
              <span :class="['rm-pill', skHealth.hasKey ? 'rm-pill-on' : 'rm-pill-off']">
                {{ skHealth.hasKey ? 'CONFIGURED' : 'MISSING' }}
              </span>
            </div>
            <div class="rm-status-row">
              <span class="rm-status-label">Base URL</span>
              <span class="rm-status-mono">{{ skHealth.baseUrl || '—' }}</span>
            </div>
            <div class="rm-status-row">
              <span class="rm-status-label">Last scan</span>
              <span class="rm-status-mono">{{ formatRmTs(skHealth.lastScan) }}</span>
            </div>
            <div class="rm-status-row">
              <span class="rm-status-label">Out of credits since</span>
              <span :class="['rm-status-mono', skHealth.noCreditsSince ? 'rm-error-text' : '']">
                {{ skHealth.noCreditsSince ? formatRmTs(skHealth.noCreditsSince) : '—' }}
              </span>
            </div>
            <div class="rm-status-row">
              <span class="rm-status-label">Errors (last 24h)</span>
              <span :class="['rm-status-mono', skHealth.errorsLast24h > 0 ? 'rm-error-text' : '']">
                {{ skHealth.errorsLast24h ?? 0 }}
              </span>
            </div>
          </div>
          <div v-if="skHealth.lastError" class="rm-last-error">
            <strong>{{ skHealth.lastError.code || 'error' }}:</strong>
            {{ skHealth.lastError.message }}
            <span v-if="skHealth.lastError.status">(HTTP {{ skHealth.lastError.status }})</span>
          </div>
          <p class="rm-help">
            ScanKit crops/deskews driver POD &amp; BOL scans. On 402 (out of credits) the app
            falls back to attaching the raw photo. Top up credits to restore scanning.
          </p>
        </div>
      </div>
    </div>

    <!-- Database Backup — the UI caller POST /api/db/download never had.
         ⚠️ Super Admin ONLY, and the v-if is not decoration. The route is
         requireRole("Super Admin") behind refuseCrossOriginStrict and
         dbAdminLimiter, so the server is the authority; this gate exists so the
         two agree, and so no other role is shown a control it cannot use. The
         /admin/tools route is already meta.roles: ['Super Admin'], which makes
         this the second of two independent client-side gates. -->
    <div v-if="isSuperAdmin" class="card">
      <div class="card-header">
        <div class="card-title">
          <div class="section-dot" style="background: var(--danger);"></div>
          Database Backup
        </div>
        <button
          class="btn btn-danger btn-sm"
          :disabled="dbExportBusy"
          @click="dbExportConfirmOpen = true"
        >{{ dbExportBusy ? 'Exporting…' : 'Download database backup' }}</button>
      </div>
      <div class="card-body">
        <p class="rm-help">
          Saves the whole SQLite database to your computer as a single file (~300&nbsp;MB) —
          every table, including <strong>Social Security and EIN numbers and bank routing and
          account numbers, in plain text</strong>. The file is not encrypted. Keep it wherever
          you would keep payroll records, and delete it when you are done. Every export is
          recorded on the audit trail.
        </p>

        <!-- Honest progress. The server runs a full db.backup() BEFORE it sends a
             single byte, so there is a real stretch where nothing is downloading
             and the UI would otherwise look hung — which is exactly when someone
             clicks again. The two phases are named separately for that reason. -->
        <div v-if="dbExportBusy" class="dbx-progress" role="status" aria-live="polite">
          <div class="dbx-progress-label">
            <span v-if="dbExportPhase === 'preparing'">Preparing the backup on the server…</span>
            <span v-else-if="dbExportTotal">
              Downloading — {{ fmtBytes(dbExportReceived) }} of {{ fmtBytes(dbExportTotal) }}
            </span>
            <span v-else>Downloading — {{ fmtBytes(dbExportReceived) }} so far</span>
            <span v-if="dbExportPhase === 'downloading' && dbExportTotal" class="dbx-pct">{{ dbExportPct }}%</span>
          </div>
          <div
            class="dbx-bar"
            role="progressbar"
            :aria-valuenow="dbExportTotal ? dbExportPct : undefined"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuetext="dbExportPhase === 'preparing' ? 'Preparing the backup on the server' : undefined"
          >
            <div
              :class="['dbx-bar-fill', { indeterminate: !dbExportTotal || dbExportPhase === 'preparing' }]"
              :style="dbExportTotal && dbExportPhase === 'downloading' ? { width: dbExportPct + '%' } : null"
            ></div>
          </div>
          <p class="dbx-note">Keep this tab open until it finishes.</p>
        </div>

        <div v-else-if="dbExportError" class="dbx-msg dbx-msg-error" role="alert">
          <strong>{{ dbExportErrorTitle }}</strong>
          <span>{{ dbExportError }}</span>
          <span v-if="dbExportHint" class="dbx-hint">{{ dbExportHint }}</span>
        </div>

        <div v-else-if="dbExportDone" class="dbx-msg dbx-msg-ok" role="status">
          <strong>Saved {{ dbExportDone.name }}</strong>
          <span>{{ fmtBytes(dbExportDone.bytes) }} written to your downloads folder.</span>
        </div>
      </div>
    </div>

    <!-- Business Configuration (Investor Settings) -->
    <ConfigPanel
      :config="investorStore.config"
      @save="handleSaveConfig"
    />

    <!-- Confirm-gated on the "Mark Paid" precedent: this is the one control on
         the page that puts every SSN, EIN and bank account in the system onto
         somebody's laptop, so it says so in as many words before it runs. -->
    <ConfirmModal
      :open="dbExportConfirmOpen"
      title="Download a full copy of the database?"
      :message="DB_EXPORT_CONFIRM"
      confirm-text="Download the backup"
      cancel-text="Cancel"
      danger
      @cancel="dbExportConfirmOpen = false"
      @confirm="startDbExport"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAdminToolsStore } from '../stores/adminTools'
import { useInvestorStore } from '../stores/investor'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import { useApi } from '../composables/useApi'
import ConfigPanel from '../components/investor/ConfigPanel.vue'
import ConfirmModal from '../components/shared/ConfirmModal.vue'

const store = useAdminToolsStore()
const investorStore = useInvestorStore()
const auth = useAuthStore()
const api = useApi()

const isSuperAdmin = computed(() => auth.isSuperAdmin)

const rmHealth = ref(null)
const rmHealthLoading = ref(true)
const rmSyncBusy = ref(false)

const skHealth = ref(null)
const skHealthLoading = ref(true)

async function loadRoutemateHealth() {
  rmHealthLoading.value = true
  try {
    rmHealth.value = await api.get('/api/routemate/health')
  } catch {
    rmHealth.value = null
  } finally {
    rmHealthLoading.value = false
  }
}

async function loadScanKitHealth() {
  try {
    skHealth.value = await api.get('/api/scankit/health')
  } catch {
    skHealth.value = null
  } finally {
    skHealthLoading.value = false
  }
}

async function runRoutemateSync() {
  if (rmSyncBusy.value) return
  rmSyncBusy.value = true
  try {
    const r = await api.post('/api/admin/routemate/sync-now', {})
    toast(`Synced ${r.vehiclesSynced} Routemate vehicle${r.vehiclesSynced === 1 ? '' : 's'}`)
    await loadRoutemateHealth()
  } catch (err) {
    toast(err?.message || 'Routemate sync failed', 'error')
    await loadRoutemateHealth()
  } finally {
    rmSyncBusy.value = false
  }
}

function formatRmTs(iso) {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const ageSec = Math.round((Date.now() - d.getTime()) / 1000)
  if (ageSec < 60) return `${ageSec}s ago`
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`
  return d.toLocaleString()
}

onMounted(() => {
  if (!investorStore.data) investorStore.load().catch(() => {})
  loadRoutemateHealth()
  loadScanKitHealth()
})
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

async function handleSaveConfig(cfg) {
  try {
    await investorStore.updateConfig(cfg)
    toast('Configuration saved')
  } catch {
    toast('Failed to save configuration', 'error')
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
  if (!confirm(
    `Permanently remove row ${row.row} (${row.rawId}, ${row.status}) from Job Tracking?\n\n` +
    'This deletes the row from the sheet and shifts every row below it up. It cannot be undone.'
  )) return
  try {
    // The reason is required and lands in the audit trail beside the deleted
    // cells. Naming the duplicate group is what makes the entry reconstructable
    // later — "removed as a duplicate of <load>" is the whole justification.
    await store.removeRows(
      'Job Tracking',
      [row.row],
      `Duplicate scanner: row ${row.row} removed as a duplicate of load ${group.loadId} (status ${row.status})`
    )
    toast(`Row ${row.row} removed`)
    group.rows = group.rows.filter((r) => r.row !== row.row)
    if (group.rows.length <= 1) {
      store.duplicates.groups = store.duplicates.groups.filter((g) => g.loadId !== group.loadId)
      store.duplicates.total = store.duplicates.groups.length
      store.duplicates.dangerous = store.duplicates.groups.filter((g) => g.dangerous).length
    }
  } catch (err) {
    // Surface the server's message. A row inside a finalized month comes back as
    // 409 PERIOD_FINALIZED naming the month and pointing at the reversible soft
    // delete; "Failed to remove row" would hide the one actionable part.
    toast((err && err.message) || 'Failed to remove row', 'error')
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

// GPS ping first/last seen on the stale-location scan. `driver_locations.timestamp`
// is a true instant (ISO-Z). Houston rule: America/Chicago + a visible zone
// label, so the window an admin is about to retag is stated in Houston time.
function formatDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return isNaN(d) ? ts : d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Chicago', timeZoneName: 'short',
  })
}

// Preview BEFORE confirming. The old flow asked "Rename X to Y everywhere?"
// with no idea what "everywhere" meant — on production that is ~45 sheet rows
// and ~700 SQLite rows for a single driver, most of them inside finalized
// months. The server's dry run reports exactly that and writes nothing.
async function fixName(oldName, newName) {
  let preview
  try {
    preview = await store.fixDriverName(oldName, newName, { dryRun: true })
  } catch (e) {
    toast(e.message || 'Could not preview the rename', 'error')
    return
  }

  const v = preview.verdict || {}
  const lines = [
    `Rename "${oldName}" to "${newName}" everywhere?`,
    '',
    `Job Tracking sheet: ${preview.plan?.sheet?.rows ?? 0} row(s)`,
    `Local database: ${v.totalSqliteRows ?? 0} row(s)`,
    '',
    v.caseOnly
      ? 'Case/spacing-only fix — no settlement figure can move.'
      : 'Substantive rename — this changes the key the pay math joins on.',
  ]
  // A merge is a different decision from a rename and used to look identical here.
  if (v.isMerge) lines.push('', `MERGE: "${newName}" already has ${v.mergeRows} row(s). The two drivers' histories are combined, and this CANNOT be undone by renaming back.`)

  let reason = ''
  if (v.decision === 'block' && v.code === 'PERIOD_FINALIZED') {
    lines.push('', 'THIS REACHES CLOSED ACCOUNTING MONTHS:')
    for (const b of v.blockers || []) lines.push(`  • ${b.detail} [${(b.periods || []).join(', ')}]`)
    lines.push('', 'It is applied to every target or none — a partial rename would silently')
    lines.push('restate those months. Continuing records the restatement on the audit trail.')
    if (!confirm(lines.join('\n'))) return
    reason = (prompt('Why is this rename necessary? (recorded on the audit trail, min 10 characters)') || '').trim()
    if (reason.length < 10) { toast('A reason of at least 10 characters is required', 'error'); return }
  } else if (v.decision === 'block') {
    toast(v.rationale || 'Rename refused', 'error')
    return
  } else if (!confirm(lines.join('\n'))) return

  try {
    const result = await store.fixDriverName(oldName, newName, {
      reason, acknowledgeLockedPeriods: !!reason,
    })
    toast(`Fixed ${result.fixed} sheet rows`)
    await runMismatchScan()
  } catch (e) {
    // Surface the server's message — a 409 lock refusal and a PARTIAL_RENAME
    // split are very different events and must not read identically.
    toast(e.message || 'Failed to fix name', 'error')
  }
}

// --- Database backup export ---------------------------------------------------
//
// POST /api/db/download had NO caller anywhere in client/ — admins reached it
// from the address bar, and PR #267 deliberately took that away. `SameSite=Lax`
// attaches the session cookie to a top-level cross-site GET *navigation*, and
// `Sec-Fetch-Site: none` (a bookmark, an address-bar paste, a link opened from
// Slack/Outlook/Mail/Teams) was indistinguishable from an admin's own bookmark —
// so one link could land a ~313 MB unencrypted copy of every SSN, EIN and bank
// account in the system in a Super Admin's Downloads folder. Making it a POST
// closes that class at the cookie. This is the caller that gives the capability
// back to the one shape a browser cannot be tricked into: a same-origin fetch
// from a page the admin is already on.
//
// ⚠️ NEVER RETRY THIS AS A GET. A plain GET is answered 405 by the app.all guard
// beside the route, and that guard exists because simply dropping the GET
// registration would let the request fall through to the SPA catch-all and be
// answered index.html + 200 — which reads as though the export were world
// readable. A 405 here means this client regressed into a link; it is surfaced
// as its own message rather than folded into a generic failure.
const DB_EXPORT_CONFIRM = [
  'This copies the entire database onto your computer as one unencrypted file (about 300 MB).',
  '',
  'It contains every Social Security and EIN number, and every bank routing and account number, in plain text — for every driver and every investor on the system.',
  '',
  'The export is recorded on the audit trail.',
].join('\n')

const dbExportConfirmOpen = ref(false)
const dbExportBusy = ref(false)
const dbExportPhase = ref('')        // '' | 'preparing' | 'downloading'
const dbExportReceived = ref(0)
const dbExportTotal = ref(0)
const dbExportError = ref('')
const dbExportErrorTitle = ref('')
const dbExportHint = ref('')
const dbExportDone = ref(null)       // { name, bytes }

const dbExportPct = computed(() => {
  if (!dbExportTotal.value) return 0
  return Math.min(100, Math.round((dbExportReceived.value / dbExportTotal.value) * 100))
})

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB'
  const mb = n / (1024 * 1024)
  if (mb < 1) return `${Math.round(n / 1024)} KB`
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

// The server names the file (res.download(tmpPath, "app.db")), so read it back off
// Content-Disposition rather than inventing one here — a filename that lives in two
// places drifts. Readable at all only because this is a same-origin response; a
// cross-origin one would need Access-Control-Expose-Headers, which is another
// reason the request must stay same-origin.
function filenameFromDisposition(header, fallback) {
  if (!header) return fallback
  // RFC 5987 `filename*=UTF-8''…` wins over plain `filename=` when both are sent.
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) } catch { /* fall through */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  const name = plain ? plain[1].trim() : ''
  // Never let a header choose a path — only a leaf name reaches link.download.
  return name ? name.replace(/[\\/]/g, '_') : fallback
}

// dbAdminLimiter is 10 per 15 minutes and sets Retry-After (seconds) plus draft-6
// RateLimit-Reset on a 429. "Request failed (429)" tells an admin nothing they can
// act on; the number of minutes is the entire actionable content of that response.
function retryAfterMinutes(res) {
  const raw = res.headers.get('Retry-After') || res.headers.get('RateLimit-Reset')
  const secs = Number(raw)
  // Retry-After may legally be an HTTP-date; express-rate-limit only ever emits
  // seconds, so anything non-numeric falls back to the vaguer wording rather than
  // rendering NaN.
  if (!Number.isFinite(secs) || secs <= 0) return 0
  return Math.max(1, Math.ceil(secs / 60))
}

function clearDbExportState() {
  dbExportError.value = ''
  dbExportErrorTitle.value = ''
  dbExportHint.value = ''
  dbExportDone.value = null
  dbExportReceived.value = 0
  dbExportTotal.value = 0
}

async function describeDbExportFailure(res) {
  let data = {}
  try { data = await res.json() } catch { data = {} }
  const s = res.status

  if (s === 429) {
    const mins = retryAfterMinutes(res)
    dbExportErrorTitle.value = 'Export limit reached.'
    dbExportError.value = 'Database admin requests are capped at 10 every 15 minutes.'
    dbExportHint.value = mins
      ? `Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`
      : 'Try again shortly.'
    return
  }
  if (s === 405) {
    dbExportErrorTitle.value = 'The server refused the request method.'
    dbExportError.value = 'The export accepts POST only, and this request was not one.'
    dbExportHint.value = 'Report this — it means the export button has regressed into a plain link.'
    return
  }
  if (s === 403) {
    dbExportErrorTitle.value = 'Refused.'
    dbExportError.value = data.error || 'The export is available to Super Admins, from this site only.'
    dbExportHint.value = 'Open LogisX directly rather than through a link from another site, then try again.'
    return
  }
  if (s === 401) {
    dbExportErrorTitle.value = 'Your session has expired.'
    dbExportError.value = data.error || 'Sign in again, then retry the export.'
    return
  }
  dbExportErrorTitle.value = `The export failed (${s}).`
  dbExportError.value = data.error || 'The server could not produce the backup.'
  dbExportHint.value = ''
}

async function startDbExport() {
  // Close the confirm and take the busy flag in the same synchronous tick, so
  // there is no window in which a second Enter or click can queue a second
  // 300 MB export. The trigger button is :disabled on the same flag, and the
  // early return below is the third layer.
  dbExportConfirmOpen.value = false
  if (dbExportBusy.value) return
  dbExportBusy.value = true
  dbExportPhase.value = 'preparing'
  clearDbExportState()

  try {
    // credentials: 'same-origin' — not 'include'. Both send the cookie for the
    // request this app actually makes; 'include' would ALSO attach it to a
    // cross-origin variant of this URL, which is the exact shape #267 removed.
    // No body and no Content-Type: the handler reads neither, and a bodyless
    // POST keeps the request as plain as it can be.
    const res = await fetch('/api/db/download', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/octet-stream' },
    })

    if (!res.ok) {
      await describeDbExportFailure(res)
      return
    }

    dbExportPhase.value = 'downloading'
    const declared = Number(res.headers.get('Content-Length'))
    dbExportTotal.value = Number.isFinite(declared) && declared > 0 ? declared : 0
    const name = filenameFromDisposition(res.headers.get('Content-Disposition'), 'app.db')

    // Streamed rather than res.blob() purely so the byte counter is real. The
    // memory cost is the same either way — the whole file lands in the tab before
    // it can be handed to a download anchor, which is the price of being able to
    // report a 429 as a 429 instead of navigating away and letting the browser
    // render the error JSON as a page.
    let blob
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      const chunks = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        dbExportReceived.value += value.byteLength
      }
      blob = new Blob(chunks, { type: res.headers.get('Content-Type') || 'application/octet-stream' })
      chunks.length = 0   // the Blob owns a copy now; drop ours rather than hold 300 MB twice
    } else {
      blob = await res.blob()
      dbExportReceived.value = blob.size
    }

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    // Deliberately NOT revoked synchronously: on a file this size some browsers
    // are still reading the blob when the click returns, and revoking under them
    // truncates the save. The delay only postpones GC of a buffer that already
    // exists.
    setTimeout(() => URL.revokeObjectURL(url), 60000)

    dbExportDone.value = { name, bytes: blob.size }
    toast(`Database backup saved (${fmtBytes(blob.size)})`)
  } catch (err) {
    // fetch() rejects on a dropped connection, and reader.read() rejects if the
    // transfer dies mid-stream. Both mean no usable file, so say that rather than
    // leaving a half-finished progress bar on screen.
    dbExportErrorTitle.value = 'The download did not complete.'
    dbExportError.value = err?.message || 'The connection dropped before the file finished transferring.'
    dbExportHint.value = 'Nothing was saved. Check your connection and try again.'
  } finally {
    dbExportBusy.value = false
    dbExportPhase.value = ''
  }
}
</script>

<style scoped>
.admin-page {
  flex: 0 0 auto;
}

.page-desc {
  font-size: 0.82rem;
  color: var(--text-dim);
  margin-top: 0.25rem;
  flex: 1;
  min-width: 200px;
  text-align: right;
}

/* Pointer to the standing detector queue. The header is a flex row, so this
   claims its own line rather than competing with the description for space. */
.cross-link {
  flex-basis: 100%;
  margin-top: 0.4rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--accent, #6d28d9);
  text-decoration: none;
}
.cross-link:hover { text-decoration: underline; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 1.25rem;
  overflow: hidden;
  flex-shrink: 0;
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
  overflow-x: auto;
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
  flex-wrap: wrap;
}

.dup-row:last-child {
  border-bottom: none;
}

.dup-row-num {
  font-weight: 600;
  color: var(--text-dim);
  min-width: 40px;
}

.dup-raw-id {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  min-width: 70px;
}

.dup-status {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  text-align: center;
  white-space: nowrap;
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
  margin-left: auto;
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

/* Routemate ELD status card */
.rm-status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.4rem 1rem;
  margin-bottom: 0.6rem;
}
.rm-status-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.35rem 0; border-bottom: 1px dashed var(--bg);
  font-size: 0.78rem;
}
.rm-status-label {
  color: var(--text-dim); font-weight: 600;
  text-transform: uppercase; font-size: 0.66rem; letter-spacing: 0.04em;
}
.rm-status-mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem; color: var(--text);
}
.rm-error-text { color: var(--danger); font-weight: 700; }
.rm-pill {
  font-size: 0.6rem; font-weight: 700; letter-spacing: 0.05em;
  padding: 2px 8px; border-radius: 10px;
}
.rm-pill-on { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
.rm-pill-off { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
.rm-last-error {
  margin-top: 0.5rem; padding: 0.55rem 0.75rem;
  background: #fef2f2; border: 1px solid #fecaca;
  border-radius: 6px; color: #991b1b; font-size: 0.78rem;
}
.rm-help {
  margin-top: 0.75rem; font-size: 0.75rem; color: var(--text-dim); line-height: 1.45;
}
.rm-help code {
  font-family: 'JetBrains Mono', monospace;
  background: var(--bg); padding: 1px 5px; border-radius: 4px; font-size: 0.72rem;
}

/* --- Database backup export --------------------------------------------- */
.dbx-progress {
  margin-top: 0.85rem;
}
.dbx-progress-label {
  display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem;
  font-size: 0.78rem; color: var(--text); margin-bottom: 0.4rem;
}
.dbx-pct {
  font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.dbx-bar {
  height: 6px; border-radius: 999px; background: var(--border); overflow: hidden;
}
.dbx-bar-fill {
  height: 100%; border-radius: 999px; background: var(--accent);
  transition: width 0.2s linear;
}
/* The server's db.backup() runs before a single byte is sent, so there is no
   percentage to show yet — and a bar frozen at 0% reads as "stuck" rather than
   "working". A sweep says the same thing honestly. */
.dbx-bar-fill.indeterminate {
  width: 35%; animation: dbx-sweep 1.3s ease-in-out infinite;
}
@keyframes dbx-sweep {
  0%   { margin-left: -35%; }
  100% { margin-left: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .dbx-bar-fill.indeterminate { animation: none; width: 100%; opacity: 0.45; }
  .dbx-bar-fill { transition: none; }
}
.dbx-note {
  margin-top: 0.4rem; font-size: 0.72rem; color: var(--text-dim);
}
.dbx-msg {
  margin-top: 0.85rem; padding: 0.55rem 0.75rem; border-radius: 6px;
  font-size: 0.78rem; display: flex; flex-direction: column; gap: 0.2rem;
}
.dbx-msg-error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
.dbx-msg-ok { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
.dbx-hint { opacity: 0.85; }
</style>
