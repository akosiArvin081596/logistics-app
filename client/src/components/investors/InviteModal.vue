<template>
  <Teleport to="body">
    <div v-if="open" class="im-overlay" @click.self="closeOnBackdrop && $emit('close')">
      <div
        ref="dialogRef"
        class="im-dialog"
        :class="{ 'im-wide': wide }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <div class="im-head">
          <h3 :id="titleId" class="im-title">{{ title }}</h3>
          <button type="button" class="im-close" aria-label="Close" @click="$emit('close')">&times;</button>
        </div>
        <slot />
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { nextTick, onUpdated, ref, useId, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  wide: { type: Boolean, default: false },
  // Off for a form: a stray click beside it must not throw away what was typed.
  closeOnBackdrop: { type: Boolean, default: true },
  // Off for content that cannot be shown again (a link shown once): only an
  // explicit Close or Done button closes it.
  closeOnEscape: { type: Boolean, default: true },
})

const emit = defineEmits(['close'])

const titleId = `invite-modal-title-${useId()}`
const dialogRef = ref(null)
let returnFocusTo = null

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    if (props.closeOnEscape) emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const focusable = Array.from(dialogRef.value?.querySelectorAll(FOCUSABLE) || [])
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

// A control removed while it has focus (a preview's Try again, replaced by the
// loading line) leaves focus on <body>, outside this dialog, where Escape and
// the Tab trap above no longer hear the keyboard. Focus comes back to the dialog.
onUpdated(() => {
  if (!props.open) return
  const active = document.activeElement
  if (!active || active === document.body) dialogRef.value?.focus()
})

watch(
  () => props.open,
  async (isOpen, wasOpen) => {
    if (isOpen) {
      returnFocusTo = document.activeElement
      await nextTick()
      const target = dialogRef.value?.querySelector('[autofocus]') || dialogRef.value
      target?.focus()
    } else if (wasOpen) {
      if (returnFocusTo?.isConnected) returnFocusTo.focus?.()
      returnFocusTo = null
    }
  },
  { immediate: true },
)
</script>

<style scoped>
.im-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 1rem;
}
.im-dialog {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 1.25rem 1.5rem 1.5rem;
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--shadow-elevated);
}
.im-dialog:focus { outline: none; }
.im-wide {
  max-width: 900px;
  display: flex;
  flex-direction: column;
}
.im-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.im-title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text);
  margin: 0;
}
.im-close {
  font-size: 1.5rem;
  line-height: 1;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-dim);
  padding: 0 0.25rem;
}
.im-close:hover { color: var(--text); }
.im-close:focus-visible { outline: 2px solid var(--accent); border-radius: 4px; }
</style>
