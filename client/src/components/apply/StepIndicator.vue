<template>
  <div class="step-indicator">
    <div v-for="(step, i) in steps" :key="i" :class="['step', { active: i === current, done: i < current }]">
      <div class="step-dot">
        <template v-if="i < current">&#10003;</template>
        <template v-else>{{ i + 1 }}</template>
      </div>
      <div class="step-label">{{ step }}</div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  steps: { type: Array, required: true },
  current: { type: Number, default: 0 },
})
</script>

<style scoped>
.step-indicator {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  position: relative;
  margin-bottom: 2rem;
}
.step-indicator::before {
  content: '';
  position: absolute;
  top: 16px;
  left: 32px;
  right: 32px;
  height: 3px;
  background: #e2e4ea;
  z-index: 0;
}
.step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  z-index: 1;
  flex: 1;
}
.step-dot {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid #e2e4ea;
  background: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  font-weight: 700;
  color: #9ca3af;
  transition: all 0.25s;
}
.step.done .step-dot {
  background: hsl(199, 89%, 48%);
  border-color: hsl(199, 89%, 48%);
  color: white;
}
.step.active .step-dot {
  border-color: hsl(199, 89%, 48%);
  color: hsl(199, 89%, 48%);
  box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.12);
}
.step-label {
  font-size: 0.68rem;
  color: #9ca3af;
  text-align: center;
  font-weight: 500;
  max-width: 80px;
  line-height: 1.3;
}
.step.done .step-label,
.step.active .step-label {
  color: hsl(199, 89%, 48%);
  font-weight: 600;
}
@media (max-width: 640px) {
  .step-label { display: none; }
}
</style>
