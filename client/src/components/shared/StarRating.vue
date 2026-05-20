<template>
  <div class="star-rating">
    <span
      v-for="n in 5"
      :key="n"
      class="star"
      :class="{ filled: n <= modelValue, clickable: !readonly }"
      @click="!readonly && $emit('update:modelValue', n)"
    >&#9733;</span>
  </div>
</template>

<script setup>
defineProps({
  modelValue: { type: Number, default: 0 },
  readonly: { type: Boolean, default: false },
  size: { type: String, default: 'md' },
})
defineEmits(['update:modelValue'])
</script>

<style scoped>
.star-rating { display: flex; gap: 1px; }
.star { font-size: 1.1rem; color: #d1d5db; transition: color 0.1s; user-select: none; }
.star.filled { color: #f59e0b; }
.star.clickable { cursor: pointer; }
.star.clickable:hover { color: #fbbf24; }
</style>
