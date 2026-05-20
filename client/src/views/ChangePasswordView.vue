<template>
  <div class="cp-shell">
    <div class="cp-card">
      <div class="cp-header">
        <img src="/logo.png" alt="LogisX" class="cp-logo" />
        <h1 class="cp-title">Set your password</h1>
        <p class="cp-sub">
          You're using a temporary password. Please choose a new one before continuing.
        </p>
        <p v-if="auth.user?.username" class="cp-user">
          Signed in as <b>{{ auth.user.username }}</b>
        </p>
      </div>

      <form class="cp-body" @submit.prevent="submit">
        <div class="cp-field">
          <label>Temporary password</label>
          <input
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            placeholder="The password from your welcome email"
            required
          />
        </div>
        <div class="cp-field">
          <label>New password</label>
          <input
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            placeholder="Choose a strong password"
            required
          />
          <ul class="cp-rules" aria-label="Password requirements">
            <li :class="{ met: rules.length }"><span class="cp-tick">{{ rules.length ? '✓' : '○' }}</span> At least 8 characters</li>
            <li :class="{ met: rules.upper }"><span class="cp-tick">{{ rules.upper ? '✓' : '○' }}</span> One uppercase letter</li>
            <li :class="{ met: rules.lower }"><span class="cp-tick">{{ rules.lower ? '✓' : '○' }}</span> One lowercase letter</li>
            <li :class="{ met: rules.digit }"><span class="cp-tick">{{ rules.digit ? '✓' : '○' }}</span> One number</li>
            <li :class="{ met: rules.symbol }"><span class="cp-tick">{{ rules.symbol ? '✓' : '○' }}</span> One symbol (!@#$ etc.)</li>
          </ul>
        </div>
        <div class="cp-field">
          <label>Confirm new password</label>
          <input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            placeholder="Type it again"
            required
          />
        </div>

        <div v-if="error" class="cp-error">{{ error }}</div>

        <button type="submit" class="cp-submit" :disabled="saving || !canSubmit">
          {{ saving ? 'Updating…' : 'Update password' }}
        </button>

        <button type="button" class="cp-logout" :disabled="saving" @click="doLogout">
          Sign out instead
        </button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useApi } from '../composables/useApi'

const router = useRouter()
const auth = useAuthStore()
const api = useApi()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const saving = ref(false)
const error = ref('')

const rules = computed(() => {
  const p = newPassword.value || ''
  return {
    length: p.length >= 8,
    upper: /[A-Z]/.test(p),
    lower: /[a-z]/.test(p),
    digit: /\d/.test(p),
    symbol: /[!@#$%^&*()_+\-=[\]{};:'",.<>?/\\|`~]/.test(p),
  }
})

const allRulesMet = computed(() =>
  rules.value.length && rules.value.upper && rules.value.lower && rules.value.digit && rules.value.symbol,
)

const canSubmit = computed(() =>
  currentPassword.value.length > 0 &&
  allRulesMet.value &&
  newPassword.value === confirmPassword.value,
)

async function submit() {
  error.value = ''
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'The two new passwords do not match.'
    return
  }
  if (!allRulesMet.value) {
    error.value = 'New password does not meet all requirements.'
    return
  }
  saving.value = true
  try {
    await api.post('/api/auth/change-password', {
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    })
    if (auth.user) auth.user = { ...auth.user, mustChangePassword: false }
    router.replace(auth.roleHome)
  } catch (err) {
    error.value = err?.message || 'Failed to update password.'
  } finally {
    saving.value = false
  }
}

async function doLogout() {
  await auth.logout()
  router.replace('/login')
}
</script>

<style scoped>
.cp-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: #0f2137;
}
.cp-card {
  width: 100%;
  max-width: 440px;
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.25);
  padding: 1.75rem 1.75rem 1.5rem;
}
.cp-header { text-align: center; margin-bottom: 1.25rem; }
.cp-logo { height: 40px; margin-bottom: 0.75rem; }
.cp-title {
  margin: 0 0 0.35rem;
  font-size: 1.25rem;
  font-weight: 700;
  color: #0f172a;
}
.cp-sub {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  color: #64748b;
  line-height: 1.5;
}
.cp-user {
  margin: 0;
  font-size: 0.75rem;
  color: #64748b;
}
.cp-body { display: flex; flex-direction: column; gap: 0.85rem; }
.cp-field { display: flex; flex-direction: column; gap: 0.3rem; }
.cp-field label {
  font-size: 0.7rem;
  font-weight: 700;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.cp-field input {
  width: 100%;
  padding: 0.65rem 0.8rem;
  border: 1px solid #e2e4ea;
  border-radius: 8px;
  font-family: inherit;
  font-size: 0.9rem;
  background: #fff;
  color: #0f172a;
}
.cp-field input:focus { outline: none; border-color: #0ea5e9; }
.cp-rules {
  list-style: none;
  padding: 0.5rem 0.75rem;
  margin: 0.25rem 0 0;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 0.72rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.cp-rules li {
  display: flex; align-items: center; gap: 0.4rem;
  color: #64748b;
  transition: color 0.15s;
}
.cp-rules li.met { color: #15803d; }
.cp-tick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  font-weight: 700;
}
.cp-error {
  background: #fef2f2;
  color: #b91c1c;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 0.55rem 0.75rem;
  font-size: 0.78rem;
}
.cp-submit {
  margin-top: 0.35rem;
  padding: 0.75rem 1rem;
  border-radius: 10px;
  border: none;
  background: #0f2137;
  color: #fff;
  font-family: inherit;
  font-size: 0.9rem;
  font-weight: 700;
  cursor: pointer;
}
.cp-submit:hover:not(:disabled) { background: #1e3252; }
.cp-submit:disabled { opacity: 0.5; cursor: default; }
.cp-logout {
  margin-top: 0.4rem;
  padding: 0.55rem 1rem;
  border-radius: 8px;
  border: 1px solid #e2e4ea;
  background: #fff;
  color: #475569;
  font-family: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}
.cp-logout:hover:not(:disabled) { background: #f1f5f9; }
.cp-logout:disabled { opacity: 0.5; cursor: default; }
</style>
