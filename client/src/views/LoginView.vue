<template>
  <div class="login-split">
    <!-- Left Panel: Branding -->
    <div class="login-brand">
      <div class="brand-content">
        <img src="/logo.avif" alt="LogisX" class="brand-logo" />
        <h1 class="brand-title">LogisX</h1>
        <p class="brand-tagline">Streamline your logistics operations with real-time tracking, dispatch management, and fleet oversight.</p>
        <div class="brand-features">
          <div class="feature">
            <span class="feature-icon">&#128666;</span>
            <span>Real-time Fleet Tracking</span>
          </div>
          <div class="feature">
            <span class="feature-icon">&#128203;</span>
            <span>Automated Dispatch</span>
          </div>
          <div class="feature">
            <span class="feature-icon">&#128200;</span>
            <span>Financial Analytics</span>
          </div>
        </div>
      </div>
      <div class="brand-footer">
        <p>&copy; 2026 LogisX. All rights reserved.</p>
      </div>
    </div>

    <!-- Right Panel: Form -->
    <div class="login-form-panel">
      <div class="form-wrapper">
        <!-- Mobile logo (visible on small screens only) -->
        <div class="mobile-logo">
          <img src="/logo.avif" alt="LogisX" />
        </div>

        <!-- SETUP FORM -->
        <Card v-if="showSetup" class="login-card">
          <CardContent class="p-8">
            <div class="form-header">
              <h2 class="form-title">Get Started</h2>
              <p class="form-desc">Create your admin account to begin.</p>
            </div>
            <form @submit.prevent="doSetup" class="space-y-5">
              <div class="space-y-1.5">
                <label class="field-label">Username</label>
                <Input v-model="setupForm.username" placeholder="Choose a username" autocomplete="username" class="login-input" />
              </div>
              <div class="space-y-1.5">
                <label class="field-label">Password</label>
                <Input v-model="setupForm.password" type="password" placeholder="Min. 4 characters" autocomplete="new-password" class="login-input" @keydown.enter="doSetup" />
              </div>
              <div class="space-y-1.5">
                <label class="field-label">Email <span class="text-gray-400">(optional)</span></label>
                <Input v-model="setupForm.email" type="email" placeholder="you@company.com" class="login-input" />
              </div>
              <Button type="submit" :disabled="setupLoading" class="login-btn w-full">
                {{ setupLoading ? 'Creating...' : 'Create Admin Account' }}
              </Button>
              <p v-if="setupError" class="error-text">{{ setupError }}</p>
            </form>
          </CardContent>
        </Card>

        <!-- LOGIN FORM -->
        <Card v-if="showLogin" class="login-card">
          <CardContent class="p-8">
            <div class="form-header">
              <h2 class="form-title">Welcome back</h2>
              <p class="form-desc">Sign in to your account to continue.</p>
            </div>
            <form @submit.prevent="doLogin" class="space-y-5">
              <div class="space-y-1.5">
                <label class="field-label">Username</label>
                <Input v-model="loginForm.username" placeholder="Enter your username" autocomplete="username" class="login-input" />
              </div>
              <div class="space-y-1.5">
                <label class="field-label">Password</label>
                <Input v-model="loginForm.password" type="password" placeholder="Enter your password" autocomplete="current-password" class="login-input" @keydown.enter="doLogin" />
              </div>
              <Button type="submit" :disabled="loginLoading" class="login-btn w-full">
                {{ loginLoading ? 'Signing in...' : 'Sign In' }}
              </Button>
              <p v-if="loginError" class="error-text">{{ loginError }}</p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

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
  color: white;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 3rem;
  position: relative;
  overflow: hidden;
}

.login-brand::before {
  content: '';
  position: absolute;
  top: -50%;
  right: -30%;
  width: 80%;
  height: 200%;
  background: radial-gradient(circle, rgba(56, 189, 248, 0.08) 0%, transparent 70%);
  pointer-events: none;
}

.login-brand::after {
  content: '';
  position: absolute;
  bottom: -20%;
  left: -20%;
  width: 60%;
  height: 60%;
  background: radial-gradient(circle, rgba(56, 189, 248, 0.05) 0%, transparent 70%);
  pointer-events: none;
}

.brand-content {
  position: relative;
  z-index: 1;
  margin-top: 2rem;
}

.brand-logo {
  width: 160px;
  height: auto;
  margin-bottom: 1.5rem;
  filter: brightness(0) invert(1);
}

.brand-title {
  font-size: 2.2rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin-bottom: 0.75rem;
  background: linear-gradient(135deg, #ffffff 0%, #94d4f7 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.brand-tagline {
  font-size: 1rem;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.6);
  max-width: 380px;
  margin-bottom: 3rem;
}

.brand-features {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.feature {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.9rem;
  color: rgba(255, 255, 255, 0.75);
}

.feature-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(56, 189, 248, 0.12);
  border: 1px solid rgba(56, 189, 248, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  flex-shrink: 0;
}

.brand-footer {
  position: relative;
  z-index: 1;
}

.brand-footer p {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.3);
}

/* Right form panel */
.login-form-panel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: #f8f9fb;
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

.login-card {
  border-radius: 16px !important;
  border: 1px solid #e8edf2 !important;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06) !important;
  overflow: hidden;
}

.form-header {
  margin-bottom: 1.75rem;
}

.form-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: #111827;
  letter-spacing: -0.01em;
  margin-bottom: 0.35rem;
}

.form-desc {
  font-size: 0.88rem;
  color: #6b7280;
}

.field-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: #374151;
}

.login-input {
  height: 44px !important;
  border-radius: 10px !important;
  border-color: #e2e4ea !important;
  background: white !important;
  font-size: 0.9rem !important;
  transition: all 0.15s !important;
}

.login-input:focus {
  border-color: hsl(199, 89%, 48%) !important;
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.1) !important;
}

.login-btn {
  height: 46px !important;
  border-radius: 10px !important;
  font-size: 0.9rem !important;
  font-weight: 600 !important;
  background: hsl(199, 89%, 48%) !important;
  color: white !important;
  transition: all 0.15s !important;
  margin-top: 0.5rem !important;
}

.login-btn:hover:not(:disabled) {
  background: hsl(199, 89%, 42%) !important;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(56, 189, 248, 0.3);
}

.login-btn:disabled {
  opacity: 0.6;
}

.error-text {
  font-size: 0.82rem;
  color: #dc2626;
  text-align: center;
  margin-top: 0.5rem;
}

/* Mobile responsive */
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
    background: white;
  }
}
</style>
