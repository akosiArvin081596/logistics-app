<template>
  <div class="section config-section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--bg); color: var(--text-dim);">&#9881;</div>
      Fleet Configuration
      <span class="admin-badge">Admin Only</span>
    </div>

    <div class="config-grid">
      <div class="config-group">
        <label>Owner Take % <span class="hint">(fixed)</span></label>
        <input :value="50" type="number" disabled />
      </div>
      <div class="config-group">
        <label>Fuel Savings Target %</label>
        <input v-model.number="form.fuel_savings_target_pct" type="number" min="0" max="100" />
      </div>
      <div class="config-group full-width">
        <label>Blue Chip Brokers <span class="hint">(comma-separated)</span></label>
        <input v-model="form.blue_chip_brokers" type="text" placeholder="Pepsi, Coca-Cola, ..." />
      </div>
    </div>

    <p class="config-note">Per-truck settings (purchase price, title status, maintenance fund, fixed costs) are configured in the Truck Database.</p>

    <div class="config-actions">
      <button class="btn btn-primary" :disabled="saving" @click="handleSave">
        {{ saving ? 'Saving...' : 'Save Configuration' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'

const props = defineProps({
  config: { type: Object, default: null },
})

const emit = defineEmits(['save'])

const saving = ref(false)

const form = reactive({
  fuel_savings_target_pct: 15,
  blue_chip_brokers: '',
})

watch(() => props.config, (cfg) => {
  if (!cfg) return
  for (const key of Object.keys(form)) {
    if (key in cfg) form[key] = cfg[key]
  }
}, { immediate: true })

async function handleSave() {
  saving.value = true
  try {
    emit('save', { ...form })
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1.25rem;
}
.section-title {
  font-size: 0.95rem; font-weight: 700; margin-bottom: 1rem;
  display: flex; align-items: center; gap: 0.5rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: 0.9rem;
}
.admin-badge {
  margin-left: auto;
  font-size: 0.65rem; font-weight: 600;
  padding: 0.2rem 0.5rem; border-radius: 8px;
  background: var(--danger-dim); color: var(--danger);
  text-transform: uppercase; letter-spacing: 0.04em;
}

.config-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.config-group { display: flex; flex-direction: column; }
.config-group.full-width { grid-column: 1 / -1; }
.config-group label {
  font-size: 0.72rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.3rem;
}
.config-group .hint {
  font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 0.68rem;
}
.config-group input,
.config-group select {
  padding: 0.5rem 0.65rem; border: 1px solid var(--border);
  border-radius: 6px; font-family: inherit; font-size: 0.82rem;
  background: var(--bg); color: var(--text);
}
.config-group input:focus,
.config-group select:focus {
  outline: none; border-color: var(--blue);
}
.config-group input:disabled {
  opacity: 0.5; cursor: not-allowed;
}

.config-note {
  font-size: 0.75rem; color: var(--text-dim); margin-top: 0.75rem; font-style: italic;
}

.config-actions {
  margin-top: 1rem; display: flex; justify-content: flex-end;
}
.btn-primary {
  padding: 0.5rem 1.5rem; background: var(--accent); color: #fff;
  border: none; border-radius: 6px; font-family: inherit;
  font-size: 0.85rem; font-weight: 600; cursor: pointer;
}
.btn-primary:hover { opacity: 0.9; }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
