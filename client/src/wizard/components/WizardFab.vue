<template>
  <button
    class="wizard-fab"
    :class="{ 'has-progress': hasProgress }"
    type="button"
    aria-label="Open guided tour"
    @click="$emit('toggle')"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <span v-if="hasProgress" class="fab-dot" aria-hidden="true" />
  </button>
</template>

<script setup>
defineProps({
  hasProgress: { type: Boolean, default: false },
});
defineEmits(['toggle']);
</script>

<style scoped>
.wizard-fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  background: #0f2847;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(15, 40, 71, 0.35), 0 2px 6px rgba(15, 40, 71, 0.2);
  transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  z-index: 9997;
}
.wizard-fab:hover {
  background: #1a3a5c;
  transform: translateY(-2px);
  box-shadow: 0 12px 28px rgba(15, 40, 71, 0.45), 0 4px 10px rgba(15, 40, 71, 0.25);
}
.wizard-fab:focus-visible {
  outline: 3px solid #3b82f6;
  outline-offset: 3px;
}
.fab-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #22c55e;
  border: 2px solid #0f2847;
}
@media (max-width: 768px) {
  .wizard-fab {
    right: 16px;
    bottom: 16px;
    width: 52px;
    height: 52px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wizard-fab { transition: none; }
  .wizard-fab:hover { transform: none; }
}
</style>
