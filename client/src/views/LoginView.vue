<template>
  <div class="login-split">
    <!-- Left Panel: Branding -->
    <div class="login-brand">
      <div class="brand-center">
        <img src="/logo.png" alt="LogisX" class="brand-logo" />
        <div class="brand-divider"></div>
        <p class="brand-tagline">Dispatch &amp; Fleet Management<br />Operations Platform</p>
        <div class="brand-features">
          <div class="feature-pill">&#128666; Real-time Tracking</div>
          <div class="feature-pill">&#128203; Automated Dispatch</div>
          <div class="feature-pill">&#128200; Fleet Analytics</div>
        </div>
      </div>
    </div>

    <!-- Right Panel: Form -->
    <div class="login-form-panel">
      <div class="form-wrapper">
        <!-- Mobile logo -->
        <div class="mobile-logo">
          <img src="/logo.png" alt="LogisX" />
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
              <label class="field-label" for="login-password">PASSWORD</label>
              <div class="input-wrap">
                <span class="input-icon">&#128274;</span>
                <input id="login-password" ref="loginPasswordInput" v-model="loginForm.password" :type="showLoginPassword ? 'text' : 'password'" placeholder="Enter your password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" @keydown.enter="doLogin" />
                <!-- The same eye button as Users > Edit User's password fields. A press
                     doesn't take focus from the field, so the caret stays put. -->
                <button type="button" class="pw-toggle" :aria-label="showLoginPassword ? 'Hide password' : 'Show password'" :aria-pressed="showLoginPassword" aria-controls="login-password" @mousedown.prevent @click="toggleLoginPassword">
                  <EyeOff v-if="showLoginPassword" :size="16" aria-hidden="true" />
                  <Eye v-else :size="16" aria-hidden="true" />
                </button>
              </div>
            </div>
            <button type="submit" class="submit-btn" :disabled="loginLoading">
              {{ loginLoading ? 'SIGNING IN...' : 'SIGN IN' }}
            </button>
            <p v-if="loginError" class="error-text">{{ loginError }}</p>
            <p v-if="loginTip" class="tip-text">{{ loginTip }}</p>
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
import { ref, reactive, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { Eye, EyeOff } from 'lucide-vue-next'
import { isLeavingPage, useAuthStore } from '../stores/auth'
import { signInTip } from '../lib/accountForms.js'

const router = useRouter()
const auth = useAuthStore()

const showSetup = ref(false)
const showLogin = ref(false)
const setupLoading = ref(false)
const loginLoading = ref(false)
const setupError = ref('')
const loginError = ref('')
// "Tip: sign in with your username." after a refused sign-in by email
// (lib/accountForms.js signInTip()).
const loginTip = ref('')

const setupForm = reactive({ username: '', password: '', email: '' })
const loginForm = reactive({ username: '', password: '' })
const showLoginPassword = ref(false)
const loginPasswordInput = ref(null)

// Show or hide the password. When the field has focus (a mouse or touch press on
// the eye button doesn't take it), the caret and selection are put back once the
// field's type has changed.
async function toggleLoginPassword() {
  const input = loginPasswordInput.value
  const hadFocus = !!input && document.activeElement === input
  const start = hadFocus ? input.selectionStart : null
  const end = hadFocus ? input.selectionEnd : null
  showLoginPassword.value = !showLoginPassword.value
  if (!hadFocus || start === null) return
  await nextTick()
  input.setSelectionRange(start, end)
}

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

// A sign-in can end on a fresh page (stores/auth.js), and until it arrives this one
// is still here with a live button: a second tap would send a second sign-in. So a
// SUCCESSFUL sign-in (doSetup, doLogin) that is loading a fresh page keeps its
// button disabled. Asked after the call succeeds, not in `finally` alone: a page an
// unconfirmed sign-out left on this screen is already leaving, and a refused
// sign-in there must still hand the button back.
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
  let freshPageComing = false
  try {
    await auth.setup(setupForm.username, setupForm.password, setupForm.email)
    freshPageComing = isLeavingPage()
    router.push(auth.roleHome)
  } catch (err) {
    setupError.value = err.message || 'Connection failed.'
  } finally {
    if (!freshPageComing) setupLoading.value = false
  }
}

async function doLogin() {
  loginError.value = ''
  loginTip.value = ''
  if (!loginForm.username || !loginForm.password) {
    loginError.value = 'Enter username and password.'
    return
  }
  // Hidden again before it is sent: it isn't left on screen, and the browser's
  // password manager sees a password field when it offers to save the sign-in.
  showLoginPassword.value = false
  loginLoading.value = true
  let freshPageComing = false
  try {
    await auth.login(loginForm.username, loginForm.password)
    freshPageComing = isLeavingPage()
    router.push(auth.roleHome)
  } catch (err) {
    loginError.value = err.message || 'Connection failed.'
    loginTip.value = signInTip(err && err.status, loginForm.username)
  } finally {
    if (!freshPageComing) loginLoading.value = false
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
  background: #0f2137;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

/* removed radial gradient overlay — caused visible color seam */

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
  width: 60px;
  height: 3px;
  background: linear-gradient(90deg, rgba(56, 189, 248, 0.3), rgba(56, 189, 248, 0.8), rgba(56, 189, 248, 0.3));
  margin: 0 auto 1.5rem;
  border-radius: 2px;
}

.brand-tagline {
  font-size: 1.15rem;
  line-height: 1.7;
  font-weight: 300;
  letter-spacing: 0.03em;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.3);
  margin-bottom: 2.5rem;
}

.brand-features {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.65rem;
}

.feature-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem;
  border-radius: 50px;
  border: 1px solid rgba(56, 189, 248, 0.2);
  background: rgba(56, 189, 248, 0.08);
  backdrop-filter: blur(4px);
  color: rgba(255, 255, 255, 0.75);
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  transition: all 0.3s;
}

.feature-pill:hover {
  background: rgba(56, 189, 248, 0.15);
  border-color: rgba(56, 189, 248, 0.4);
  color: rgba(255, 255, 255, 0.95);
  transform: translateX(4px);
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
  min-width: 0;
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

/* The eye button: Users > Edit User's .pw-toggle, in this page's colours. */
.pw-toggle {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  margin-right: 0.35rem;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
}

.pw-toggle:hover,
.pw-toggle:focus-visible {
  color: #374151;
}

.pw-toggle:focus-visible {
  outline: 2px solid hsl(199, 89%, 48%);
  outline-offset: 1px;
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

.tip-text {
  margin-top: -0.75rem;
  font-size: 0.8rem;
  color: #4b5563;
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
