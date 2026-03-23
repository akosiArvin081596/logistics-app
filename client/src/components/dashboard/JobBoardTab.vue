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
          <tr v-for="job in paginatedItems" :key="job._rowIndex">
            <td v-for="col in displayCols" :key="col">
              <StatusBadge v-if="/status/i.test(col) && job[col]" :status="job[col]" />
              <template v-else>{{ job[col] || '' }}</template>
            </td>
            <td>
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
  </div>
</template>

<script setup>
import { computed, reactive } from 'vue'
import { usePagination } from '../../composables/usePagination'
import { useToast } from '../../composables/useToast'
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

const assignSelections = reactive({})

const jobsRef = computed(() => props.jobs)
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(jobsRef)

const displayCols = computed(() => {
  return pickDisplayCols(props.headers, ['load', 'status', 'broker', 'origin', 'pickup', 'destination', 'drop', 'rate', 'amount'])
})

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
