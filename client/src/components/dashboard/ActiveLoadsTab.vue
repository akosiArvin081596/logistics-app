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
              <template v-else>{{ job[col] || '' }}</template>
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

const displayCols = computed(() => {
  const keywords = ['load', 'status', 'driver', 'broker', 'origin', 'pickup', 'destination', 'drop', 'rate', 'delivery']
  const matched = []
  for (const kw of keywords) {
    const re = new RegExp(kw, 'i')
    const col = props.headers.find((h) => re.test(h) && !matched.includes(h))
    if (col) matched.push(col)
  }
  if (matched.length < 3) return props.headers.slice(0, Math.min(8, props.headers.length))
  return matched
})
</script>
