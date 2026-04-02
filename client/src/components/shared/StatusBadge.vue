<template>
  <span :class="classes">{{ status }}</span>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, default: '' },
})

const classes = computed(() => {
  const s = (props.status || '').trim().toLowerCase()
  if (/in.?transit/.test(s)) return 'status-badge-pill sb-blue'
  if (/dispatched|assigned/.test(s)) return 'status-badge-pill sb-indigo'
  if (/delivered|completed|pod.?received/.test(s)) return 'status-badge-pill sb-emerald'
  if (/at.?shipper|loading/.test(s)) return 'status-badge-pill sb-amber'
  if (/at.?receiver|unloading/.test(s)) return 'status-badge-pill sb-orange'
  if (/picked.?up/.test(s)) return 'status-badge-pill sb-cyan'
  if (/delayed/.test(s)) return 'status-badge-pill sb-red'
  if (/cancel/.test(s)) return 'status-badge-pill sb-red'
  return 'status-badge-pill sb-gray'
})
</script>
