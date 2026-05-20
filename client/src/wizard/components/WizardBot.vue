<template>
  <div class="wizard-bot" :class="[size, variant, { waving, 'no-anim': !animate }]" aria-hidden="true">
    <svg viewBox="0 0 120 130" xmlns="http://www.w3.org/2000/svg">
      <!-- Drop shadow -->
      <ellipse cx="60" cy="118" :rx="shadowRx" ry="4" :fill="shadowColor" />

      <!-- Antenna -->
      <line x1="60" y1="8" x2="60" y2="22" :stroke="accent" stroke-width="3" stroke-linecap="round" />
      <circle cx="60" cy="6" r="4" :fill="accent">
        <animate
          v-if="animate"
          attributeName="r"
          values="3.5;5;3.5"
          dur="1.8s"
          repeatCount="indefinite"
        />
      </circle>

      <!-- Head -->
      <rect x="18" y="22" width="84" height="74" rx="22" ry="22" :fill="bodyColor" />

      <!-- Inner visor background -->
      <rect x="26" y="34" width="68" height="38" rx="14" ry="14" :fill="visorColor" />

      <!-- Left eye -->
      <ellipse cx="46" cy="53" rx="5.5" ry="5.5" :fill="eyeColor">
        <animate
          v-if="animate"
          attributeName="ry"
          values="5.5;5.5;0.6;5.5"
          dur="4.8s"
          keyTimes="0;0.9;0.95;1"
          repeatCount="indefinite"
        />
      </ellipse>
      <circle cx="47.4" cy="51.4" r="1.4" fill="#fff" />

      <!-- Right eye -->
      <ellipse cx="74" cy="53" rx="5.5" ry="5.5" :fill="eyeColor">
        <animate
          v-if="animate"
          attributeName="ry"
          values="5.5;5.5;0.6;5.5"
          dur="4.8s"
          keyTimes="0;0.9;0.95;1"
          repeatCount="indefinite"
        />
      </ellipse>
      <circle cx="75.4" cy="51.4" r="1.4" fill="#fff" />

      <!-- Smile -->
      <path
        d="M 44 80 Q 60 88 76 80"
        :stroke="mouthColor"
        stroke-width="3"
        fill="none"
        stroke-linecap="round"
      />

      <!-- Side bolts -->
      <rect x="12" y="46" width="6" height="20" rx="2.5" :fill="accent" />
      <rect x="102" y="46" width="6" height="20" rx="2.5" :fill="accent" />

      <!-- Cheek status lights -->
      <circle cx="30" cy="72" r="2.5" fill="#22c55e">
        <animate
          v-if="animate"
          attributeName="opacity"
          values="1;0.3;1"
          dur="2.2s"
          repeatCount="indefinite"
        />
      </circle>
      <circle cx="90" cy="72" r="2.5" fill="#22c55e">
        <animate
          v-if="animate"
          attributeName="opacity"
          values="1;0.3;1"
          dur="2.2s"
          begin="1.1s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  size: {
    type: String,
    default: 'medium',
    validator: (v) => ['tiny', 'small', 'medium', 'large'].includes(v),
  },
  variant: {
    type: String,
    default: 'default',
    validator: (v) => ['default', 'light'].includes(v),
  },
  animate: { type: Boolean, default: true },
  waving: { type: Boolean, default: false },
});

const bodyColor = computed(() => (props.variant === 'light' ? '#e0ecff' : '#0f2847'));
const visorColor = computed(() => (props.variant === 'light' ? '#0f2847' : '#1a3a5c'));
const eyeColor = computed(() => '#60a5fa');
const mouthColor = computed(() => (props.variant === 'light' ? '#0f2847' : '#fff'));
const accent = computed(() => '#3b82f6');
const shadowColor = computed(() =>
  props.variant === 'light' ? 'rgba(15, 40, 71, 0.35)' : 'rgba(15, 23, 42, 0.18)'
);
const shadowRx = computed(() => 30);
</script>

<style scoped>
.wizard-bot {
  display: inline-block;
  line-height: 0;
}
.wizard-bot svg {
  width: 100%;
  height: auto;
  display: block;
  overflow: visible;
}

.wizard-bot.tiny { width: 24px; }
.wizard-bot.small { width: 34px; }
.wizard-bot.medium { width: 56px; }
.wizard-bot.large { width: 120px; }

.wizard-bot.waving svg {
  transform-origin: 60px 95px;
  animation: bot-wave 1.4s cubic-bezier(0.22, 1, 0.36, 1) 0.2s 1;
}

@keyframes bot-wave {
  0% { transform: rotate(0deg) translateY(0); }
  15% { transform: rotate(-9deg) translateY(-2px); }
  35% { transform: rotate(7deg) translateY(-1px); }
  55% { transform: rotate(-5deg) translateY(0); }
  75% { transform: rotate(3deg) translateY(0); }
  100% { transform: rotate(0deg) translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .wizard-bot.waving svg { animation: none; }
  .wizard-bot svg * { animation: none !important; }
}
</style>
