<template>
  <Teleport to="body">
    <div v-if="open" class="pw-overlay" @click.self="close">
      <div class="pw-dialog">
        <div class="pw-header">
          <h3>Change Password</h3>
          <button class="pw-close" aria-label="Close" @click="close">&times;</button>
        </div>

        <form class="pw-body" @submit.prevent="submit">
          <div class="pw-field">
            <label>Current Password</label>
            <input v-model="currentPassword" type="password" autocomplete="current-password" required />
          </div>
          <div class="pw-field">
            <label>New Password</label>
            <input v-model="newPassword" type="password" autocomplete="new-password" required minlength="8" />
            <div class="pw-hint">At least 8 characters.</div>
          </div>
          <div class="pw-field">
            <label>Confirm New Password</label>
            <input v-model="confirmPassword" type="password" autocomplete="new-password" required />
          </div>

          <div v-if="error" class="pw-error">{{ error }}</div>
          <div v-if="success" class="pw-success">Password updated.</div>

          <div class="pw-actions">
            <button type="button" class="btn-cancel" @click="close">Cancel</button>
            <button type="submit" class="btn-save" :disabled="saving || !canSubmit">
              {{ saving ? 'Saving...' : 'Update Password' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useApi } from '../../composables/useApi'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])

const api = useApi()
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const saving = ref(false)
const error = ref('')
const success = ref(false)

const canSubmit = computed(() =>
  currentPassword.value.length > 0 &&
  newPassword.value.length >= 8 &&
  newPassword.value === confirmPassword.value,
)

function reset() {
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  error.value = ''
  success.value = false
  saving.value = false
}

function close() {
  reset()
  emit('close')
}

watch(() => props.open, (v) => { if (v) reset() })

async function submit() {
  error.value = ''
  success.value = false
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'New passwords do not match.'
    return
  }
  if (newPassword.value.length < 8) {
    error.value = 'New password must be at least 8 characters.'
    return
  }
  saving.value = true
  try {
    await api.post('/api/auth/change-password', {
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    })
    success.value = true
    setTimeout(() => close(), 900)
  } catch (err) {
    error.value = err?.message || 'Failed to update password.'
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.pw-overlay {
  position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5);
  display: flex; align-items: center; justify-content: center; z-index: 9999;
  padding: 1rem;
}
.pw-dialog {
  background: #fff; border-radius: 14px;
  max-width: 440px; width: 100%;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.pw-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 1.25rem; border-bottom: 1px solid #e8edf2;
}
.pw-header h3 { margin: 0; font-size: 1.05rem; color: #0f172a; }
.pw-close {
  background: none; border: none; cursor: pointer;
  font-size: 1.5rem; color: #94a3b8; line-height: 1;
}
.pw-body { padding: 1.25rem; }
.pw-field { margin-bottom: 0.85rem; }
.pw-field label {
  display: block; font-size: 0.72rem; font-weight: 700;
  color: #64748b; text-transform: uppercase; letter-spacing: 0.04em;
  margin-bottom: 0.35rem;
}
.pw-field input {
  width: 100%; padding: 0.6rem 0.75rem;
  border: 1px solid #e2e4ea; border-radius: 8px;
  font-family: inherit; font-size: 0.9rem;
  background: #fff; color: #0f172a;
}
.pw-field input:focus { outline: none; border-color: #0ea5e9; }
.pw-hint { font-size: 0.68rem; color: #94a3b8; margin-top: 0.25rem; }
.pw-error {
  background: #fef2f2; color: #b91c1c;
  border: 1px solid #fecaca; border-radius: 8px;
  padding: 0.6rem 0.75rem; font-size: 0.8rem; margin-bottom: 0.75rem;
}
.pw-success {
  background: #f0fdf4; color: #166534;
  border: 1px solid #bbf7d0; border-radius: 8px;
  padding: 0.6rem 0.75rem; font-size: 0.8rem; margin-bottom: 0.75rem;
}
.pw-actions {
  display: flex; justify-content: flex-end; gap: 0.5rem;
  margin-top: 1rem;
}
.btn-cancel, .btn-save {
  padding: 0.55rem 1rem; border-radius: 8px;
  font-family: inherit; font-size: 0.85rem; font-weight: 600;
  cursor: pointer; border: 1px solid transparent;
}
.btn-cancel { background: #f1f5f9; color: #475569; }
.btn-cancel:hover { background: #e2e8f0; }
.btn-save { background: #0ea5e9; color: #fff; }
.btn-save:hover:not(:disabled) { background: #0284c7; }
.btn-save:disabled { opacity: 0.5; cursor: default; }
</style>
