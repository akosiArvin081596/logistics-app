<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--accent);"></div>
      New Driver
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Driver Name *</label>
        <input v-model="form.driver" class="form-input" type="text" placeholder="e.g. JOHN SMITH" />
      </div>
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
        <label class="form-label">Phone Number</label>
        <input v-model="form.phone" class="form-input" type="tel" placeholder="(555) 123-4567" />
      </div>
      <div class="form-group">
        <label class="form-label">Cell Number</label>
        <input v-model="form.cell" class="form-input" type="tel" placeholder="(555) 123-4567" />
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input v-model="form.email" class="form-input" type="email" placeholder="driver@example.com" />
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Trucks</label>
        <input v-model="form.trucks" class="form-input" type="text" placeholder="# of trucks" />
      </div>
      <div class="form-group">
        <label class="form-label">Hazmat</label>
        <select v-model="form.hazmat" class="form-select">
          <option value="NO">NO</option>
          <option value="YES">YES</option>
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">DOT #</label>
        <input v-model="form.dot" class="form-input" type="text" placeholder="DOT number" />
      </div>
      <div class="form-group">
        <label class="form-label">MC #</label>
        <input v-model="form.mc" class="form-input" type="text" placeholder="MC number" />
      </div>
      <div class="form-group">
        <label class="form-label">Rating</label>
        <select v-model="form.rating" class="form-select">
          <option value="Not Rated">Not Rated</option>
          <option value="A+">A+</option>
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
          <option value="N/A">N/A</option>
        </select>
      </div>
    </div>

    <fieldset class="pay-section">
      <legend>Pay Structure</legend>
      <div class="pay-options">
        <label class="pay-radio">
          <input type="radio" v-model="form.payType" value="fixed" />
          <span>Fixed Daily Rate (per day &times; active days)</span>
        </label>
        <label class="pay-radio">
          <input type="radio" v-model="form.payType" value="percentage" />
          <span>Percentage of Net Load Revenue (owner-operator)</span>
        </label>
      </div>
      <div v-if="form.payType === 'fixed'" class="form-group" style="margin-top:0.5rem;max-width:220px;">
        <label class="form-label">Daily Rate ($/day)</label>
        <input v-model.number="form.payDaily" class="form-input" type="number" min="0" step="1" placeholder="e.g. 250" />
      </div>
      <div v-if="form.payType === 'percentage'" class="form-group" style="margin-top:0.5rem;max-width:220px;">
        <label class="form-label">Owner-Operator Share (%)</label>
        <input v-model.number="form.payPercentage" class="form-input" type="number" min="0" max="100" step="0.1" placeholder="e.g. 30" />
      </div>
    </fieldset>

    <button class="btn btn-primary btn-add" @click="handleSubmit">Add Driver</button>
    <div class="error-msg">{{ errorMsg }}</div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'

const emit = defineEmits(['submit'])

const defaults = () => ({
  driver: '', state: '', city: '', zip: '', address: '',
  trucks: '', hazmat: 'NO', phone: '', cell: '', email: '',
  dot: '', mc: '', rating: 'Not Rated',
  payType: 'fixed', payPercentage: 0, payDaily: 0,
})

const form = reactive(defaults())
const errorMsg = ref('')

function handleSubmit() {
  errorMsg.value = ''
  if (!form.driver.trim()) { errorMsg.value = 'Driver name is required.'; return }
  // Emit values array matching the server's drivers-directory headers order
  // (skip Status — server defaults manual adds to 'active'; pay fields tail).
  emit('submit', [
    form.driver.trim().toUpperCase(),
    '', // Carrier Name placeholder — deprecated UI, backend keeps column for legacy data
    form.state.toUpperCase(),
    form.city.toUpperCase(),
    form.zip,
    form.address.toUpperCase(),
    form.trucks,
    form.hazmat,
    form.phone,
    form.cell,
    form.email,
    form.dot,
    form.mc,
    form.rating,
    '', // Status placeholder — server falls back to 'active'
    form.payType,
    form.payType === 'percentage' ? (Number(form.payPercentage) || 0) : 0,
    form.payType === 'fixed' ? (Number(form.payDaily) || 0) : 0,
  ])
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
.btn-add { width: auto; padding: 0.5rem 1.5rem; }
.error-msg { color: var(--danger); font-size: 0.78rem; margin-top: 0.5rem; min-height: 1.1em; }

.pay-section {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.65rem 0.8rem;
  margin: 0.5rem 0 0.75rem;
}
.pay-section legend {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 0.4rem;
}
.pay-options {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.pay-radio {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  cursor: pointer;
}
.pay-radio input[type="radio"] { margin: 0; }
</style>
