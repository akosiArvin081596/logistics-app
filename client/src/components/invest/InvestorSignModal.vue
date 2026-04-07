<template>
  <div v-if="show" class="modal-overlay" @click.self="$emit('close')">
    <div class="modal-content">
      <div class="modal-header">
        <div class="modal-title">{{ doc?.doc_name || 'Document' }}</div>
        <button class="modal-close" @click="$emit('close')">&times;</button>
      </div>

      <div class="pdf-container">
        <iframe v-if="pdfUrl" :src="pdfUrl" class="pdf-frame"></iframe>
        <div v-else class="pdf-placeholder">Loading document...</div>
      </div>

      <div v-if="doc && !doc.signed" class="sign-area">
        <label class="sign-checkbox">
          <input type="checkbox" v-model="agreed" />
          <span>I have read and agree to the terms of this document</span>
        </label>
        <input v-model="signatureText" type="text" class="sign-input" placeholder="Type your full name" :disabled="!agreed" />
        <div class="canvas-wrapper" :class="{ disabled: !agreed }">
          <div class="canvas-label">
            <span>Draw your signature</span>
            <button v-if="hasDrawn" class="canvas-clear" @click="clearCanvas">Clear</button>
          </div>
          <canvas ref="canvasRef" class="sig-canvas" @pointerdown="startDraw" @pointermove="draw" @pointerup="endDraw" @pointerleave="endDraw"></canvas>
        </div>
        <button class="sign-btn" :disabled="!agreed || !signatureText.trim() || !hasDrawn || signing" @click="handleSign">
          {{ signing ? 'Signing...' : 'Sign Document' }}
        </button>
      </div>

      <div v-else-if="doc?.signed" class="sign-done">
        <span>&#9989;</span> Signed by {{ doc.signature_text }}
        <a v-if="doc.signed_pdf_url" :href="doc.signed_pdf_url" target="_blank" class="view-link">View Signed PDF</a>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  show: { type: Boolean, default: false },
  doc: { type: Object, default: null },
  pdfUrl: { type: String, default: '' },
  applicationId: { type: Number, default: 0 },
  vehicleInfo: { type: Object, default: null },
})
const emit = defineEmits(['close', 'signed'])

const api = useApi()
const { show: toast } = useToast()
const agreed = ref(false)
const signatureText = ref('')
const signing = ref(false)
const canvasRef = ref(null)
const isDrawing = ref(false)
const hasDrawn = ref(false)

watch(() => props.show, async (v) => {
  if (v) {
    agreed.value = false
    signatureText.value = ''
    signing.value = false
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
  canvas.height = 100
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = '#1a1d27'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
}

function getPos(e) {
  const canvas = canvasRef.value
  const rect = canvas.getBoundingClientRect()
  return { x: (e.clientX || 0) - rect.left, y: (e.clientY || 0) - rect.top }
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

async function handleSign() {
  if (signing.value) return
  signing.value = true
  try {
    const signatureImage = canvasRef.value?.toDataURL('image/png') || null
    await api.post(`/api/public/investor-onboarding/${props.applicationId}/sign/${props.doc.doc_key}`, {
      signatureText: signatureText.value.trim(),
      signatureImage,
      vehicleInfo: props.vehicleInfo || undefined,
    })
    toast('Document signed', 'success')
    emit('signed', props.doc.doc_key)
    emit('close')
  } catch (err) {
    toast(err.message || 'Signing failed', 'error')
  } finally {
    signing.value = false
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 999;
  display: flex; align-items: center; justify-content: center; padding: 1rem;
}
.modal-content {
  background: white; border-radius: 14px; width: 100%; max-width: 700px; max-height: 90vh;
  display: flex; flex-direction: column; overflow: hidden;
}
.modal-header {
  display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem;
  border-bottom: 1px solid #e8edf2;
}
.modal-title { font-weight: 700; font-size: 1rem; }
.modal-close { font-size: 1.5rem; background: none; border: none; cursor: pointer; color: #6b7085; }
.pdf-container { flex: 1; min-height: 300px; background: #f5f5f5; overflow: hidden; }
.pdf-frame { width: 100%; height: 100%; min-height: 300px; border: none; }
.pdf-placeholder { display: flex; align-items: center; justify-content: center; height: 300px; color: #6b7085; }
.sign-area { padding: 0.75rem 1.25rem; border-top: 1px solid #e8edf2; display: flex; flex-direction: column; gap: 0.5rem; }
.sign-checkbox { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.8rem; cursor: pointer; }
.sign-input {
  width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #e2e4ea; border-radius: 8px;
  font-size: 1.1rem; font-family: 'Dancing Script', cursive; font-style: italic; background: #f9fafb;
}
.sign-input:disabled { opacity: 0.5; }
.canvas-wrapper { position: relative; }
.canvas-wrapper.disabled { opacity: 0.4; pointer-events: none; }
.canvas-label { display: flex; justify-content: space-between; font-size: 0.75rem; color: #6b7085; margin-bottom: 0.25rem; }
.canvas-clear { font-size: 0.72rem; color: #38bdf8; background: none; border: none; cursor: pointer; font-weight: 600; }
.sig-canvas { width: 100%; height: 100px; border: 1px solid #e2e4ea; border-radius: 8px; cursor: crosshair; touch-action: none; }
.sign-btn {
  width: 100%; padding: 0.65rem; background: #38bdf8; color: white; border: none;
  border-radius: 8px; font-weight: 700; font-size: 0.9rem; cursor: pointer;
}
.sign-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sign-done { padding: 1rem; text-align: center; font-size: 0.88rem; color: #059669; font-weight: 600; border-top: 1px solid #e8edf2; }
.view-link { display: block; margin-top: 0.5rem; font-size: 0.82rem; color: #38bdf8; }
</style>
