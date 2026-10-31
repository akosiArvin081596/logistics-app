<template>
  <!-- A fresh signature a Super Admin asked for (ONBOARDING_RESIGN_ENABLED): one row per
       document, each opening the signing window. DriverView renders this only when the
       payload marks a document with resign_requested. -->
  <section class="card resign-card" :aria-labelledby="titleId">
    <div class="resign-header">
      <div class="resign-icon" aria-hidden="true">&#9997;</div>
      <h3 :id="titleId" class="resign-title">Please sign again</h3>
    </div>
    <div v-for="doc in docs" :key="doc.doc_key" class="resign-row">
      <p class="resign-text">{{ cardText(doc) }}</p>
      <button type="button" class="resign-btn" @click="emit('sign', doc)">Sign again</button>
    </div>
  </section>
</template>

<script setup>
import { useId } from 'vue'
import { cardText } from '../../lib/resignRequest'

defineProps({
  // The documents the payload marks with resign_requested (requestedDocs()).
  docs: { type: Array, required: true },
})
const emit = defineEmits(['sign'])
const titleId = useId()
</script>

<style scoped>
.resign-card {
  margin-bottom: 0.75rem;
  border: 1px solid rgba(245, 158, 11, 0.35);
}
.resign-header {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin-bottom: 0.6rem;
}
.resign-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--amber-dim);
  color: #92400e;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  flex-shrink: 0;
}
.resign-title {
  font-size: 0.95rem;
  font-weight: 700;
  margin: 0;
}
.resign-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.7rem 0.85rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  min-width: 0;
}
.resign-row + .resign-row {
  margin-top: 0.5rem;
}
.resign-text {
  font-size: 0.85rem;
  line-height: 1.4;
  margin: 0;
  overflow-wrap: anywhere;
}
.resign-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: var(--radius, 8px);
  background: #0f2847;
  color: #fff;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 700;
  cursor: pointer;
}
.resign-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (min-width: 768px) {
  .resign-btn {
    width: auto;
    align-self: flex-start;
    padding: 0.5rem 1.25rem;
  }
}
</style>
