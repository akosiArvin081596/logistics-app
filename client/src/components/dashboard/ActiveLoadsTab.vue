<template>
  <div>
    <div class="table-scroll">
      <table v-if="jobs.length > 0">
        <thead>
          <tr>
            <th v-for="col in displayCols" :key="col">{{ col }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in paginatedItems" :key="job._rowIndex" class="clickable-row" @click="openDetail(job)">
            <td v-for="col in displayCols" :key="col">
              <StatusBadge v-if="/status/i.test(col) && job[col]" :status="job[col]" />
              <template v-else>{{ cellValue(job, col) }}</template>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else>No active loads right now.</EmptyState>
    </div>
    <PaginationBar
      :page="page"
      :page-size="pageSize"
      :total="jobs.length"
      :total-pages="totalPages"
      @go="goTo"
      @size="setSize"
    />

    <!-- Load Detail Modal -->
    <Teleport to="body">
      <div v-if="selectedJob" class="modal-overlay" @click.self="selectedJob = null">
        <div class="detail-modal">
          <div class="modal-header">
            <div class="modal-title-row">
              <h3>{{ loadIdValue || 'Load Details' }}</h3>
              <StatusBadge v-if="statusValue" :status="statusValue" />
            </div>
            <button class="modal-close" @click="selectedJob = null">&times;</button>
          </div>

          <div class="modal-body">
            <template v-for="section in detailSections" :key="section.title">
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
import { computed, ref } from 'vue'
import { usePagination } from '../../composables/usePagination'
import StatusBadge from '../shared/StatusBadge.vue'
import EmptyState from '../shared/EmptyState.vue'
import PaginationBar from '../shared/PaginationBar.vue'

const props = defineProps({
  jobs: { type: Array, required: true },
  headers: { type: Array, required: true },
})

const jobsRef = computed(() => props.jobs)
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(jobsRef)

const selectedJob = ref(null)

function openDetail(job) {
  selectedJob.value = job
}

const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null)
const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)

const displayCols = computed(() => {
  const keywords = ['load', 'status', 'driver', 'origin', 'pickup', 'destination', 'drop', 'rate', 'delivery']
  const matched = []
  for (const kw of keywords) {
    const re = new RegExp(kw, 'i')
    const col = props.headers.find((h) => re.test(h) && !matched.includes(h))
    if (col) matched.push(col)
  }
  if (matched.length < 3) return props.headers.slice(0, Math.min(8, props.headers.length))
  return matched.filter(c => !brokerSourceCol.value || c !== brokerSourceCol.value)
                .filter(c => !phoneSourceCol.value || c !== phoneSourceCol.value)
})

function parseJsonCell(raw) {
  if (!raw || typeof raw !== 'string' || raw[0] !== '{') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function cellValue(job, col) {
  const val = job[col] || ''
  const parsed = parseJsonCell(val)
  if (parsed) {
    return parsed.Name || parsed.name || Object.values(parsed).filter(Boolean).join(' \u2022 ')
  }
  return val
}

function detailValue(job, col) {
  const val = job[col] || ''
  const parsed = parseJsonCell(val)
  if (parsed) {
    return Object.entries(parsed).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ')
  }
  return val
}

// Section grouping patterns
const sectionPatterns = [
  { title: 'Load Information', test: /load|job|id|status|driver|truck|trailer|equipment|type|commodity|weight|miles|details/i, wide: /details|commodity/i },
  { title: 'Route', test: /origin|pickup|shipper|dest|drop|receiver|delivery|consignee|city|state|zip|address|location/i, wide: /address/i },
  { title: 'Schedule', test: /date|time|pickup.*date|delivery.*date|appointment|eta|scheduled/i },
  { title: 'Financials', test: /rate|amount|revenue|pay|charge|price|cost|invoice|total/i },
]

const hiddenCols = /broker|phone|email|contact/i

const loadIdValue = computed(() => {
  if (!selectedJob.value) return ''
  const col = props.headers.find(h => /load.?id|job.?id/i.test(h))
  return col ? selectedJob.value[col] || '' : ''
})

const statusValue = computed(() => {
  if (!selectedJob.value) return ''
  const col = props.headers.find(h => /^status$/i.test(h) || /load.*status/i.test(h))
  return col ? selectedJob.value[col] || '' : ''
})

const detailSections = computed(() => {
  if (!selectedJob.value) return []
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
        fields.push({ col, value: detailValue(selectedJob.value, col), wide: sp.wide ? sp.wide.test(col) : false })
      }
    }
    sections.push({ title: sp.title, fields })
  }

  const remaining = []
  for (const col of props.headers) {
    if (used.has(col)) continue
    remaining.push({ col, value: detailValue(selectedJob.value, col), wide: false })
  }
  if (remaining.length) {
    sections.push({ title: 'Other Details', fields: remaining })
  }

  return sections.filter(s => s.fields.length > 0)
})
</script>

<style scoped>
.clickable-row {
  cursor: pointer;
  transition: background 0.15s;
}
.clickable-row:hover {
  background: var(--surface-hover, rgba(0, 0, 0, 0.04));
}

/* Modal overlay */
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
  max-width: 680px;
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
  gap: 0.75rem;
}
.modal-header h3 {
  font-size: 1.1rem;
  font-weight: 700;
  margin: 0;
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
