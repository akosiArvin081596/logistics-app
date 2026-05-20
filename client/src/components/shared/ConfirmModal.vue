<template>
  <Teleport to="body">
    <div v-if="open" class="confirm-overlay" @click.self="$emit('cancel')">
      <div class="confirm-dialog">
        <h3>{{ title }}</h3>
        <p v-if="message">{{ message }}</p>
        <div v-if="promptLabel" class="confirm-prompt">
          <label class="confirm-prompt-label">{{ promptLabel }}</label>
          <textarea
            v-model="promptValue"
            class="confirm-prompt-input"
            :placeholder="promptPlaceholder"
            rows="3"
            @keydown.enter.ctrl.prevent="handleConfirm"
          />
        </div>
        <div class="confirm-actions">
          <button class="btn btn-secondary" @click="$emit('cancel')">Cancel</button>
          <button
            :class="['btn', danger ? 'btn-danger' : 'btn-primary']"
            :disabled="promptRequired && !promptValue.trim()"
            @click="handleConfirm"
          >
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: 'Confirm' },
  message: { type: String, default: 'Are you sure?' },
  confirmText: { type: String, default: 'Confirm' },
  danger: { type: Boolean, default: false },
  promptLabel: { type: String, default: '' },
  promptPlaceholder: { type: String, default: '' },
  promptRequired: { type: Boolean, default: false },
})

const emit = defineEmits(['confirm', 'cancel'])
const promptValue = ref('')

watch(() => props.open, (v) => { if (v) promptValue.value = '' })

function handleConfirm() {
  if (props.promptRequired && !promptValue.value.trim()) return
  emit('confirm', props.promptLabel ? promptValue.value.trim() : undefined)
}
</script>

<style scoped>
.confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}
.confirm-dialog {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 1.5rem;
  max-width: 420px;
  width: 90%;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
}
.confirm-dialog h3 {
  font-size: 1rem;
  margin-bottom: 0.5rem;
}
.confirm-dialog p {
  font-size: 0.85rem;
  color: var(--text-dim);
  margin-bottom: 1.25rem;
}
.confirm-prompt {
  display: flex; flex-direction: column; gap: 0.35rem;
  margin-bottom: 1.25rem;
}
.confirm-prompt-label {
  font-size: 0.75rem; font-weight: 600; color: var(--text-dim);
}
.confirm-prompt-input {
  font-family: inherit; font-size: 0.85rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text);
  resize: vertical; min-height: 60px;
}
.confirm-prompt-input:focus {
  outline: none; border-color: var(--accent);
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
