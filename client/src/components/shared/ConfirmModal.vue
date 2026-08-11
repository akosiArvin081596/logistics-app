<template>
  <Teleport to="body">
    <!-- pointerdown is stopped because reka-ui's DismissableLayer listens for it
         on the document to decide "clicked outside". This overlay teleports to
         <body>, i.e. outside any open Dialog's content, so without this a click
         anywhere in the confirm — including Cancel — also dismisses the load
         dialog underneath and dumps the user back to the table. Cancelling a
         delete should leave you exactly where you were. -->
    <div
      v-if="open"
      ref="overlayRef"
      class="confirm-overlay"
      @pointerdown.stop
      @click.self="$emit('cancel')"
    >
      <div
        ref="dialogRef"
        class="confirm-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="messageId"
      >
        <h3 :id="titleId">{{ title }}</h3>
        <p :id="messageId">{{ message }}</p>
        <!-- Optional extra content (e.g. a required reason field). Callers that
             pass no slot render exactly as before. -->
        <div v-if="$slots.default" class="confirm-body"><slot /></div>
        <div class="confirm-actions">
          <!-- Cancel is FIRST in the DOM and is what receives initial focus.
               Both facts are deliberate: this component gates deletes, load
               cancellations and a full database export, so the element a
               keyboard user lands on — and therefore the one a reflexive
               Enter or Space activates — must be the safe one. Never move
               initial focus to the confirm button, and never reorder these
               two so that the confirm becomes the first tab stop. -->
          <button ref="cancelBtnRef" type="button" class="btn btn-secondary" @click="$emit('cancel')">{{ cancelText }}</button>
          <button
            type="button"
            :class="['btn', danger ? 'btn-danger' : 'btn-primary']"
            :disabled="confirmDisabled"
            @click="$emit('confirm')"
          >
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: 'Confirm' },
  message: { type: String, default: 'Are you sure?' },
  confirmText: { type: String, default: 'Confirm' },
  cancelText: { type: String, default: 'Cancel' },
  danger: { type: Boolean, default: false },
  // Lets a caller gate the confirm button on its own validity (e.g. a required
  // reason). Defaults false so existing callers are unaffected.
  confirmDisabled: { type: Boolean, default: false },
})

const emit = defineEmits(['confirm', 'cancel'])

const overlayRef = ref(null)
const dialogRef = ref(null)
const cancelBtnRef = ref(null)

// Per-instance ids, NOT a constant string. Several ConfirmModals are mounted at
// once on some screens (ActiveLoadsTab and JobBoardTab each hold three), and
// duplicate ids would point aria-labelledby at whichever copy the browser found
// first — i.e. the wrong dialog's title.
const uid = useId()
const titleId = `confirm-modal-title-${uid}`
const messageId = `confirm-modal-message-${uid}`

// Every element type an operator could tab to inside the dialog. Kept identical
// to MaintenanceModal's so the two dialogs trap focus the same way, and so a
// control added to the markup later participates without touching trapTab().
// With no slot this resolves to exactly the two buttons; the callers that pass a
// required-reason field get a three-stop cycle, and a DISABLED confirm button
// drops out of the cycle on its own via :not([disabled]).
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// The element focused immediately before the confirm opened — normally the
// button that triggered it. Restored on close so a keyboard user lands back on
// the row they were acting on instead of at <body>.
let previouslyFocusedEl = null

function trapTab(event) {
  const dialogEl = dialogRef.value
  if (!dialogEl) return
  const focusable = Array.from(dialogEl.querySelectorAll(FOCUSABLE_SELECTOR))
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function onKeydown(event) {
  if (!props.open) return
  if (event.key === 'Escape') {
    // ⚠️ BOTH guards are load-bearing, and adding this handler without them is
    // strictly worse than having no Escape at all. reka-ui's DismissableLayer
    // (under every load-detail Dialog this confirm opens on top of) listens for
    // Escape via vueuse onKeyStroke, i.e. on `window`, and dismisses itself
    // unless the event is defaultPrevented. So an unguarded Escape closes the
    // confirm AND the dialog underneath, dumping the user back to the table —
    // the same "cancelling should leave you where you were" rule the
    // pointerdown.stop in the template exists for.
    //   preventDefault() is the library-sanctioned opt-out (it checks
    //   defaultPrevented before dismissing);
    //   stopPropagation() is the structural one (this listener is on `document`,
    //   which a bubbling keydown reaches strictly before `window`).
    // They are independent on purpose: either alone is sufficient today, and
    // keeping both means a reka-ui release that moves the listener or drops the
    // defaultPrevented check cannot silently reintroduce the bug.
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
  } else if (event.key === 'Tab') {
    trapTab(event)
  }
}

// ⚠️ Focus, not just clicks, has to be taken off the layer underneath.
// reka-ui's modal DialogContent runs a real focus TRAP (FocusScope trapped):
// document-level focusin/focusout handlers that yank focus back into its own
// container the moment it lands anywhere else. This overlay teleports to
// <body> — deliberately outside that container — so without this guard the
// Cancel button below is focused and instantly stolen back into the dialog,
// and Tab can never reach the confirm at all. That would leave the confirm
// looking keyboard-accessible while being exactly as unreachable as before.
// Capture phase on `document` is what makes it work: it runs before reka-ui's
// own bubble-phase handlers regardless of registration order. Scoped to events
// that actually involve this overlay, so nothing else on the page is affected,
// and only while `open` — this is the same argument the template's
// @pointerdown.stop already makes, extended from pointer events to focus.
function onFocusEventCapture(event) {
  if (!props.open) return
  const overlay = overlayRef.value
  if (!overlay) return
  // contains(null) is false, so a null relatedTarget needs no special case.
  if (overlay.contains(event.target) || overlay.contains(event.relatedTarget)) {
    event.stopPropagation()
  }
}

function addListeners() {
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('focusin', onFocusEventCapture, true)
  document.addEventListener('focusout', onFocusEventCapture, true)
}

function removeListeners() {
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('focusin', onFocusEventCapture, true)
  document.removeEventListener('focusout', onFocusEventCapture, true)
}

// Bound to `open` rather than mount, unlike MaintenanceModal — that one is
// mounted once for the whole session, whereas this component has 15 instances
// and several are mounted simultaneously per screen. Attaching on open keeps
// exactly one set of listeners live: the open modal's.
watch(
  () => props.open,
  async (isOpen, wasOpen) => {
    if (isOpen) {
      previouslyFocusedEl = document.activeElement
      addListeners()
      await nextTick()
      cancelBtnRef.value?.focus()
    } else if (wasOpen) {
      removeListeners()
      // isConnected because a confirmed destructive action often unmounts the
      // trigger (and sometimes the whole dialog) in the same tick; focusing a
      // detached node would silently drop focus to <body>.
      if (previouslyFocusedEl?.isConnected) previouslyFocusedEl.focus?.()
      previouslyFocusedEl = null
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  // Required cleanup — these live on `document`, not this component's own DOM,
  // so Vue will not remove them on unmount. A confirm can absolutely be
  // unmounted while open (v-if on a parent, or a route change), which would
  // otherwise leave a keydown handler emitting into a torn-down component for
  // the rest of the page's life. removeEventListener on an already-removed
  // listener is a no-op, so this is safe to call unconditionally.
  removeListeners()
})
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
  /* Callers compose multi-line summaries (load id / route / payment) so the
     operator can see exactly what they are acting on. */
  white-space: pre-line;
}
.confirm-body {
  margin-bottom: 1.25rem;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.confirm-actions .btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
