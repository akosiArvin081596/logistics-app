<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--accent);"></div>
      New User
    </div>

    <!-- A form of its own, so a browser's saved-login autofill sees only these
         fields. The password pair are new-password fields; Username, Full Name
         and Email carry autocomplete tokens Chrome doesn't fill, so the signed-in
         admin's own login, name or email isn't dropped into a new account. -->
    <form autocomplete="off" novalidate @submit.prevent="handleSubmit">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="add-user-username">Username</label>
          <input
            id="add-user-username"
            v-model="form.username"
            class="form-input"
            type="text"
            name="new-account-username"
            autocomplete="new-account-username"
            autocapitalize="off"
            spellcheck="false"
            placeholder="e.g. john.doe"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="add-user-password">Password</label>
          <input
            id="add-user-password"
            v-model="form.password"
            class="form-input"
            type="password"
            name="new-password"
            autocomplete="new-password"
            autocapitalize="off"
            spellcheck="false"
            placeholder="Set password"
            @input="onPasswordInput"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="add-user-confirm-password">Confirm Password</label>
          <input
            id="add-user-confirm-password"
            v-model="form.confirmPassword"
            class="form-input"
            type="password"
            name="confirm-new-password"
            autocomplete="new-password"
            autocapitalize="off"
            spellcheck="false"
            placeholder="Type the password again"
            :aria-invalid="!!passwordHint"
            aria-describedby="add-user-password-hint"
            @input="onPasswordInput"
          />
        </div>
      </div>
      <p id="add-user-password-hint" class="field-hint" aria-live="polite">
        <span v-if="passwordHint" class="field-error">{{ passwordHint }}</span>
        <span v-else-if="staffNote">{{ staffNote }}</span>
      </p>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="add-user-role">Role</label>
          <select id="add-user-role" v-model="form.role" class="form-select">
            <option value="Super Admin">Super Admin</option>
            <option value="Dispatcher">Dispatcher</option>
            <option value="Driver">Driver</option>
            <option value="Investor">Investor</option>
          </select>
        </div>
        <div v-show="form.role === 'Driver'" class="form-group">
          <label class="form-label" for="add-user-driver">Driver Name</label>
          <select id="add-user-driver" v-model="form.driverName" class="form-select">
            <option value="">-- Select driver --</option>
            <option v-for="name in driverNames" :key="name" :value="name">{{ name }}</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="add-user-full-name">Full Name (optional)</label>
        <input
          id="add-user-full-name"
          v-model="form.fullName"
          class="form-input"
          type="text"
          name="new-account-full-name"
          autocomplete="new-account-full-name"
          placeholder="e.g. John Smith"
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="add-user-email">Email (optional)</label>
        <input
          id="add-user-email"
          v-model="form.email"
          class="form-input"
          type="email"
          name="new-account-email"
          autocomplete="new-account-email"
          placeholder="user@company.com"
        />
      </div>

      <button type="submit" class="btn btn-primary btn-add" :disabled="saving || !!passwordHint">{{ saving ? 'Adding...' : 'Add User' }}</button>
      <div class="error-msg" role="alert">{{ errorMsg }}</div>
    </form>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { passwordChangeHint } from '../../lib/passwordFields.js'
import { addUserRefusal, newUserRequest, staffPasswordNote } from '../../lib/accountForms.js'

const props = defineProps({
  driverNames: { type: Array, default: () => [] },
  // Creates the account and resolves once the server accepted it; rejects with
  // the server's refusal otherwise (UsersView.vue). The form keeps what was
  // typed until then, and shows a refusal here.
  createUser: { type: Function, required: true },
  // GET /api/users newStaffMustChangePassword: whether a new Super Admin or
  // Dispatcher changes this password at first sign-in.
  staffMustChangePassword: { type: Boolean, default: false },
})

const form = reactive({
  username: '',
  password: '',
  confirmPassword: '',
  role: 'Driver',
  driverName: '',
  email: '',
  fullName: '',
})

const errorMsg = ref('')
const saving = ref(false)
const passwordHint = computed(() => passwordChangeHint(form.password, form.confirmPassword))
const staffNote = computed(() => staffPasswordNote(form.role, props.staffMustChangePassword))

// A refusal speaks about what was typed, so it goes once either password changes.
function onPasswordInput() {
  errorMsg.value = ''
}

function clearPasswords() {
  form.password = ''
  form.confirmPassword = ''
}

async function handleSubmit() {
  if (saving.value) return
  errorMsg.value = ''
  const request = newUserRequest(form)
  if (request.error) {
    errorMsg.value = request.error
    return
  }
  saving.value = true
  try {
    await props.createUser(request.body)
    form.username = ''
    form.email = ''
    form.driverName = ''
    form.fullName = ''
    clearPasswords()
  } catch (err) {
    const refusal = addUserRefusal(err)
    errorMsg.value = refusal.message
    if (refusal.clearPasswords) clearPasswords()
  } finally {
    saving.value = false
  }
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
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.form-row .form-group {
  flex: 1;
  min-width: 10rem;
}

.form-group {
  margin-bottom: 0.75rem;
}

.field-hint {
  margin: -0.5rem 0 0.75rem;
  min-height: 1em;
  font-size: 0.72rem;
  color: var(--text-dim);
}

.field-error {
  color: var(--danger);
}

.btn-add {
  width: auto;
  padding: 0.5rem 1.5rem;
}

.btn-add:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.error-msg {
  color: var(--danger);
  font-size: 0.78rem;
  margin-top: 0.5rem;
  min-height: 1.1em;
}
</style>
