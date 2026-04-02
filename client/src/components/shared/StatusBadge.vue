<template>
  <span :class="classes">{{ status }}</span>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, default: '' },
})

const classes = computed(() => {
  const base = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase whitespace-nowrap leading-5'
  const s = (props.status || '').trim().toLowerCase()

  if (/in.?transit/.test(s)) return `${base} bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-600/20`
  if (/dispatched|assigned/.test(s)) return `${base} bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-600/20`
  if (/delivered|completed|pod.?received/.test(s)) return `${base} bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20`
  if (/at.?shipper|loading/.test(s)) return `${base} bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20`
  if (/at.?receiver|unloading/.test(s)) return `${base} bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-600/20`
  if (/picked.?up/.test(s)) return `${base} bg-cyan-50 text-cyan-700 ring-1 ring-inset ring-cyan-600/20`
  if (/unassigned|new|open|pending/.test(s)) return `${base} bg-gray-100 text-gray-600 ring-1 ring-inset ring-gray-500/20`
  if (/on.?time/.test(s)) return `${base} bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20`
  if (/delayed/.test(s)) return `${base} bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20`
  if (/cancel/.test(s)) return `${base} bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20`
  return `${base} bg-gray-100 text-gray-600 ring-1 ring-inset ring-gray-500/20`
})
</script>
