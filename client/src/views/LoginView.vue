<template>
  <div class="login-container">
    <div class="login-header">
      <div class="login-logo"><span class="icon">&#11044;</span> Dispatch</div>
      <p class="login-subtitle">Logistics Management</p>
    </div>

    <!-- SETUP FORM (first-time) -->
    <div v-if="showSetup" class="card">
      <h2>First-Time Setup</h2>
      <p class="card-desc">Create your super admin account to get started.</p>
      <div class="form-group">
        <label class="form-label">Username</label>
        <input v-model="setupForm.username" class="form-input" type="text" placeholder="Choose a username" autocomplete="username" />
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input v-model="setupForm.password" class="form-input" type="password" placeholder="Min. 4 characters" autocomplete="new-password" @keydown.enter="doSetup" />
      </div>
      <div class="form-group">
        <label class="form-label">Email (optional)</label>
        <input v-model="setupForm.email" class="form-input" type="email" placeholder="you@company.com" />
      </div>
      <button class="btn btn-primary" :disabled="setupLoading" @click="doSetup">Create Super Admin Account</button>
      <div class="error-msg">{{ setupError }}</div>
    </div>

    <!-- LOGIN FORM -->
    <div v-if="showLogin" class="card">
      <h2>Welcome back</h2>
      <p class="card-desc">Sign in to your account to continue.</p>
      <div class="form-group">
        <label class="form-label">Username</label>
        <input v-model="loginForm.username" class="form-input" type="text" placeholder="Enter your username" autocomplete="username" />
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input v-model="loginForm.password" class="form-input" type="password" placeholder="Enter your password" autocomplete="current-password" @keydown.enter="doLogin" />
      </div>
      <button class="btn btn-primary" :disabled="loginLoading" @click="doLogin">Sign In</button>
      <div class="error-msg">{{ loginError }}</div>
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
.login-container {
  width: 100%;
  max-width: 520px;
  padding: 1.5rem;
  margin: 0 auto;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.login-header {
  text-align: center;
  margin-bottom: 2rem;
}
.login-logo {
  font-size: 1.6rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}
.login-logo .icon { color: var(--accent); }
.login-subtitle {
  color: var(--text-dim);
  font-size: 0.82rem;
}
.card {
  width: 100%;
  padding: 1.75rem;
  margin-bottom: 1rem;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03);
}
.card h2 {
  font-size: 1.1rem;
  font-weight: 700;
  margin-bottom: 0.35rem;
}
.card-desc {
  font-size: 0.82rem;
  color: var(--text-dim);
  margin-bottom: 1.25rem;
}
.error-msg {
  color: var(--danger);
  font-size: 0.78rem;
  margin-top: 0.5rem;
  min-height: 1.1em;
}
.btn-primary {
  width: 100%;
  padding: 0.75rem;
  font-size: 0.88rem;
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.25);
}
.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
}
</style>
