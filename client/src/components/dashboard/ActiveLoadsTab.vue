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
          <tr v-for="job in paginatedItems" :key="job._rowIndex">
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
  </div>
</template>

<script setup>
import { computed } from 'vue'
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

const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null)
const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)

const displayCols = computed(() => {
  const keywords = ['load', 'status', 'driver', 'broker', 'phone', 'origin', 'pickup', 'destination', 'drop', 'rate', 'delivery']
  const matched = []
  for (const kw of keywords) {
    const re = new RegExp(kw, 'i')
    const col = props.headers.find((h) => re.test(h) && !matched.includes(h))
    if (col) matched.push(col)
  }
  if (matched.length < 3) return props.headers.slice(0, Math.min(8, props.headers.length))
  if (brokerSourceCol.value) {
    const idx = matched.indexOf(brokerSourceCol.value)
    if (idx !== -1) matched.splice(idx, 1, 'Broker Name', 'Broker Email')
  }
  // Replace phone column with virtual "Broker Phone" if it contains JSON
  if (phoneSourceCol.value) {
    const idx = matched.indexOf(phoneSourceCol.value)
    if (idx !== -1) matched.splice(idx, 1, 'Broker Phone')
  }
  return matched
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
</script>
