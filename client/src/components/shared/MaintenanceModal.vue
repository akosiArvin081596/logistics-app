<template>
  <Teleport to="body">
    <!-- pointerdown is stopped for the same reason ConfirmModal stops it: this
         overlay teleports to <body>, so if it ever ends up open while a
         reka-ui Dialog is underneath, that Dialog's DismissableLayer (which
         listens for pointerdown on the document to detect "click outside")
         would otherwise treat any click here — including our own buttons —
         as a click outside itself and steal the interaction. Stopping
         propagation keeps every click in this popup scoped to this popup. -->
    <div
      v-if="maintenance.showModal"
      class="maintenance-overlay"
      @pointerdown.stop
      @click.self="close"
    >
      <div
        ref="dialogRef"
        class="maintenance-dialog animate-fadeInUp"
        role="dialog"
        aria-modal="true"
        aria-labelledby="maintenance-modal-title"
        aria-describedby="maintenance-modal-message"
      >
        <button type="button" class="maintenance-close" aria-label="Close" @click="close">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false">
            <line x1="5" y1="5" x2="19" y2="19" />
            <line x1="19" y1="5" x2="5" y2="19" />
          </svg>
        </button>

        <!-- Maintenance/gear glyph, built from plain circle + line primitives
             (not a copied icon-library path) so it's guaranteed to render
             correctly without pulling in an icon dependency. -->
        <div class="maintenance-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" focusable="false">
            <circle cx="12" cy="12" r="4.5" />
            <line x1="16.5" y1="12" x2="20" y2="12" />
            <line x1="15.18" y1="15.18" x2="17.66" y2="17.66" />
            <line x1="12" y1="16.5" x2="12" y2="20" />
            <line x1="8.82" y1="15.18" x2="6.34" y2="17.66" />
            <line x1="7.5" y1="12" x2="4" y2="12" />
            <line x1="8.82" y1="8.82" x2="6.34" y2="6.34" />
            <line x1="12" y1="7.5" x2="12" y2="4" />
            <line x1="15.18" y1="8.82" x2="17.66" y2="6.34" />
          </svg>
        </div>

        <!-- modalTitle, NOT title — the banner's uppercase headline and this
             popup's sentence are deliberately different strings. -->
        <h3 id="maintenance-modal-title" class="maintenance-title">{{ maintenance.modalTitle }}</h3>
        <p id="maintenance-modal-message" class="maintenance-message">{{ maintenance.message }}</p>

        <!-- Set apart from the body copy on purpose — this is a caveat about
             the figures shown elsewhere in the portal, not more filler text,
             so it gets its own tinted/accented box rather than blending in. -->
        <div class="maintenance-disclaimer">
          <svg class="maintenance-disclaimer-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <circle cx="12" cy="7.7" r="0.75" fill="currentColor" stroke="none" />
          </svg>
          <p>{{ maintenance.disclaimer }}</p>
        </div>

        <div class="maintenance-actions">
          <button ref="primaryBtnRef" type="button" class="btn btn-primary" @click="close">
            Got it, continue to my portal
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMaintenanceStore } from '../../stores/maintenance'

const maintenance = useMaintenanceStore()

const dialogRef = ref(null)
const primaryBtnRef = ref(null)

// Every element type an operator could tab to inside the dialog. Centralized
// here so trapTab() and any future control added to the markup automatically
// participate without the trap logic itself needing to change.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// The element that had focus immediately before the popup opened. Restored
// on close so a keyboard user lands back exactly where they were instead of
// at <body> — losing tab position on every login popup would be a real
// regression for anyone not using a mouse.
let previouslyFocusedEl = null

// The body's inline `overflow` value from BEFORE we locked scrolling.
// Restored verbatim on close rather than reset to '' — some other overlay
// already open underneath this one may have set its own inline overflow,
// and blindly clearing it would silently re-enable page scroll while that
// other overlay is still up.
let previousBodyOverflow = null

function lockScroll() {
  previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
}

function unlockScroll() {
  document.body.style.overflow = previousBodyOverflow ?? ''
  previousBodyOverflow = null
}

// Every dismissal path — the X, the primary button, Escape, and the backdrop
// click — funnels through here, so there is exactly one place that persists
// the dismissal for the session. This is a courtesy notice, not a gate:
// closing it never blocks, disables, or gates anything else in the app.
function close() {
  maintenance.dismissModal()
}

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
  // Single always-on listener (added once in onMounted, removed once in
  // onBeforeUnmount) rather than attached/detached on every open/close —
  // fewer moving parts, and it can never end up "open but forgot to attach."
  if (!maintenance.showModal) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  } else if (event.key === 'Tab') {
    trapTab(event)
  }
}

// Single place that drives every open/close side effect. All four dismissal
// paths just call close() -> dismissModal(); this watcher reacts to the
// resulting showModal flip, so focus save/restore and scroll lock/unlock
// stay symmetric instead of duplicated per handler. `immediate: true` covers
// the edge case where showModal is already true the moment this component
// is set up — in the normal case (false at mount, flips true once the
// App.vue-owned config fetch resolves) the immediate call is a no-op.
watch(
  () => maintenance.showModal,
  async (isOpen, wasOpen) => {
    if (isOpen) {
      previouslyFocusedEl = document.activeElement
      lockScroll()
      await nextTick()
      primaryBtnRef.value?.focus()
    } else if (wasOpen) {
      unlockScroll()
      previouslyFocusedEl?.focus?.()
      previouslyFocusedEl = null
    }
  },
  { immediate: true }
)

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  // Required cleanup — this listener lives on `document`, not this
  // component's own DOM, so Vue won't remove it automatically on unmount.
  // Leaving it attached would keep firing (against a torn-down component)
  // for the rest of the page's life.
  document.removeEventListener('keydown', onKeydown)
  // Belt-and-suspenders: App.vue mounts this once for the whole session so
  // unmounting mid-open shouldn't happen, but if it ever does, don't leave
  // the page permanently unscrollable.
  if (previousBodyOverflow !== null) unlockScroll()
})
</script>

<style scoped>
.maintenance-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  /* Above EVERY other overlay in the app by construction. The codebase's
     existing dialogs sit at 9999-10002 and DriveModeOverlay at 99999, so a
     modest value here could leave this popup invisible underneath one of
     them while its watcher still stole focus and locked scroll — the focus
     trap would then cycle two buttons nobody can see. A maintenance notice
     is always the topmost thing on screen, so it takes the top layer. */
  z-index: 100000;
  /* REQUIRED, not cosmetic — see the pointerdown comment in the template. */
  pointer-events: auto;
  animation: maintenance-overlay-fade 0.2s ease-out;
}

.maintenance-dialog {
  position: relative;
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow-elevated);
  padding: 1.75rem;
  max-width: 440px;
  width: 90%;
  max-height: 90vh;
  overflow-y: auto;
  text-align: center;
}

.maintenance-close {
  position: absolute;
  top: 0.85rem;
  right: 0.85rem;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}
.maintenance-close:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.maintenance-icon {
  width: 56px;
  height: 56px;
  margin: 0 auto 1rem;
  border-radius: 50%;
  background: var(--amber-dim);
  color: var(--amber);
  display: flex;
  align-items: center;
  justify-content: center;
}

.maintenance-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 0.5rem;
}

.maintenance-message {
  font-size: 0.875rem;
  color: var(--text-dim);
  line-height: 1.5;
  margin-bottom: 1.25rem;
  /* Server-controlled copy (same category as ConfirmModal's message prop) —
     preserve any line breaks it comes with instead of collapsing them. */
  white-space: pre-line;
}

/* Tinted background + left accent border — deliberately a different
   treatment from this file's own body copy (and from the app-wide
   .modal-callout, which uses an all-around border) so the disclaimer reads
   unmistakably as a distinct caveat, not more paragraph text. */
.maintenance-disclaimer {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  text-align: left;
  background: var(--amber-dim);
  border-left: 3px solid var(--amber);
  border-radius: 0 8px 8px 0;
  padding: 0.7rem 0.9rem;
  margin-bottom: 1.5rem;
}
.maintenance-disclaimer-icon {
  flex-shrink: 0;
  margin-top: 0.15rem;
  color: var(--amber);
}
.maintenance-disclaimer p {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text);
  line-height: 1.45;
}

.maintenance-actions {
  display: flex;
  justify-content: center;
}

@keyframes maintenance-overlay-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .maintenance-overlay {
    animation: none;
  }
  .maintenance-dialog.animate-fadeInUp {
    animation: none;
  }
}

@media (max-width: 480px) {
  .maintenance-dialog {
    padding: 1.5rem 1.25rem;
  }
  .maintenance-actions {
    flex-direction: column;
  }
  .maintenance-actions .btn {
    width: 100%;
  }
}
</style>
