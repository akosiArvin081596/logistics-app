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
      <div class="form-group">
        <label class="form-label">Carrier Name</label>
        <select v-model="form.carrierName" class="form-select">
          <option value="">-- Select carrier --</option>
          <option v-for="name in carrierNames" :key="name" :value="name">{{ name }}</option>
        </select>
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

    <button class="btn btn-primary btn-add" @click="handleSubmit">Add Driver</button>
    <div class="error-msg">{{ errorMsg }}</div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'

defineProps({
  carrierNames: { type: Array, default: () => [] },
})

const emit = defineEmits(['submit'])

const defaults = () => ({
  driver: '', carrierName: '', state: '', city: '', zip: '', address: '',
  trucks: '', hazmat: 'NO', phone: '', cell: '', email: '',
  dot: '', mc: '', rating: 'Not Rated',
})

const form = reactive(defaults())
const errorMsg = ref('')

function handleSubmit() {
  errorMsg.value = ''
  if (!form.driver.trim()) { errorMsg.value = 'Driver name is required.'; return }
  // Emit values array matching Carrier Database header order
  emit('submit', [
    form.driver.trim().toUpperCase(),
    form.carrierName,
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
</style>
