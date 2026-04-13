<template>
  <header class="app-header">
    <div class="app-header-left">
      <img src="/logo.avif" alt="LogisX" class="header-logo" />
      <span class="driver-name-label">{{ driverName }}</span>
    </div>
    <div class="app-header-right">
      <button class="header-btn" title="Change password" @click="showPwModal = true">Password</button>
      <button class="header-btn danger" @click="$emit('logout')">Logout</button>
    </div>
    <ChangePasswordModal :open="showPwModal" @close="showPwModal = false" />
  </header>
</template>

<script setup>
import { ref } from 'vue'
import ChangePasswordModal from './ChangePasswordModal.vue'

defineProps({
  driverName: { type: String, default: '' },
})

defineEmits(['logout'])

const showPwModal = ref(false)
</script>

<style scoped>
.app-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 40;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  padding: 0.75rem 1rem;
  padding-top: calc(0.75rem + env(safe-area-inset-top, 0px));
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.app-header-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.header-logo {
  height: 28px;
  width: auto;
}

.driver-name-label {
  font-size: 0.85rem;
  color: var(--text-dim);
  font-weight: 500;
}

.app-header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.header-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
  font-family: inherit;
  font-size: 0.75rem;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}

.header-btn:hover {
  background: var(--surface-hover);
}

.header-btn.danger {
  color: var(--danger);
  border-color: var(--danger-dim);
}

.header-btn.danger:hover {
  background: var(--danger-dim);
}
</style>
