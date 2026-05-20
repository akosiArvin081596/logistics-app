<template>
  <div v-if="show" class="wizard-resume" role="status">
    <div class="resume-body">
      <div class="resume-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      </div>
      <div class="resume-text">
        <strong>Welcome back!</strong>
        <span>You were in the middle of the guided tour. Want to pick up where you left off?</span>
      </div>
    </div>
    <div class="resume-actions">
      <button type="button" class="btn-secondary" @click="$emit('dismiss')">Dismiss</button>
      <button type="button" class="btn-primary" @click="$emit('resume')">Resume tour</button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  show: { type: Boolean, default: false },
});
defineEmits(['resume', 'dismiss']);
</script>

<style scoped>
.wizard-resume {
  position: fixed;
  top: 24px;
  right: 24px;
  max-width: 420px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 16px 18px;
  box-shadow: 0 20px 45px -15px rgba(15, 23, 42, 0.3), 0 8px 20px -8px rgba(15, 23, 42, 0.15);
  z-index: 9999;
  font-family: 'DM Sans', system-ui, sans-serif;
  animation: slide-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}
.resume-body {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}
.resume-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #eff6ff;
  color: #3b82f6;
  display: flex;
  align-items: center;
  justify-content: center;
}
.resume-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: #0f172a;
  font-size: 0.925rem;
}
.resume-text strong {
  font-weight: 600;
}
.resume-text span {
  color: #64748b;
  font-size: 0.85rem;
  line-height: 1.45;
}
.resume-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.btn-secondary, .btn-primary {
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  font-family: inherit;
}
.btn-secondary {
  background: transparent;
  color: #64748b;
  border-color: #e2e8f0;
}
.btn-secondary:hover { background: #f8fafc; }
.btn-primary {
  background: #0f2847;
  color: #fff;
}
.btn-primary:hover { background: #1a3a5c; }
@keyframes slide-in {
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
}
@media (max-width: 768px) {
  .wizard-resume {
    top: 12px;
    right: 12px;
    left: 12px;
    max-width: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wizard-resume { animation: none; }
}
</style>
