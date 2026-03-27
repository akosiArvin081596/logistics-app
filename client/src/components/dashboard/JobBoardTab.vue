<template>
  <div>
    <div class="table-scroll">
      <SkeletonLoader v-if="loading" />
      <table v-else-if="jobs.length > 0">
        <thead>
          <tr>
            <th v-for="col in displayCols" :key="col">{{ col }}</th>
            <th>Assign Driver</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in paginatedItems" :key="job._rowIndex" class="clickable-row" @click="openDetail(job)">
            <td v-for="col in displayCols" :key="col">
              <StatusBadge v-if="/status/i.test(col) && job[col]" :status="job[col]" />
              <template v-else>{{ cellValue(job, col) }}</template>
            </td>
            <td @click.stop>
              <div class="assign-cell">
                <select v-model="assignSelections[job._rowIndex]">
                  <option value="">Select driver</option>
                  <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
                </select>
                <button class="btn btn-primary btn-sm" @click="assign(job)">Assign</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else>All loads are assigned.</EmptyState>
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
            <h3>Load Details</h3>
            <button class="modal-close" @click="selectedJob = null">&times;</button>
          </div>
          <div class="modal-body">
            <div class="detail-grid">
              <div v-for="col in headers" :key="col" class="detail-field">
                <span class="detail-label">{{ col }}</span>
                <span class="detail-value">
                  <StatusBadge v-if="/status/i.test(col) && selectedJob[col]" :status="selectedJob[col]" />
                  <template v-else>{{ detailValue(selectedJob, col) || '—' }}</template>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { usePagination } from '../../composables/usePagination'
import { useToast } from '../../composables/useToast'
import { useAuthStore } from '../../stores/auth'
import StatusBadge from '../shared/StatusBadge.vue'
import EmptyState from '../shared/EmptyState.vue'
import PaginationBar from '../shared/PaginationBar.vue'
import SkeletonLoader from '../shared/SkeletonLoader.vue'

const props = defineProps({
  jobs: { type: Array, required: true },
  drivers: { type: Array, required: true },
  headers: { type: Array, required: true },
  loading: { type: Boolean, default: false },
})

const emit = defineEmits(['assign'])
const { show: toast } = useToast()
const auth = useAuthStore()

const assignSelections = reactive({})
const selectedJob = ref(null)

function openDetail(job) {
  selectedJob.value = job
}

function detailValue(job, col) {
  const val = job[col] || ''
  const parsed = parseJsonCell(val)
  if (parsed) {
    return Object.entries(parsed).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ')
  }
  return val
}

const jobsRef = computed(() => props.jobs)
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(jobsRef)

const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null)
const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)

const displayCols = computed(() => {
  const cols = pickDisplayCols(props.headers, ['load', 'status', 'origin', 'pickup', 'destination', 'drop', 'rate', 'amount'])
  // Remove any broker/phone columns that slipped through
  return cols.filter(c => !brokerSourceCol.value || c !== brokerSourceCol.value)
             .filter(c => !phoneSourceCol.value || c !== phoneSourceCol.value)
})

function parseBrokerContact(raw) {
  if (!raw) return { name: '', email: '', phone: '' }
  try {
    const parsed = JSON.parse(raw)
    return { name: parsed.Name || '', email: parsed.Email || '', phone: parsed.Phone || '' }
  } catch {
    return { name: raw, email: '', phone: '' }
  }
}

function parseJsonCell(raw) {
  if (!raw || typeof raw !== 'string' || raw[0] !== '{') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function cellValue(job, col) {
  if ((col === 'Broker Name' || col === 'Broker Email') && brokerSourceCol.value) {
    const broker = parseBrokerContact(job[brokerSourceCol.value])
    return col === 'Broker Name' ? broker.name : broker.email
  }
  if (col === 'Broker Phone') {
    const src = phoneSourceCol.value || brokerSourceCol.value
    if (src) {
      const broker = parseBrokerContact(job[src])
      return broker.phone || ''
    }
  }
  const val = job[col] || ''
  const parsed = parseJsonCell(val)
  if (parsed) {
    return parsed.Name || parsed.name || Object.values(parsed).filter(Boolean).join(' \u2022 ')
  }
  return val
}

function pickDisplayCols(headers, keywords) {
  if (!headers || headers.length === 0) return []
  const matched = []
  for (const kw of keywords) {
    const re = new RegExp(kw, 'i')
    const col = headers.find((h) => re.test(h) && !matched.includes(h))
    if (col) matched.push(col)
  }
  if (matched.length < 3) return headers.slice(0, Math.min(8, headers.length))
  return matched
}

function assign(job) {
  const driver = assignSelections[job._rowIndex]
  if (!driver) {
    toast('Select a driver first', 'error')
    return
  }
  emit('assign', { rowIndex: job._rowIndex, driver, job })
}
</script>

<style scoped>
.clickable-row {
  cursor: pointer;
  transition: background 0.15s;
}
.clickable-row:hover {
  background: var(--surface-hover, rgba(0, 0, 0, 0.04));
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}
.detail-modal {
  background: var(--surface);
  border-radius: 14px;
  width: 90%;
  max-width: 640px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
  animation: modalIn 0.2s ease-out;
}
@keyframes modalIn {
  from { transform: translateY(12px) scale(0.97); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--border);
}
.modal-header h3 {
  font-size: 1.05rem;
  font-weight: 700;
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
  font-size: 1.2rem;
  cursor: pointer;
  transition: all 0.12s;
}
.modal-close:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.modal-body {
  padding: 1.5rem;
}
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
.detail-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.detail-label {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.detail-value {
  font-size: 0.88rem;
  color: var(--text);
  word-break: break-word;
}
@media (max-width: 480px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
</style>
