<template>
  <div class="p-4">
    <div class="flex gap-4 py-3 border-b border-gray-100">
      <div v-for="n in cols" :key="'h'+n" class="skeleton h-3 rounded-full skeleton-cell" :style="{ width: colWidth() }"></div>
    </div>
    <div v-for="r in rows" :key="r" class="flex gap-4 py-3.5" :style="{ opacity: 1 - (r * 0.12) }">
      <div v-for="n in cols" :key="n" class="skeleton h-3 rounded-full skeleton-cell" :style="{ width: colWidth() }"></div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  rows: { type: Number, default: 5 },
  cols: { type: Number, default: 6 },
})

function colWidth() {
  return Math.floor(10 + Math.random() * 15) + '%'
}
</script>
