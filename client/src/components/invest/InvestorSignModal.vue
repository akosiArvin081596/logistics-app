<template>
  <div v-if="show" class="modal-overlay">
    <div class="modal-fullscreen">
      <!-- Header bar -->
      <div class="modal-header">
        <div class="modal-title">{{ doc?.doc_name || 'Document' }}</div>
        <button class="modal-close" @click="$emit('close')">&times;</button>
      </div>

      <!-- Two-panel body -->
      <div class="modal-body">
        <!-- Left: Document info -->
        <div class="pdf-panel">
          <div class="doc-info">
            <div class="doc-info-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <h3 class="doc-info-title">{{ doc?.doc_name }}</h3>
            <p class="doc-info-desc">{{ docDescription }}</p>
            <div class="doc-info-details">
              <div class="detail-row"><span class="detail-label">Applicant</span><span class="detail-value">{{ applicantName }}</span></div>
              <div v-if="applicantEntity" class="detail-row"><span class="detail-label">Entity</span><span class="detail-value">{{ applicantEntity }}</span></div>
              <div class="detail-row"><span class="detail-label">Date</span><span class="detail-value">{{ effectiveDate }}</span></div>
            </div>
            <p class="doc-info-note">By signing below, you acknowledge that you have read and agree to the terms of this document. The final signed PDF will be generated upon submission.</p>
          </div>
        </div>

        <!-- Right: Sign panel -->
        <div class="sign-panel">
          <div v-if="doc && !doc.signed" class="sign-content">
            <div class="sign-panel-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              Sign Document
            </div>

            <label class="sign-checkbox">
              <input type="checkbox" v-model="agreed" />
              <span>I have read and agree to the terms of this document</span>
            </label>

            <div class="sign-field name-field">
              <label class="sign-field-label">Full Name</label>
              <input
                v-model="signatureText" type="text" class="sign-input"
                placeholder="Type your full name" :disabled="!agreed"
                @focus="nameDropOpen = true"
                @blur="window.setTimeout(() => nameDropOpen = false, 200)"
              />
              <div v-if="nameDropOpen && agreed && filteredNames.length" class="name-dropdown">
                <div
                  v-for="name in filteredNames" :key="name" class="name-option"
                  @mousedown.prevent="signatureText = name; nameDropOpen = false"
                >{{ name }}</div>
              </div>
            </div>

            <div class="sign-field">
              <label class="sign-field-label">
                Draw your signature
                <button v-if="hasDrawn" class="canvas-clear" @click="clearCanvas">Clear</button>
              </label>
              <div class="canvas-wrapper" :class="{ disabled: !agreed }">
                <canvas ref="canvasRef" class="sig-canvas" @pointerdown="startDraw" @pointermove="draw" @pointerup="endDraw" @pointerleave="endDraw"></canvas>
              </div>
            </div>

            <button class="sign-btn" :disabled="!agreed || !signatureText.trim() || !hasDrawn" @click="handleSign">
              Sign Document
            </button>
          </div>

          <div v-else-if="doc?.signed" class="sign-done">
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
import { ref, computed, watch, nextTick } from 'vue'

const props = defineProps({
  show: { type: Boolean, default: false },
  doc: { type: Object, default: null },
  suggestedNames: { type: Array, default: () => [] },
  applicantName: { type: String, default: '' },
  applicantEntity: { type: String, default: '' },
})
const emit = defineEmits(['close', 'signed'])

const agreed = ref(false)
const signatureText = ref('')
const canvasRef = ref(null)
const isDrawing = ref(false)
const hasDrawn = ref(false)
const nameDropOpen = ref(false)

const effectiveDate = computed(() => new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))

const docDescription = computed(() => {
  const key = props.doc?.doc_key
  if (key === 'master_agreement') return 'This agreement establishes the terms of participation and management responsibilities between you and LogisX Logistics for fleet operations, revenue sharing, and service obligations.'
  if (key === 'vehicle_lease') return 'This lease agreement covers the commercial vehicles you are registering with LogisX, including maintenance responsibilities, insurance requirements, and usage terms.'
  if (key === 'w9') return 'IRS Form W-9 is required for tax reporting purposes. Your taxpayer identification number (EIN/SSN) will be used to issue 1099 forms as required by federal law.'
  return ''
})

const filteredNames = computed(() => {
  const q = signatureText.value.toLowerCase()
  const names = props.suggestedNames.filter(n => n)
  if (!q) return names
  return names.filter(n => n.toLowerCase().includes(q))
})

watch(() => props.show, async (v) => {
  if (v) {
    agreed.value = false
    signatureText.value = ''
    hasDrawn.value = false
    await nextTick()
    initCanvas()
  }
})

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
  if (!agreed.value) return
  isDrawing.value = true
  const ctx = canvasRef.value.getContext('2d')
  const pos = getPos(e)
  ctx.beginPath()
  ctx.moveTo(pos.x, pos.y)
  canvasRef.value.setPointerCapture(e.pointerId)
}

function draw(e) {
  if (!isDrawing.value) return
  const ctx = canvasRef.value.getContext('2d')
  const pos = getPos(e)
  ctx.lineTo(pos.x, pos.y)
  ctx.stroke()
  hasDrawn.value = true
}

function endDraw() { isDrawing.value = false }
function clearCanvas() { hasDrawn.value = false; initCanvas() }

function handleSign() {
  const signatureImage = canvasRef.value?.toDataURL('image/png') || null
  emit('signed', {
    docKey: props.doc.doc_key,
    text: signatureText.value.trim(),
    image: signatureImage,
  })
}
</script>

<style scoped>
/* ─── Fullscreen overlay ─── */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); z-index: 999;
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

/* ─── Left: Document info ─── */
.pdf-panel {
  flex: 1; background: #f8fafc; overflow-y: auto;
  display: flex; align-items: center; justify-content: center;
}
.doc-info {
  max-width: 520px; padding: 2.5rem; text-align: center;
}
.doc-info-icon { color: #3b82f6; margin-bottom: 1.25rem; }
.doc-info-title { font-size: 1.3rem; font-weight: 700; color: #0f172a; margin: 0 0 0.75rem; }
.doc-info-desc { font-size: 0.9rem; color: #475569; line-height: 1.6; margin: 0 0 1.5rem; }
.doc-info-details {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
  padding: 1rem; margin-bottom: 1.5rem; text-align: left;
}
.detail-row {
  display: flex; justify-content: space-between; padding: 0.4rem 0;
  border-bottom: 1px solid #f1f5f9;
}
.detail-row:last-child { border-bottom: none; }
.detail-label { font-size: 0.78rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.03em; }
.detail-value { font-size: 0.88rem; font-weight: 500; color: #0f172a; }
.doc-info-note {
  font-size: 0.8rem; color: #94a3b8; line-height: 1.5;
  background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px;
  padding: 0.75rem; text-align: left;
}

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

/* ─── Signed state ─── */
.sign-done {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 0.75rem;
  padding: 2rem; text-align: center;
}
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
