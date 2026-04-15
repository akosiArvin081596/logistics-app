<template>
  <button
    class="wizard-fab"
    :class="{ 'has-progress': hasProgress, 'is-hidden': hidden }"
    type="button"
    aria-label="Open guided tour"
    :aria-hidden="hidden"
    :tabindex="hidden ? -1 : 0"
    @click="$emit('toggle')"
  >
    <WizardBot size="medium" variant="light" />
    <span v-if="hasProgress" class="fab-dot" aria-hidden="true" />
  </button>
</template>

<script setup>
import WizardBot from './WizardBot.vue';

defineProps({
  hasProgress: { type: Boolean, default: false },
  hidden: { type: Boolean, default: false },
});
defineEmits(['toggle']);
</script>

<style scoped>
.wizard-fab {
  position: fixed;
  left: 24px;
  bottom: calc(24px + var(--wizard-kb-offset, 0px) + env(safe-area-inset-bottom, 0px));
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: none;
  background: linear-gradient(145deg, #1a3a5c, #0f2847);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 6px;
  box-shadow: 0 10px 28px rgba(15, 40, 71, 0.4), 0 2px 8px rgba(15, 40, 71, 0.2);
  transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease, bottom 0.25s ease;
  z-index: 9997;
}
.wizard-fab:hover {
  background: linear-gradient(145deg, #22507d, #122f52);
  transform: translateY(-3px);
  box-shadow: 0 14px 32px rgba(15, 40, 71, 0.5), 0 4px 12px rgba(15, 40, 71, 0.28);
}
.wizard-fab.is-hidden {
  opacity: 0;
  transform: scale(0.8) translateY(8px);
  pointer-events: none;
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
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
}
@media (max-width: 768px) {
  .wizard-fab {
    left: 16px;
    bottom: calc(16px + var(--wizard-kb-offset, 0px) + env(safe-area-inset-bottom, 0px));
    width: 58px;
    height: 58px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wizard-fab { transition: none; }
  .wizard-fab:hover { transform: none; }
}
</style>
