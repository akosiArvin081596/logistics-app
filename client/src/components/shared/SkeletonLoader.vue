<template>
  <div class="skeleton-table">
    <div class="skeleton-row header">
      <div v-for="n in cols" :key="n" class="skeleton skeleton-cell" :style="{ width: colWidth() }"></div>
    </div>
    <div v-for="r in rows" :key="r" class="skeleton-row">
      <div v-for="n in cols" :key="n" class="skeleton skeleton-cell" :style="{ width: colWidth() }"></div>
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
