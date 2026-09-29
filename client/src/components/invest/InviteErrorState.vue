<template>
  <div class="invite-error-wrap" data-test="invite-error" :data-code="code">
    <div class="invite-error-content" role="alert">
      <div class="invite-error-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <h2>Investor invitation</h2>
      <p>{{ message }}</p>
      <button v-if="code === INVITE_UNAVAILABLE" type="button" class="invite-retry" @click="$emit('retry')">Try again</button>
    </div>
  </div>
</template>

<script setup>
import { INVITE_UNAVAILABLE } from '../../lib/investorInvite'

defineProps({
  code: { type: String, required: true },
  message: { type: String, required: true },
})
defineEmits(['retry'])
</script>

<style scoped>
.invite-error-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}
.invite-error-content { text-align: center; max-width: 480px; }
.invite-error-icon {
  width: 72px; height: 72px; border-radius: 50%; margin: 0 auto 1.5rem;
  background: #fef3c7; color: #b45309;
  display: flex; align-items: center; justify-content: center;
}
.invite-error-content h2 {
  font-size: 1.45rem; font-weight: 800; color: #0f172a;
  letter-spacing: -0.02em; margin: 0 0 0.5rem;
}
.invite-error-content p {
  color: #64748b; font-size: 0.9rem; line-height: 1.6; margin: 0 auto;
}
.invite-retry {
  margin-top: 1.5rem;
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.72rem 1.6rem; border: none; border-radius: 10px;
  background: #0f2847; color: #fff; font-weight: 700; font-size: 0.88rem;
  cursor: pointer; transition: background 0.15s; font-family: inherit;
}
.invite-retry:hover { background: #1a3a6b; }
.invite-retry:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
</style>
