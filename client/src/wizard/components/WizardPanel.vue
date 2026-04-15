<template>
  <transition name="panel">
    <aside
      v-if="open"
      class="wizard-panel"
      :class="{ minimized }"
      role="dialog"
      aria-modal="false"
      :aria-labelledby="titleId"
    >
      <div
        v-if="minimized"
        class="minimized-tab"
        role="button"
        aria-label="Restore guide"
        tabindex="0"
        @mouseenter="$emit('restore')"
        @click="$emit('restore')"
        @keydown.enter="$emit('restore')"
      >
        <span class="tab-bar" aria-hidden="true" />
        <span class="tab-label">Guide</span>
      </div>
      <header class="panel-header">
        <div class="panel-brand">
          <div class="brand-mark">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div class="brand-text">
            <strong>LogisX Guide</strong>
            <span>Guided walkthrough</span>
          </div>
        </div>
        <button class="icon-btn" type="button" aria-label="Close guide" @click="$emit('close')">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div class="panel-progress">
        <div class="progress-label">
          <span>Step {{ progressIndex + 1 }}</span>
          <span>{{ progressPercent }}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: progressPercent + '%' }" />
        </div>
      </div>

      <div v-if="step" class="panel-body">
        <h3 :id="titleId" class="panel-title">{{ step.title }}</h3>
        <p class="panel-text" aria-live="polite">{{ step.body }}</p>

        <div v-if="step.examples?.length" class="panel-examples">
          <span class="examples-label">Examples</span>
          <ul>
            <li v-for="ex in step.examples" :key="ex">{{ ex }}</li>
          </ul>
        </div>

        <div v-if="step.faqLinks?.length" class="panel-faq-links">
          <button
            v-for="id in step.faqLinks"
            :key="id"
            type="button"
            class="faq-link"
            @click="$emit('open-faq', id)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>{{ faqLookup(id)?.q || 'Still confused?' }}</span>
          </button>
        </div>
      </div>

      <div v-else class="panel-body">
        <p class="panel-text">No step loaded.</p>
      </div>

      <footer class="panel-footer">
        <button
          type="button"
          class="btn-ghost"
          :disabled="!canGoBack"
          @click="$emit('back')"
        >
          Back
        </button>
        <button
          v-if="step?.canSkip"
          type="button"
          class="btn-ghost"
          @click="$emit('skip')"
        >
          Skip
        </button>
        <button
          type="button"
          class="btn-primary"
          @click="$emit('next')"
        >
          <span>{{ nextLabel }}</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </button>
      </footer>
    </aside>
  </transition>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  minimized: { type: Boolean, default: false },
  step: { type: Object, default: null },
  progressIndex: { type: Number, default: 0 },
  progressPercent: { type: Number, default: 0 },
  canGoBack: { type: Boolean, default: false },
  faqLookup: { type: Function, default: () => null },
});

defineEmits(['close', 'next', 'back', 'skip', 'open-faq', 'restore']);

const titleId = 'wizard-panel-title';
const nextLabel = computed(() => {
  if (!props.step) return 'Next';
  if (props.step.action === 'click') return 'Got it';
  if (props.step.action === 'info') return 'Next';
  return 'Next';
});
</script>

<style scoped>
.wizard-panel {
  position: fixed;
  top: 24px;
  right: 24px;
  width: 380px;
  max-width: calc(100vw - 48px);
  max-height: min(560px, calc(100vh - 140px));
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  box-shadow: 0 30px 60px -20px rgba(15, 23, 42, 0.35), 0 12px 24px -8px rgba(15, 23, 42, 0.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 9999;
  font-family: 'DM Sans', system-ui, sans-serif;
  color: #0f172a;
  transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease;
}
.wizard-panel.minimized {
  transform: translateX(calc(100% - 40px));
  pointer-events: none;
  box-shadow: 0 18px 40px -18px rgba(15, 23, 42, 0.28);
}
.wizard-panel.minimized .panel-header,
.wizard-panel.minimized .panel-progress,
.wizard-panel.minimized .panel-body,
.wizard-panel.minimized .panel-footer {
  opacity: 0.18;
  transition: opacity 0.25s ease;
}
.minimized-tab {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  cursor: pointer;
  pointer-events: auto;
  z-index: 20;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.88));
  border-right: 1px solid #eef2f7;
}
.tab-bar {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 54px;
  background: #3b82f6;
  border-radius: 0 4px 4px 0;
}
.tab-label {
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  writing-mode: vertical-rl;
  color: #3b82f6;
  letter-spacing: 0.14em;
  transform: rotate(180deg);
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  background: #0f2847;
  color: #fff;
}
.panel-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.brand-text strong {
  font-size: 0.95rem;
  font-weight: 600;
}
.brand-text span {
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.68);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.icon-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.75);
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.panel-progress {
  padding: 14px 18px 8px;
  border-bottom: 1px solid #f1f5f9;
  background: #fafbfd;
}
.progress-label {
  display: flex;
  justify-content: space-between;
  font-size: 0.72rem;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 6px;
}
.progress-bar {
  height: 6px;
  background: #e2e8f0;
  border-radius: 999px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #0f2847);
  transition: width 0.4s ease;
  border-radius: 999px;
}
.panel-body {
  padding: 20px 22px;
  overflow-y: auto;
  flex: 1;
}
.panel-title {
  margin: 0 0 10px;
  font-size: 1.25rem;
  font-weight: 600;
  line-height: 1.3;
  color: #0f172a;
}
.panel-text {
  margin: 0 0 18px;
  font-size: 0.94rem;
  line-height: 1.6;
  color: #475569;
}
.panel-examples {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 16px;
}
.examples-label {
  display: block;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 6px;
}
.panel-examples ul {
  margin: 0;
  padding-left: 16px;
  font-size: 0.85rem;
  color: #334155;
}
.panel-examples li { margin: 2px 0; }
.panel-faq-links {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.faq-link {
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 0.82rem;
  color: #475569;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.faq-link:hover {
  background: #f8fafc;
  border-color: #cbd5e1;
  color: #0f172a;
}
.panel-footer {
  display: flex;
  gap: 8px;
  padding: 14px 18px;
  border-top: 1px solid #f1f5f9;
  background: #fafbfd;
  justify-content: flex-end;
}
.btn-ghost, .btn-primary {
  padding: 9px 16px;
  border-radius: 10px;
  font-size: 0.88rem;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.btn-ghost {
  background: transparent;
  color: #64748b;
  border-color: #e2e8f0;
}
.btn-ghost:hover:not(:disabled) {
  background: #f1f5f9;
  color: #0f172a;
}
.btn-ghost:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn-primary {
  background: #0f2847;
  color: #fff;
}
.btn-primary:hover {
  background: #1a3a5c;
}
.btn-primary:focus-visible, .btn-ghost:focus-visible {
  outline: 3px solid #3b82f6;
  outline-offset: 2px;
}

.panel-enter-active, .panel-leave-active {
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease;
}
.panel-enter-from, .panel-leave-to {
  transform: translateX(20px);
  opacity: 0;
}

@media (max-width: 768px) {
  .wizard-panel {
    top: auto;
    right: 0;
    bottom: 0;
    left: 0;
    width: 100%;
    max-width: none;
    max-height: 60vh;
    border-radius: 18px 18px 0 0;
  }
  .panel-enter-from, .panel-leave-to {
    transform: translateY(20px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .panel-enter-active, .panel-leave-active {
    transition: opacity 0.2s ease;
  }
  .panel-enter-from, .panel-leave-to {
    transform: none;
  }
  .progress-fill { transition: none; }
  .wizard-panel { transition: opacity 0.2s ease; }
}
</style>
