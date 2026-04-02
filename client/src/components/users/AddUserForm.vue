<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--accent);"></div>
      New User
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Username</label>
        <input
          v-model="form.username"
          class="form-input"
          type="text"
          placeholder="e.g. john.doe"
        />
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input
          v-model="form.password"
          class="form-input"
          type="password"
          placeholder="Set password"
        />
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Role</label>
        <select v-model="form.role" class="form-select">
          <option value="Super Admin">Super Admin</option>
          <option value="Dispatcher">Dispatcher</option>
          <option value="Driver">Driver</option>
          <option value="Investor">Investor</option>
        </select>
      </div>
      <div v-show="form.role === 'Driver'" class="form-group">
        <label class="form-label">Driver Name (Carrier DB)</label>
        <select v-model="form.driverName" class="form-select">
          <option value="">-- Select driver --</option>
          <option v-for="name in driverNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Full Name (optional)</label>
      <input
        v-model="form.fullName"
        class="form-input"
        type="text"
        placeholder="e.g. John Smith"
      />
    </div>

    <div class="form-group">
      <label class="form-label">Email (optional)</label>
      <input
        v-model="form.email"
        class="form-input"
        type="email"
        placeholder="user@company.com"
      />
    </div>

    <button class="btn btn-primary btn-add" @click="handleSubmit">Add User</button>
    <div class="error-msg">{{ errorMsg }}</div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'

defineProps({
  driverNames: { type: Array, default: () => [] },
})

const emit = defineEmits(['submit'])

const form = reactive({
  username: '',
  password: '',
  role: 'Driver',
  driverName: '',
  email: '',
  fullName: '',
})

const errorMsg = ref('')

function handleSubmit() {
  errorMsg.value = ''

  if (!form.username.trim() || !form.password) {
    errorMsg.value = 'Username and password required.'
    return
  }

  if (form.role === 'Driver' && !form.driverName) {
    errorMsg.value = 'Select a driver name for Driver role.'
    return
  }

  emit('submit', {
    username: form.username.trim(),
    password: form.password,
    role: form.role,
    driverName: form.driverName,
    email: form.email.trim(),
    fullName: form.fullName.trim(),
  })

  // Reset form
  form.username = ''
  form.password = ''
  form.email = ''
  form.driverName = ''
  form.fullName = ''
}
</script>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}

.admin-section-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 700;
  font-size: 0.88rem;
  margin-bottom: 1rem;
}

.section-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.form-row {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.form-row .form-group {
  flex: 1;
}

.form-group {
  margin-bottom: 0.75rem;
}

.btn-add {
  width: auto;
  padding: 0.5rem 1.5rem;
}

.error-msg {
  color: var(--danger);
  font-size: 0.78rem;
  margin-top: 0.5rem;
  min-height: 1.1em;
}
</style>
