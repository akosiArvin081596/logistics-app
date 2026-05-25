<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--accent);"></div>
      New Investor
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Investor Name *</label>
        <input v-model="form.fullName" class="form-input" type="text" placeholder="e.g. John Smith" />
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
      <label class="form-label">Notes (optional)</label>
      <textarea v-model="form.notes" class="form-input form-textarea" rows="2" placeholder="Any additional notes..."></textarea>
    </div>

    <button class="btn btn-primary btn-add" @click="handleSubmit">Add Investor</button>
    <div class="error-msg">{{ errorMsg }}</div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'

const emit = defineEmits(['submit'])

const defaults = () => ({
  fullName: '', status: 'Active', notes: '',
})

const form = reactive(defaults())
const errorMsg = ref('')

function handleSubmit() {
  errorMsg.value = ''
  if (!form.fullName.trim()) { errorMsg.value = 'Investor name is required.'; return }
  emit('submit', { ...form })
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
