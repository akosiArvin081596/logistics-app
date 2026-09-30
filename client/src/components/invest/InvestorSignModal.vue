<template>
  <div v-if="show" class="modal-overlay">
    <div class="modal-fullscreen" role="dialog" aria-modal="true" :aria-label="doc?.doc_name || 'Document'">
      <!-- Header bar -->
      <div class="modal-header">
        <div class="modal-title">{{ doc?.doc_name || 'Document' }}</div>
        <button type="button" class="modal-close" aria-label="Close" @click="$emit('close')">&times;</button>
      </div>

      <!-- Two-panel body -->
      <div class="modal-body">
        <!-- Left: PDF viewer -->
        <div class="pdf-panel">
          <iframe v-if="pdfUrl" :src="pdfUrl" class="pdf-frame"></iframe>
          <!-- A refused or failed preview says so and offers a retry; the sign
               panel beside it keeps whatever the signer has entered. -->
          <div v-else-if="pdfError" class="pdf-placeholder pdf-error" role="alert" data-test="preview-error">
            <span>{{ pdfError }}</span>
            <button type="button" class="pdf-retry" data-test="preview-retry" @click="$emit('retry-preview')">Try again</button>
          </div>
          <div v-else class="pdf-placeholder">Loading document...</div>
        </div>

        <!-- Right: Sign panel -->
        <div class="sign-panel">
          <div v-if="doc && !doc.signed" class="sign-content">
            <div v-if="notice" class="sign-notice" role="status" data-test="sign-terms-notice">{{ notice }}</div>
            <InvitePaymentTermsCard v-if="paymentTerms" :payment-terms="paymentTerms" data-test="sign-terms" />
            <div class="sign-panel-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              Sign Document
            </div>

            <label class="sign-checkbox">
              <input type="checkbox" v-model="state.agreed" />
              <span>{{ SIGNING_CONSENT_TEXT }}</span>
            </label>

            <div class="sign-field name-field">
              <label class="sign-field-label">Full Name</label>
              <input
                v-model="state.signatureText" type="text" class="sign-input"
                placeholder="Type your full name" :disabled="!state.agreed"
                @focus="openNameDrop"
                @blur="closeNameDropSoon"
              />
              <div v-if="state.nameDropOpen && state.agreed && filteredNames.length" class="name-dropdown">
                <div
                  v-for="name in filteredNames" :key="name" class="name-option"
                  @mousedown.prevent="pickName(name)"
                >{{ name }}</div>
              </div>
            </div>

            <div class="sign-field">
              <label class="sign-field-label">
                Draw your signature
                <button v-if="state.hasDrawn" class="canvas-clear" @click="clearCanvas">Clear</button>
              </label>
              <div class="canvas-wrapper" :class="{ disabled: !state.agreed }">
                <!-- `pointercancel` is NOT optional here, and `pointerleave` does not
                     cover it: startDraw() calls setPointerCapture, and a captured
                     pointer cannot leave the element, so once a stroke has begun
                     pointerleave never fires. The browser cancels a gesture on its
                     own (a touch reinterpreted as a scroll, a system gesture, an
                     incoming call), and that path emits pointercancel and nothing
                     else — so without this binding the stroke never ends and
                     `isDrawing` stays true. Same terminator on both, exactly as
                     ZoomableImage.vue / PdfZoomViewer.vue bind theirs. -->
                <canvas
                  ref="canvasRef" class="sig-canvas"
                  @pointerdown="startDraw" @pointermove="draw"
                  @pointerup="endDraw" @pointerleave="endDraw" @pointercancel="endDraw"
                ></canvas>
              </div>
            </div>

            <button class="sign-btn" :disabled="!state.agreed || !state.signatureText.trim() || !state.hasDrawn" @click="handleSign">
              Sign Document
            </button>
          </div>

          <div v-else-if="doc?.signed" class="sign-done" :class="{ 'with-terms': paymentTerms }">
            <InvitePaymentTermsCard v-if="paymentTerms" :payment-terms="paymentTerms" data-test="sign-terms" />
            <div class="sign-done-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            </div>
            <div class="sign-done-title">Document Signed</div>
            <div class="sign-done-text">Signed by {{ doc.signatureText }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { SIGNING_CONSENT_TEXT, buildConsent } from '../../lib/signingConsent'
import InvitePaymentTermsCard from './InvitePaymentTermsCard.vue'

const props = defineProps({
  show: { type: Boolean, default: false },
  doc: { type: Object, default: null },
  pdfUrl: { type: String, default: '' },
  // Why the preview is not showing, when it failed; the pane offers a retry.
  pdfError: { type: String, default: '' },
  suggestedNames: { type: Array, default: () => [] },
  // The invitation's terms, read-only, beside the document they amend. The
  // parent passes them only for the master agreement and the lease, and only
  // while an invitation with non-standard terms is active; otherwise null.
  paymentTerms: { type: Object, default: null },
  // Shown above the terms when they changed while the applicant was signing.
  notice: { type: String, default: '' },
})
const emit = defineEmits(['close', 'signed', 'retry-preview'])

// Template ref only — a DOM handle, not signer state. It stays outside
// blankState() because <script setup> binds `ref="canvasRef"` by matching the
// variable NAME, and because the v-if below repopulates it on every open.
const canvasRef = ref(null)

// ─────────────────────────────────────────────────────────────────────────────
// ONE object holds every piece of state an investor puts into this modal, and
// resetting it is ONE assignment. Same shape as DrugTestUpload.vue and the
// driver's DocumentSignModal.vue, for the same reason: the root element below is
// `v-if`'d but the COMPONENT is mounted unconditionally by InvestorApplyView, so
// the instance never unmounts and whatever is left here is armed the next time
// it opens — on the next legal document, and potentially for a different signer.
//
// The hand-written reset this replaces listed three fields and omitted
// `isDrawing`, which is the entire gate `draw()` checks. A stroke the browser
// cancelled (see the pointercancel note in the template) left it true forever,
// so on the NEXT open the first pointer move across the canvas drew a stroke
// with no pointerdown — an unintended mark flattened into a signed PDF and
// stored as a legal record. It also omitted `nameDropOpen`. A field added to
// blankState() is cleared for free; a field added to a list of assignments is
// the next field somebody forgets.
// ─────────────────────────────────────────────────────────────────────────────
function blankState() {
  return {
    agreed: false,        // consent checkbox; transmitted, not just enforced
    signatureText: '',
    isDrawing: false,     // ⚠️ the gate draw() checks — must reset with the rest
    hasDrawn: false,      // arms the Sign button and the Clear link
    nameDropOpen: false,  // the suggested-names dropdown
  }
}

const state = ref(blankState())

const filteredNames = computed(() => {
  const q = state.value.signatureText.toLowerCase()
  const names = props.suggestedNames.filter(n => n)
  if (!q) return names
  return names.filter(n => n.toLowerCase().includes(q))
})

// Reset on BOTH edges of `show`. Opening inherits nothing (that is what stops
// the stray mark); closing releases the typed name rather than leaving one
// investor's details behind a modal nobody has open.
//
// `immediate` is load-bearing the day anyone adds `v-if="showSignModal"` to the
// call site in InvestorApplyView (belt and braces against this component being
// mounted forever, and a sensible thing to want). That mounts the component with
// `show` ALREADY true, so a non-immediate watcher never fires at all and
// initCanvas() never runs — measured: canvas.width stays 0 and the context keeps
// its default stroke, i.e. toDataURL() hands the server a blank signature for a
// document the signer watched themselves sign. It is a no-op today: on mount
// `show` is false, so the callback rebuilds the (already blank) state and returns.
watch(() => props.show, async (v) => {
  state.value = blankState()
  if (v) window.addEventListener('keydown', onKeydown, true)
  else window.removeEventListener('keydown', onKeydown, true)
  if (!v) return
  await nextTick()
  initCanvas()
}, { immediate: true })

// Escape closes this dialog, and only this dialog. The guided tour on /invest
// also closes on Escape (a bubbling listener on window); this one listens in the
// capture phase and stops the key there, so one press closes the layer on top
// instead of the tour hidden underneath it.
function onKeydown(e) {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  emit('close')
}
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

// ⚠️ This ran as an inline template expression, `window.setTimeout(...)`, and
// it THREW on every blur. `window` is not one of the globals Vue allows in a
// template expression, so the compiler emits `_ctx.window` — which resolves to
// undefined, because a <script setup> component exposes no setup bindings on
// that proxy and nothing here registers a `window` global property. Every blur
// of this field raised `TypeError: Cannot read properties of undefined
// (reading 'setTimeout')` and the dropdown never closed, which is also how a
// stale `nameDropOpen` came to be visible in the first place. In a module the
// bare global is simply in scope, matching the other 26 timers in client/src.
// The delay is unchanged: it lets a mousedown on an option land before the list
// closes. `s` is captured so a timer that fires after a close writes to the
// orphaned state object rather than the form now on screen.
//
// ⚠️ OPENING MUST CANCEL A PENDING CLOSE. `@focus` was the inline expression
// `state.nameDropOpen = true`, which set the flag and left the timer running, so
// blurring and clicking straight back into the field inside the 200 ms window let
// that timer shut the list while the field was focused. The captured `s` does NOT
// cover this case and was never meant to: it protects across a modal open/close,
// where the watch on `props.show` swaps in a fresh blankState() — but within one
// signing session `s` IS the object on screen, so the stale timer closes the live
// list. The flag and the timer are two halves of one piece of state; every handler
// touching one touches the other, which is why opening is a named function too.
// Same fix, same reasoning, as the three dropdowns in InvestorApplyView.
let nameDropTimer = null
function openNameDrop() {
  clearTimeout(nameDropTimer)
  nameDropTimer = null
  state.value.nameDropOpen = true
}
function closeNameDropSoon() {
  const s = state.value
  clearTimeout(nameDropTimer)
  nameDropTimer = setTimeout(() => { s.nameDropOpen = false }, 200)
}

function pickName(name) {
  state.value.signatureText = name
  state.value.nameDropOpen = false
}

function initCanvas() {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.parentElement.getBoundingClientRect()
  canvas.width = rect.width
  canvas.height = rect.height || 150
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = '#1a1d27'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
}

function getPos(e) {
  const canvas = canvasRef.value
  const rect = canvas.getBoundingClientRect()
  return { x: (e.clientX || e.touches?.[0]?.clientX || 0) - rect.left, y: (e.clientY || e.touches?.[0]?.clientY || 0) - rect.top }
}

function startDraw(e) {
  if (!state.value.agreed) return
  state.value.isDrawing = true
  const ctx = canvasRef.value.getContext('2d')
  const pos = getPos(e)
  ctx.beginPath()
  ctx.moveTo(pos.x, pos.y)
  canvasRef.value.setPointerCapture(e.pointerId)
}

function draw(e) {
  if (!state.value.isDrawing) return
  const ctx = canvasRef.value.getContext('2d')
  const pos = getPos(e)
  ctx.lineTo(pos.x, pos.y)
  ctx.stroke()
  state.value.hasDrawn = true
}

// The one terminator, bound to pointerup, pointerleave AND pointercancel.
function endDraw() { state.value.isDrawing = false }
function clearCanvas() { state.value.hasDrawn = false; initCanvas() }

function handleSign() {
  const signatureImage = canvasRef.value?.toDataURL('image/png') || null
  emit('signed', {
    docKey: props.doc.doc_key,
    text: state.value.signatureText.trim(),
    image: signatureImage,
    // Carried per document, not once for the whole application: the investor
    // ticks this box separately for the master agreement, the lease and the
    // W-9, and one blanket flag would assert three agreements from one act.
    consent: buildConsent(state.value.agreed),
  })
}
</script>

<style scoped>
/* ─── Fullscreen overlay ─── */
/* Above the /invest guided tour, whose layers run from 9997 to 9999
   (client/src/wizard/components). At 999 the tour's minimized "Guide" tab sat
   on this dialog's close button, so after signing the x could not be clicked.
   No tour step points inside this dialog, so nothing it guides is covered. */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); z-index: 10000;
  display: flex; align-items: center; justify-content: center;
}
.modal-fullscreen {
  background: #fff; width: 100vw; height: 100vh;
  display: flex; flex-direction: column;
}

/* ─── Header ─── */
.modal-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.75rem 1.25rem; border-bottom: 1px solid #e8edf2;
  flex-shrink: 0;
}
.modal-title { font-weight: 700; font-size: 1.05rem; color: #0f172a; }
.modal-close {
  font-size: 1.6rem; background: none; border: none; cursor: pointer;
  color: #6b7085; width: 36px; height: 36px; display: flex;
  align-items: center; justify-content: center; border-radius: 8px;
  transition: background 0.15s;
}
.modal-close:hover { background: #f1f5f9; }

/* ─── Two-panel body ─── */
.modal-body {
  flex: 1; display: flex; overflow: hidden;
}

/* ─── Left: PDF ─── */
.pdf-panel {
  flex: 1; background: #f5f5f5; overflow: hidden;
}
.pdf-frame { width: 100%; height: 100%; border: none; }
.pdf-placeholder {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: #6b7085; font-size: 0.9rem;
}
.pdf-error { flex-direction: column; gap: 0.85rem; padding: 1.5rem; text-align: center; }
.pdf-retry {
  padding: 0.55rem 1.3rem; background: #0f2847; color: #fff; border: none;
  border-radius: 10px; font-weight: 700; font-size: 0.85rem; cursor: pointer;
  font-family: inherit; transition: background 0.15s;
}
.pdf-retry:hover { background: #1a3a6b; }
.pdf-retry:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
/* ─── Right: Sign panel ─── */
.sign-panel {
  width: 340px; flex-shrink: 0;
  border-left: 1px solid #e8edf2;
  display: flex; flex-direction: column;
  background: #fafbfd;
}

.sign-content {
  flex: 1; display: flex; flex-direction: column;
  padding: 1.25rem; gap: 1rem; overflow-y: auto;
}

.sign-panel-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 1rem; font-weight: 700; color: #0f172a;
  padding-bottom: 0.75rem; border-bottom: 1px solid #e8edf2;
}
.sign-panel-title svg { color: #3b82f6; }

/* ─── Fields ─── */
.sign-checkbox {
  display: flex; align-items: flex-start; gap: 0.5rem;
  font-size: 0.82rem; cursor: pointer; color: #475569;
}
.sign-field { display: flex; flex-direction: column; gap: 0.3rem; }
.name-field { position: relative; }
.name-dropdown {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 10;
  background: #fff; border: 1px solid #e2e4ea; border-radius: 8px;
  margin-top: 2px; max-height: 120px; overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
.name-option {
  padding: 0.5rem 0.75rem; font-size: 0.85rem; cursor: pointer;
  color: #0f172a; transition: background 0.1s;
}
.name-option:hover { background: #f1f5f9; }
.sign-field-label {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 0.78rem; font-weight: 600; color: #475569;
}
.sign-input {
  width: 100%; padding: 0.55rem 0.75rem; border: 1px solid #e2e4ea; border-radius: 8px;
  font-size: 1.1rem; font-family: 'Dancing Script', cursive; font-style: italic; background: #fff;
}
.sign-input:disabled { opacity: 0.4; }

/* ─── Canvas ─── */
.canvas-wrapper { position: relative; }
.canvas-wrapper.disabled { opacity: 0.35; pointer-events: none; }
.canvas-clear {
  font-size: 0.72rem; color: #3b82f6; background: none;
  border: none; cursor: pointer; font-weight: 600;
}
.sig-canvas {
  width: 100%; height: 140px; border: 1px solid #e2e4ea;
  border-radius: 8px; cursor: crosshair; touch-action: none; background: #fff;
}

/* ─── Sign button ─── */
.sign-btn {
  width: 100%; padding: 0.7rem; background: #0f2847; color: white; border: none;
  border-radius: 10px; font-weight: 700; font-size: 0.9rem; cursor: pointer;
  transition: background 0.15s; margin-top: auto;
}
.sign-btn:hover:not(:disabled) { background: #1a3a6b; }
.sign-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* ─── Terms-changed notice and terms card ─── */
.sign-notice {
  background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;
  padding: 0.6rem 0.8rem; font-size: 0.78rem; color: #1d4ed8; line-height: 1.5;
}
/* The column's own gap spaces the card here. */
.sign-content > .terms-card,
.sign-done > .terms-card { margin-bottom: 0; flex-shrink: 0; }

/* ─── Signed state ─── */
.sign-done {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 0.75rem;
  padding: 2rem; text-align: center;
}
/* With the terms card on top the column can outgrow the panel, and a centred
   column that overflows cannot be scrolled back to its top. */
.sign-done.with-terms {
  justify-content: flex-start; align-items: stretch; overflow-y: auto;
  padding: 1.25rem;
}
.sign-done.with-terms .sign-done-icon { align-self: center; }
.sign-done-icon {
  width: 56px; height: 56px; border-radius: 50%;
  background: #dcfce7; color: #16a34a;
  display: flex; align-items: center; justify-content: center;
}
.sign-done-title { font-size: 1.1rem; font-weight: 700; color: #0f172a; }
.sign-done-text { font-size: 0.85rem; color: #64748b; }

/* ─── Mobile ─── */
@media (max-width: 768px) {
  .modal-body { flex-direction: column; }
  .sign-panel { width: 100%; border-left: none; border-top: 1px solid #e8edf2; max-height: 45vh; }
  .pdf-panel { min-height: 40vh; }
}
</style>
