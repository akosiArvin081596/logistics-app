<template>
  <div v-if="rect" class="wizard-spotlight" :class="variant">
    <svg class="spot-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <mask id="spot-mask">
          <rect width="100%" height="100%" fill="white" />
          <rect
            :x="rect.x"
            :y="rect.y"
            :width="rect.width"
            :height="rect.height"
            rx="10"
            ry="10"
            fill="black"
          />
        </mask>
      </defs>
      <rect width="100%" height="100%" class="spot-dim" mask="url(#spot-mask)" />
    </svg>
    <div
      class="spot-ring"
      :style="{
        left: rect.x + 'px',
        top: rect.y + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
      }"
    />
  </div>
</template>

<script setup>
defineProps({
  rect: { type: Object, default: null },
  variant: { type: String, default: 'spotlight' },
});
</script>

<style scoped>
.wizard-spotlight {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9998;
}
.spot-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.spot-dim {
  fill: rgba(15, 23, 42, 0.55);
}
.spot-ring {
  position: absolute;
  border: 2px solid #3b82f6;
  border-radius: 10px;
  box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.25), 0 0 22px rgba(59, 130, 246, 0.45);
  pointer-events: none;
  animation: pulse-ring 1.8s ease-in-out infinite;
  transition: left 0.25s ease, top 0.25s ease, width 0.25s ease, height 0.25s ease;
}
@keyframes pulse-ring {
  0%, 100% {
    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.25), 0 0 22px rgba(59, 130, 246, 0.45);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(59, 130, 246, 0.15), 0 0 28px rgba(59, 130, 246, 0.6);
  }
}
.wizard-spotlight.pulse .spot-svg {
  display: none;
}
.wizard-spotlight.none {
  display: none;
}
@media (max-width: 768px) {
  .spot-dim {
    fill: rgba(15, 23, 42, 0.32);
  }
  .spot-ring {
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.22), 0 0 14px rgba(59, 130, 246, 0.4);
  }
  @keyframes pulse-ring {
    0%, 100% {
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.22), 0 0 14px rgba(59, 130, 246, 0.4);
    }
    50% {
      box-shadow: 0 0 0 6px rgba(59, 130, 246, 0.12), 0 0 18px rgba(59, 130, 246, 0.5);
    }
  }
}
@media (prefers-reduced-motion: reduce) {
  .spot-ring { animation: none; }
}
</style>
