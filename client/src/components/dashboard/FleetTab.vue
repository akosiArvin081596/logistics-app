<template>
  <div class="table-scroll">
    <div v-if="fleet.length > 0" class="fleet-grid">
      <div v-for="f in fleet" :key="f.Driver" class="fleet-card" @click="openDetail(f)">
        <div class="card-top">
          <div>
            <div class="driver-name">{{ f.Driver || 'Unknown' }}</div>
            <div class="truck-id">{{ f.Truck || 'No truck assigned' }}</div>
          </div>
          <span :class="['driver-status', f.Status === 'On Load' ? 'on-load' : 'available']">
            {{ f.Status }}
          </span>
        </div>
        <div class="card-bottom">
          <span class="fleet-stat">{{ f.CompletedLoads }} completed</span>
          <span v-if="f.CurrentLoad" class="load-id">{{ f.CurrentLoad }}</span>
        </div>
      </div>
    </div>
    <EmptyState v-else>No carriers found.</EmptyState>

    <!-- Driver Detail Modal -->
    <Teleport to="body">
      <div v-if="selected" class="modal-overlay" @click.self="selected = null">
        <div class="detail-modal">
          <div class="modal-header">
            <div class="modal-title-row">
              <div class="driver-avatar">{{ initials }}</div>
              <div>
                <h3>{{ selected.Driver || 'Unknown' }}</h3>
                <span class="truck-subtitle">{{ selected.Truck || 'No truck assigned' }}</span>
              </div>
            </div>
            <button class="modal-close" @click="selected = null">&times;</button>
          </div>

          <div class="modal-body">
            <!-- Status -->
            <div class="detail-section">
              <div class="section-label">Status</div>
              <div class="section-card">
                <div class="card-row">
                  <span class="field-label">Availability</span>
                  <span class="field-value">
                    <span :class="['driver-status', selected.Status === 'On Load' ? 'on-load' : 'available']">
                      {{ selected.Status }}
                    </span>
                  </span>
                </div>
                <div class="card-row">
                  <span class="field-label">Current Load</span>
                  <span class="field-value">
                    <a v-if="selected.CurrentLoad" class="load-link" @click.stop="openLoadDetail">{{ selected.CurrentLoad }}</a>
                    <template v-else>—</template>
                  </span>
                </div>
              </div>
            </div>

            <!-- Performance -->
            <div class="detail-section">
              <div class="section-label">Performance</div>
              <div class="section-card">
                <div class="card-row full-width">
                  <span class="field-label">Completed Loads</span>
                  <span class="field-value stat-value">{{ selected.CompletedLoads }}</span>
                </div>
              </div>
            </div>

            <!-- Contact -->
            <div v-if="selected.Phone" class="detail-section">
              <div class="section-label">Contact</div>
              <div class="section-card">
                <div class="card-row full-width">
                  <span class="field-label">Phone</span>
                  <span class="field-value">{{ selected.Phone }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Load Detail Modal -->
    <Teleport to="body">
      <div v-if="selectedLoad" class="modal-overlay load-overlay" @click.self="selectedLoad = null">
        <div class="detail-modal load-modal">
          <div class="modal-header">
            <div class="modal-title-row">
              <h3>{{ selectedLoadId || 'Load Details' }}</h3>
              <StatusBadge v-if="selectedLoadStatus" :status="selectedLoadStatus" />
            </div>
            <button class="modal-close" @click="selectedLoad = null">&times;</button>
          </div>
          <div class="modal-body">
            <template v-for="section in loadSections" :key="section.title">
              <div v-if="section.fields.length" class="detail-section">
                <div class="section-label">{{ section.title }}</div>
                <div class="section-card">
                  <div
                    v-for="field in section.fields"
                    :key="field.col"
                    :class="['card-row', { 'full-width': field.wide }]"
                  >
                    <span class="field-label">{{ field.col }}</span>
                    <span class="field-value">
                      <StatusBadge v-if="/status/i.test(field.col) && field.value" :status="field.value" />
                      <template v-else>{{ field.value || '—' }}</template>
                    </span>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import EmptyState from '../shared/EmptyState.vue'
import StatusBadge from '../shared/StatusBadge.vue'

const props = defineProps({
  fleet: { type: Array, required: true },
  activeJobs: { type: Array, default: () => [] },
  headers: { type: Array, default: () => [] },
})

const selected = ref(null)
const selectedLoad = ref(null)

function openDetail(f) {
  selected.value = f
}

function openLoadDetail() {
  if (!selected.value?.CurrentLoad || !props.headers.length) return
  const loadIdCol = props.headers.find(h => /load.?id|job.?id/i.test(h))
  if (!loadIdCol) return
  const job = props.activeJobs.find(j => (j[loadIdCol] || '').trim() === selected.value.CurrentLoad.trim())
  if (job) {
    selectedLoad.value = job
  }
}

const initials = computed(() => {
  if (!selected.value?.Driver) return '?'
  return selected.value.Driver.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2)
})

// Load detail helpers
function parseJsonCell(raw) {
  if (!raw || typeof raw !== 'string' || raw[0] !== '{') return null
  try { return JSON.parse(raw) } catch { return null }
}

function loadDetailValue(job, col) {
  const val = job[col] || ''
  const parsed = parseJsonCell(val)
  if (parsed) {
    return Object.entries(parsed).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ')
  }
  return val
}

const sectionPatterns = [
  { title: 'Load Information', test: /load|job|id|status|driver|truck|trailer|equipment|type|commodity|weight|miles|details/i, wide: /details|commodity/i },
  { title: 'Route', test: /origin|pickup|shipper|dest|drop|receiver|delivery|consignee|city|state|zip|address|location/i, wide: /address/i },
  { title: 'Schedule', test: /date|time|pickup.*date|delivery.*date|appointment|eta|scheduled/i },
  { title: 'Financials', test: /rate|amount|revenue|pay|charge|price|cost|invoice|total/i },
]

const hiddenCols = /broker|phone|email|contact/i

const selectedLoadId = computed(() => {
  if (!selectedLoad.value) return ''
  const col = props.headers.find(h => /load.?id|job.?id/i.test(h))
  return col ? selectedLoad.value[col] || '' : ''
})

const selectedLoadStatus = computed(() => {
  if (!selectedLoad.value) return ''
  const col = props.headers.find(h => /^status$/i.test(h) || /load.*status/i.test(h))
  return col ? selectedLoad.value[col] || '' : ''
})

const loadSections = computed(() => {
  if (!selectedLoad.value) return []
  const used = new Set()
  const sections = []

  for (const col of props.headers) {
    if (hiddenCols.test(col)) used.add(col)
  }

  for (const sp of sectionPatterns) {
    const fields = []
    for (const col of props.headers) {
      if (used.has(col)) continue
      if (sp.test.test(col)) {
        used.add(col)
        fields.push({ col, value: loadDetailValue(selectedLoad.value, col), wide: sp.wide ? sp.wide.test(col) : false })
      }
    }
    sections.push({ title: sp.title, fields })
  }

  const remaining = []
  for (const col of props.headers) {
    if (used.has(col)) continue
    remaining.push({ col, value: loadDetailValue(selectedLoad.value, col), wide: false })
  }
  if (remaining.length) sections.push({ title: 'Other Details', fields: remaining })

  return sections.filter(s => s.fields.length > 0)
})
</script>

<style scoped>
.fleet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
  padding: 1rem;
}
.fleet-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem;
  background: var(--surface);
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.fleet-card:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.07);
  border-color: var(--accent);
}
.card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.driver-name {
  font-weight: 700;
  font-size: 0.95rem;
  margin-bottom: 0.1rem;
}
.truck-id {
  font-size: 0.8rem;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
.driver-status {
  padding: 0.18rem 0.55rem;
  border-radius: 9999px;
  font-weight: 600;
  font-size: 0.72rem;
  white-space: nowrap;
  flex-shrink: 0;
}
.driver-status.available {
  background: #dcfce7;
  color: #166534;
}
.driver-status.on-load {
  background: #dbeafe;
  color: #1e40af;
}
.card-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.fleet-stat {
  font-size: 0.78rem;
  color: var(--text-dim);
}
.load-id {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--blue, #3b82f6);
  background: var(--blue-dim, #dbeafe);
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}
.detail-modal {
  background: var(--bg, #f5f6fa);
  border-radius: 16px;
  width: 92%;
  max-width: 480px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.18);
  animation: modalIn 0.25s ease-out;
}
@keyframes modalIn {
  from { transform: translateY(16px) scale(0.96); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}

/* Header */
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 1.5rem;
  background: var(--surface, #fff);
  border-bottom: 1px solid var(--border);
  border-radius: 16px 16px 0 0;
  flex-shrink: 0;
}
.modal-title-row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
}
.driver-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--accent, #6366f1);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.85rem;
  flex-shrink: 0;
}
.modal-header h3 {
  font-size: 1.05rem;
  font-weight: 700;
  margin: 0;
  line-height: 1.2;
}
.truck-subtitle {
  font-size: 0.78rem;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
.modal-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 1.3rem;
  cursor: pointer;
  transition: all 0.12s;
  flex-shrink: 0;
}
.modal-close:hover {
  background: var(--surface-hover, rgba(0,0,0,0.06));
  color: var(--text);
}

/* Body */
.modal-body {
  padding: 1.25rem 1.5rem 1.5rem;
  overflow-y: auto;
  flex: 1;
}

/* Sections */
.detail-section {
  margin-bottom: 1.25rem;
}
.detail-section:last-child {
  margin-bottom: 0;
}
.section-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text-dim, #8b8fa3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 0.5rem;
  padding-left: 0.15rem;
}
.section-card {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  overflow: hidden;
}
.card-row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--border, #e5e7eb);
  min-width: 0;
}
.card-row.full-width {
  grid-column: 1 / -1;
}
.section-card .card-row:last-child,
.section-card .card-row:nth-last-child(2):nth-child(odd) {
  border-bottom: none;
}
.field-label {
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-dim, #8b8fa3);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  line-height: 1;
}
.field-value {
  font-size: 0.88rem;
  font-weight: 500;
  color: var(--text, #1a1a2e);
  word-break: break-word;
  line-height: 1.35;
}
.stat-value {
  font-size: 1.25rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
}
.load-link {
  color: var(--blue, #3b82f6);
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  padding: 0.1rem 0.4rem;
  background: var(--blue-dim, #dbeafe);
  border-radius: 4px;
  transition: opacity 0.15s;
}
.load-link:hover {
  opacity: 0.8;
}
.load-overlay {
  z-index: 210;
}
.load-modal {
  max-width: 680px;
}

@media (max-width: 480px) {
  .detail-modal {
    width: 96%;
    max-height: 90vh;
    border-radius: 14px;
  }
  .modal-header {
    border-radius: 14px 14px 0 0;
  }
  .section-card {
    grid-template-columns: 1fr;
  }
  .card-row.full-width {
    grid-column: 1;
  }
  .modal-body {
    padding: 1rem;
  }
}
</style>
