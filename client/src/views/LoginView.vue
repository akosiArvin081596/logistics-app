<template>
  <div class="login-split">
    <!-- Left Panel: Branding -->
    <div class="login-brand">
      <div class="brand-center">
        <img src="/logo.avif" alt="LogisX" class="brand-logo" />
        <div class="brand-divider"></div>
        <p class="brand-tagline">Dispatch &amp; Fleet Management<br />Operations Platform</p>
      </div>
    </div>

    <!-- Right Panel: Form -->
    <div class="login-form-panel">
      <div class="form-wrapper">
        <!-- Mobile logo -->
        <div class="mobile-logo">
          <img src="/logo.avif" alt="LogisX" />
        </div>

        <!-- SETUP FORM -->
        <template v-if="showSetup">
          <div class="form-header">
            <h2 class="form-title">Get Started</h2>
            <p class="form-desc">Create your admin account to begin.</p>
          </div>
          <form @submit.prevent="doSetup" class="login-form">
            <div class="field">
              <label class="field-label">USERNAME</label>
              <div class="input-wrap">
                <span class="input-icon">&#128100;</span>
                <input v-model="setupForm.username" type="text" placeholder="Choose a username" autocomplete="username" />
              </div>
            </div>
            <div class="field">
              <label class="field-label">PASSWORD</label>
              <div class="input-wrap">
                <span class="input-icon">&#128274;</span>
                <input v-model="setupForm.password" type="password" placeholder="Min. 4 characters" autocomplete="new-password" @keydown.enter="doSetup" />
              </div>
            </div>
            <div class="field">
              <label class="field-label">EMAIL <span class="optional">(optional)</span></label>
              <div class="input-wrap">
                <span class="input-icon">&#9993;</span>
                <input v-model="setupForm.email" type="email" placeholder="you@company.com" />
              </div>
            </div>
            <button type="submit" class="submit-btn" :disabled="setupLoading">
              {{ setupLoading ? 'CREATING...' : 'CREATE ACCOUNT' }}
            </button>
            <p v-if="setupError" class="error-text">{{ setupError }}</p>
          </form>
        </template>

        <!-- LOGIN FORM -->
        <template v-if="showLogin">
          <div class="form-header">
            <h2 class="form-title">Welcome back</h2>
            <p class="form-desc">Sign in to your account to continue</p>
          </div>
          <form @submit.prevent="doLogin" class="login-form">
            <div class="field">
              <label class="field-label">USERNAME</label>
              <div class="input-wrap">
                <span class="input-icon">&#128100;</span>
                <input v-model="loginForm.username" type="text" placeholder="Enter your username" autocomplete="username" />
              </div>
            </div>
            <div class="field">
              <label class="field-label">PASSWORD</label>
              <div class="input-wrap">
                <span class="input-icon">&#128274;</span>
                <input v-model="loginForm.password" type="password" placeholder="Enter your password" autocomplete="current-password" @keydown.enter="doLogin" />
              </div>
            </div>
            <button type="submit" class="submit-btn" :disabled="loginLoading">
              {{ loginLoading ? 'SIGNING IN...' : 'SIGN IN' }}
            </button>
            <p v-if="loginError" class="error-text">{{ loginError }}</p>
          </form>
        </template>

        <div class="form-footer">
          <p>&copy; 2026 LogisX. All rights reserved.</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()

const showSetup = ref(false)
const showLogin = ref(false)
const setupLoading = ref(false)
const loginLoading = ref(false)
const setupError = ref('')
const loginError = ref('')

const setupForm = reactive({ username: '', password: '', email: '' })
const loginForm = reactive({ username: '', password: '' })

onMounted(async () => {
  try {
    const needsSetup = await auth.checkSetupNeeded()
    if (needsSetup) {
      showSetup.value = true
    } else {
      showLogin.value = true
    }
  } catch {
    showLogin.value = true
  }
})

async function doSetup() {
  setupError.value = ''
  if (!setupForm.username || !setupForm.password) {
    setupError.value = 'Username and password required.'
    return
  }
  if (setupForm.password.length < 4) {
    setupError.value = 'Password must be at least 4 characters.'
    return
  }
  setupLoading.value = true
  try {
    await auth.setup(setupForm.username, setupForm.password, setupForm.email)
    router.push(auth.roleHome)
  } catch (err) {
    setupError.value = err.message || 'Connection failed.'
  } finally {
    setupLoading.value = false
  }
}

async function doLogin() {
  loginError.value = ''
  if (!loginForm.username || !loginForm.password) {
    loginError.value = 'Enter username and password.'
    return
  }
  loginLoading.value = true
  try {
    await auth.login(loginForm.username, loginForm.password)
    router.push(auth.roleHome)
  } catch (err) {
    loginError.value = err.message || 'Connection failed.'
  } finally {
    loginLoading.value = false
  }
}
</script>

<style scoped>
.login-split {
  display: flex;
  min-height: 100vh;
  width: 100%;
}

/* Left brand panel */
.login-brand {
  flex: 0 0 45%;
  background: linear-gradient(135deg, #0c1929 0%, #122a46 50%, #0f3460 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

.login-brand::before {
  content: '';
  position: absolute;
  top: -40%;
  right: -20%;
  width: 70%;
  height: 180%;
  background: radial-gradient(circle, rgba(56, 189, 248, 0.07) 0%, transparent 70%);
  pointer-events: none;
}

.brand-center {
  text-align: center;
  position: relative;
  z-index: 1;
}

.brand-logo {
  width: 220px;
  height: auto;
  margin-bottom: 1.5rem;
}

.brand-divider {
  width: 50px;
  height: 3px;
  background: rgba(56, 189, 248, 0.6);
  margin: 0 auto 1.25rem;
  border-radius: 2px;
}

.brand-tagline {
  font-size: 0.9rem;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.5);
}

/* Right form panel */
.login-form-panel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: #ffffff;
  position: relative;
}

.form-wrapper {
  width: 100%;
  max-width: 420px;
}

.mobile-logo {
  display: none;
  text-align: center;
  margin-bottom: 2rem;
}

.mobile-logo img {
  width: 140px;
  height: auto;
}

.form-header {
  margin-bottom: 2rem;
}

.form-title {
  font-size: 1.6rem;
  font-weight: 700;
  color: #111827;
  margin-bottom: 0.4rem;
}

.form-desc {
  font-size: 0.9rem;
  color: #9ca3af;
}

/* Form fields */
.login-form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.field-label {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #374151;
}

.field-label .optional {
  font-weight: 400;
  color: #9ca3af;
  letter-spacing: normal;
  text-transform: none;
}

.input-wrap {
  display: flex;
  align-items: center;
  border: 1.5px solid #e2e4ea;
  border-radius: 10px;
  background: #f9fafb;
  transition: border-color 0.15s, box-shadow 0.15s;
  overflow: hidden;
}

.input-wrap:focus-within {
  border-color: hsl(199, 89%, 48%);
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.1);
  background: #fff;
}

.input-icon {
  padding: 0 0 0 0.85rem;
  font-size: 1rem;
  color: #9ca3af;
  flex-shrink: 0;
  line-height: 1;
}

.input-wrap input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  padding: 0.8rem 0.85rem;
  font-size: 0.9rem;
  font-family: inherit;
  color: #111827;
}

.input-wrap input::placeholder {
  color: #c4c8d0;
}

/* Submit button */
.submit-btn {
  width: 100%;
  padding: 0.85rem;
  margin-top: 0.5rem;
  border: none;
  border-radius: 10px;
  background: hsl(199, 89%, 48%);
  color: white;
  font-size: 0.88rem;
  font-weight: 700;
  font-family: inherit;
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: all 0.15s;
}

.submit-btn:hover:not(:disabled) {
  background: hsl(199, 89%, 42%);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(56, 189, 248, 0.35);
}

.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.error-text {
  font-size: 0.82rem;
  color: #dc2626;
  text-align: center;
}

.form-footer {
  position: absolute;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
}

.form-footer p {
  font-size: 0.72rem;
  color: #d1d5db;
  letter-spacing: 0.02em;
}

/* Mobile */
@media (max-width: 768px) {
  .login-split {
    flex-direction: column;
  }
  .login-brand {
    display: none;
  }
  .mobile-logo {
    display: block;
  }
  .login-form-panel {
    min-height: 100vh;
  }
  .form-footer {
    position: static;
    transform: none;
    text-align: center;
    margin-top: 3rem;
  }
}
</style>
