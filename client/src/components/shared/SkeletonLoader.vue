<template>
  <div style="padding:1rem;">
    <div class="flex gap-4" style="padding:0.75rem 0;border-bottom:1px solid #f3f4f6;">
      <Skeleton v-for="n in cols" :key="'h'+n" class="h-3 rounded-full" :style="{ width: colWidth() }" />
    </div>
    <div v-for="r in rows" :key="r" class="flex gap-4" :style="{ padding: '0.875rem 0', opacity: 1 - (r * 0.12) }">
      <Skeleton v-for="n in cols" :key="n" class="h-3 rounded-full" :style="{ width: colWidth() }" />
    </div>
  </div>
</template>

<script setup>
import { Skeleton } from '@/components/ui/skeleton'

defineProps({
  rows: { type: Number, default: 5 },
  cols: { type: Number, default: 6 },
})

function colWidth() {
  return Math.floor(10 + Math.random() * 15) + '%'
}
</script>
