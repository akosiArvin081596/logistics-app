<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--accent);"></div>
      New Investor
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Full Name *</label>
        <input v-model="form.fullName" class="form-input" type="text" placeholder="e.g. John Smith" />
      </div>
      <div class="form-group">
        <label class="form-label">Company Name (Carrier)</label>
        <select v-model="form.companyName" class="form-select">
          <option value="">-- Select carrier --</option>
          <option v-for="name in carrierNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Email</label>
        <input v-model="form.email" class="form-input" type="email" placeholder="john@example.com" />
      </div>
      <div class="form-group">
        <label class="form-label">Phone</label>
        <input v-model="form.phone" class="form-input" type="tel" placeholder="(555) 123-4567" />
      </div>
    </div>

    <div class="form-row">
      <div class="form-group" style="flex:2;">
        <label class="form-label">Address</label>
        <input v-model="form.address" class="form-input" type="text" placeholder="Street address" />
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">City</label>
        <input v-model="form.city" class="form-input" type="text" placeholder="City" />
      </div>
      <div class="form-group">
        <label class="form-label">State</label>
        <input v-model="form.state" class="form-input" type="text" placeholder="TX" maxlength="2" style="text-transform:uppercase;" />
      </div>
      <div class="form-group">
        <label class="form-label">ZIP</label>
        <input v-model="form.zip" class="form-input" type="text" placeholder="77302" />
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Tax ID / EIN</label>
        <input v-model="form.taxId" class="form-input" type="text" placeholder="XX-XXXXXXX" />
      </div>
      <div class="form-group">
        <label class="form-label">Split %</label>
        <input v-model.number="form.splitPct" class="form-input" type="number" min="0" max="100" placeholder="50" />
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <select v-model="form.status" class="form-select">
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
        </select>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Linked User Account</label>
      <select v-model="form.userId" class="form-select">
        <option :value="null">-- None --</option>
        <option v-for="u in investorUsers" :key="u.id" :value="u.id">{{ u.username }}</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">Notes (optional)</label>
      <textarea v-model="form.notes" class="form-input form-textarea" rows="2" placeholder="Any additional notes..."></textarea>
    </div>

    <button class="btn btn-primary btn-add" @click="handleSubmit">Add Investor</button>
    <div class="error-msg">{{ errorMsg }}</div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'

defineProps({
  investorUsers: { type: Array, default: () => [] },
  carrierNames: { type: Array, default: () => [] },
})

const emit = defineEmits(['submit'])

const defaults = () => ({
  fullName: '', companyName: '', email: '', phone: '',
  address: '', city: '', state: '', zip: '',
  taxId: '', splitPct: 50, status: 'Active', userId: null, notes: '',
})

const form = reactive(defaults())
const errorMsg = ref('')

function handleSubmit() {
  errorMsg.value = ''
  if (!form.fullName.trim()) { errorMsg.value = 'Full name is required.'; return }
  emit('submit', { ...form, fullName: form.fullName.trim(), state: form.state.toUpperCase() })
  Object.assign(form, defaults())
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
  display: flex; align-items: center; gap: 0.5rem;
  font-weight: 700; font-size: 0.88rem; margin-bottom: 1rem;
}
.section-dot { width: 8px; height: 8px; border-radius: 50%; }
.form-row { display: flex; gap: 1rem; margin-bottom: 0.75rem; }
.form-row .form-group { flex: 1; }
.form-group { margin-bottom: 0.75rem; }
.form-textarea { resize: vertical; }
.btn-add { width: auto; padding: 0.5rem 1.5rem; }
.error-msg { color: var(--danger); font-size: 0.78rem; margin-top: 0.5rem; min-height: 1.1em; }
</style>
