<template>
  <Teleport to="body">
    <div v-if="open" class="confirm-overlay" @click.self="$emit('cancel')">
      <div class="confirm-dialog">
        <h3>{{ title }}</h3>
        <p>{{ message }}</p>
        <div class="confirm-actions">
          <button class="btn btn-secondary" @click="$emit('cancel')">Cancel</button>
          <button :class="['btn', danger ? 'btn-danger' : 'btn-primary']" @click="$emit('confirm')">
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: 'Confirm' },
  message: { type: String, default: 'Are you sure?' },
  confirmText: { type: String, default: 'Confirm' },
  danger: { type: Boolean, default: false },
})

defineEmits(['confirm', 'cancel'])
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
  max-width: 400px;
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
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
