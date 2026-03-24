<template>
  <span :class="['status-badge', statusClass]">{{ status }}</span>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, default: '' },
})

const statusClass = computed(() => {
  const s = (props.status || '').trim().toLowerCase()
  if (/in.?transit/.test(s)) return 'in-transit'
  if (/dispatched/.test(s)) return 'dispatched'
  if (/assigned/.test(s)) return 'assigned'
  if (/delivered|completed/.test(s)) return 'delivered'
  if (/picked.?up|at shipper|loading/.test(s)) return 'picked-up'
  if (/unassigned|new|open|pending/.test(s)) return 'unassigned'
  if (/on.?time/.test(s)) return 'on-time'
  if (/delayed/.test(s)) return 'delayed'
  if (/at.?receiver/.test(s)) return 'picked-up'
  return 'default'
})
</script>
