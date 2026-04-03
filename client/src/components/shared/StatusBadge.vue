<template>
  <Badge variant="outline" :class="colorClass">{{ status }}</Badge>
</template>

<script setup>
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'

const props = defineProps({
  status: { type: String, default: '' },
})

const colorClass = computed(() => {
  const s = (props.status || '').trim().toLowerCase()
  if (/in.?transit/.test(s)) return 'bg-blue-100 text-blue-700 border-blue-200'
  if (/dispatched|assigned/.test(s)) return 'bg-indigo-100 text-indigo-700 border-indigo-200'
  if (/delivered|completed|pod.?received/.test(s)) return 'bg-emerald-100 text-emerald-700 border-emerald-200'
  if (/at.?shipper|loading/.test(s)) return 'bg-amber-100 text-amber-700 border-amber-200'
  if (/at.?receiver|unloading/.test(s)) return 'bg-orange-100 text-orange-700 border-orange-200'
  if (/picked.?up/.test(s)) return 'bg-cyan-100 text-cyan-700 border-cyan-200'
  if (/delayed/.test(s)) return 'bg-red-100 text-red-700 border-red-200'
  if (/cancel/.test(s)) return 'bg-red-100 text-red-700 border-red-200'
  return 'bg-gray-100 text-gray-600 border-gray-200'
})
</script>
