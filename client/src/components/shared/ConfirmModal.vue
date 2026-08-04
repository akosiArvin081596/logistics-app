<template>
  <Teleport to="body">
    <!-- pointerdown is stopped because reka-ui's DismissableLayer listens for it
         on the document to decide "clicked outside". This overlay teleports to
         <body>, i.e. outside any open Dialog's content, so without this a click
         anywhere in the confirm — including Cancel — also dismisses the load
         dialog underneath and dumps the user back to the table. Cancelling a
         delete should leave you exactly where you were. -->
    <div v-if="open" class="confirm-overlay" @pointerdown.stop @click.self="$emit('cancel')">
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
  /* REQUIRED, not cosmetic. This teleports to <body>, and reka-ui's modal Dialog
     sets `body { pointer-events: none }` while it is open, restoring `auto` only
     inside its own layer. A confirm opened from within a load-detail dialog
     therefore inherits `none` and every button in it is dead — Cancel and Confirm
     both silently do nothing, and Escape (which closes the whole dialog) is the
     only way out. That was the state of the Super Admin "Delete this load?"
     confirm in ActiveLoadsTab and JobBoardTab. z-index 200 already clears the
     dialog's z-50, so stacking was never the issue — only hit-testing. */
  pointer-events: auto;
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
