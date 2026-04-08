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
        <!-- Left: PDF viewer -->
        <div class="pdf-panel">
          <iframe v-if="pdfUrl" :src="pdfUrl" class="pdf-frame"></iframe>
          <div v-else class="pdf-placeholder">Loading document...</div>
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

            <div class="sign-field">
              <label class="sign-field-label">Full Name</label>
              <input
                v-model="signatureText" type="text" class="sign-input"
                placeholder="Type your full name" :disabled="!agreed"
              />
            </div>

            <!-- Payment section (Contractor Agreement only) -->
            <div v-if="isContractorAgreement" class="payment-section">
              <div class="payment-title">Payment Method (Exhibit A)</div>
              <div class="payment-radios">
                <label class="payment-radio"><input type="radio" v-model="paymentMethod" value="check" :disabled="!agreed" /> Check</label>
                <label class="payment-radio"><input type="radio" v-model="paymentMethod" value="ach" :disabled="!agreed" /> Direct Deposit (ACH)</label>
              </div>
              <div v-if="paymentMethod === 'check'" class="sign-field">
                <label class="sign-field-label">Name on Account</label>
                <input v-model="checkName" class="pay-input" placeholder="Name on Account" :disabled="!agreed" />
              </div>
              <template v-if="paymentMethod === 'ach'">
                <div class="sign-field"><label class="sign-field-label">Bank Name</label><input v-model="bankName" class="pay-input" placeholder="Name of Bank" :disabled="!agreed" /></div>
                <div class="sign-field"><label class="sign-field-label">Bank Address</label><input v-model="bankAddress" class="pay-input" placeholder="Bank Address" :disabled="!agreed" /></div>
                <div class="sign-field"><label class="sign-field-label">Bank Phone</label><input v-model="bankPhone" class="pay-input" placeholder="Bank Phone #" :disabled="!agreed" /></div>
                <div class="pay-row">
                  <div class="sign-field"><label class="sign-field-label">Routing #</label><input v-model="bankRouting" class="pay-input" placeholder="Routing #" :disabled="!agreed" /></div>
                  <div class="sign-field"><label class="sign-field-label">Account #</label><input v-model="bankAccount" class="pay-input" placeholder="Account #" :disabled="!agreed" /></div>
                </div>
                <div class="pay-row">
                  <div class="sign-field"><label class="sign-field-label">Name on Account</label><input v-model="bankAcctName" class="pay-input" placeholder="Name(s) on Account" :disabled="!agreed" /></div>
                  <div class="sign-field">
                    <label class="sign-field-label">Account Type</label>
                    <select v-model="accountType" class="pay-input" :disabled="!agreed">
                      <option value="">Select...</option>
                      <option value="Checking">Checking</option>
                      <option value="Savings">Savings</option>
                    </select>
                  </div>
                </div>
              </template>
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

            <button class="sign-btn" :disabled="!canSign" @click="handleSign">
              {{ signing ? 'Signing...' : 'Sign Document' }}
            </button>
          </div>

          <div v-else-if="doc?.signed" class="sign-done">
            <div class="sign-done-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            </div>
            <div class="sign-done-title">Document Signed</div>
            <div class="sign-done-text">Signed by {{ doc.signature_text }}</div>
            <div v-if="doc.signed_at" class="sign-done-date">{{ formatDate(doc.signed_at) }}</div>
            <a v-if="doc.signed_pdf_url" :href="doc.signed_pdf_url" target="_blank" class="view-link">Download Signed PDF</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useDriverStore } from '../../stores/driver'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  show: { type: Boolean, default: false },
  doc: { type: Object, default: null },
})
const emit = defineEmits(['close', 'signed'])

const driverStore = useDriverStore()
const { show: toast } = useToast()

const agreed = ref(false)
const signatureText = ref('')
const signing = ref(false)
const canvasRef = ref(null)
const isDrawing = ref(false)
const hasDrawn = ref(false)

// Payment info (contractor_agreement only)
const paymentMethod = ref('')
const checkName = ref('')
const bankName = ref('')
const bankAddress = ref('')
const bankPhone = ref('')
const bankRouting = ref('')
const bankAccount = ref('')
const bankAcctName = ref('')
const accountType = ref('')

const isContractorAgreement = computed(() => props.doc?.doc_key === 'contractor_agreement')

const pdfUrl = computed(() => {
  if (!props.doc) return ''
  return `/api/onboarding/documents/${props.doc.doc_key}/pdf`
})

const canSign = computed(() => {
  if (!agreed.value || !signatureText.value.trim() || !hasDrawn.value || signing.value) return false
  if (isContractorAgreement.value) {
    if (!paymentMethod.value) return false
    if (paymentMethod.value === 'check' && !checkName.value.trim()) return false
    if (paymentMethod.value === 'ach' && (!bankName.value.trim() || !bankRouting.value.trim() || !bankAccount.value.trim() || !accountType.value)) return false
  }
  return true
})

watch(() => props.show, async (v) => {
  if (v) {
    agreed.value = false
    signatureText.value = ''
    signing.value = false
    hasDrawn.value = false
    paymentMethod.value = ''
    checkName.value = ''
    bankName.value = ''
    bankAddress.value = ''
    bankPhone.value = ''
    bankRouting.value = ''
    bankAccount.value = ''
    bankAcctName.value = ''
    accountType.value = ''
    await nextTick()
    initCanvas()
  }
})

function initCanvas() {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.parentElement.getBoundingClientRect()
  canvas.width = rect.width
  canvas.height = rect.height || 140
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

async function handleSign() {
  if (!canSign.value) return
  signing.value = true
  try {
    const signatureImage = canvasRef.value?.toDataURL('image/png') || null
    const payInfo = isContractorAgreement.value ? {
      paymentMethod: paymentMethod.value,
      checkName: checkName.value,
      bankName: bankName.value,
      bankAddress: bankAddress.value,
      bankPhone: bankPhone.value,
      bankRouting: bankRouting.value,
      bankAccount: bankAccount.value,
      bankAcctName: bankAcctName.value,
      accountType: accountType.value,
    } : undefined
    await driverStore.signDocument(props.doc.doc_key, signatureText.value.trim(), signatureImage, payInfo)
    toast('Document signed successfully', 'success')
    emit('signed', props.doc.doc_key)
    emit('close')
  } catch (err) {
    toast(err.message || 'Failed to sign document', 'error')
  } finally {
    signing.value = false
  }
}

function formatDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
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
  padding: 0.75rem 1.25rem; border-bottom: 1px solid #e8edf2; flex-shrink: 0;
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
.modal-body { flex: 1; display: flex; overflow: hidden; }

/* ─── Left: PDF ─── */
.pdf-panel { flex: 1; background: #f5f5f5; overflow: hidden; }
.pdf-frame { width: 100%; height: 100%; border: none; }
.pdf-placeholder {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: #6b7085; font-size: 0.9rem;
}

/* ─── Right: Sign panel ─── */
.sign-panel {
  width: 360px; flex-shrink: 0;
  border-left: 1px solid #e8edf2;
  display: flex; flex-direction: column;
  background: #fafbfd;
}
.sign-content {
  flex: 1; display: flex; flex-direction: column;
  padding: 1.25rem; gap: 0.85rem; overflow-y: auto;
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
.sign-field-label {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 0.78rem; font-weight: 600; color: #475569;
}
.sign-input {
  width: 100%; padding: 0.55rem 0.75rem; border: 1px solid #e2e4ea; border-radius: 8px;
  font-size: 1.1rem; font-family: 'Dancing Script', cursive; font-style: italic; background: #fff;
}
.sign-input:disabled { opacity: 0.4; }

/* ─── Payment section ─── */
.payment-section {
  background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 10px; padding: 0.85rem;
}
.payment-title { font-size: 0.82rem; font-weight: 700; color: #0369a1; margin-bottom: 0.5rem; }
.payment-radios { display: flex; gap: 1rem; margin-bottom: 0.5rem; }
.payment-radio {
  display: flex; align-items: center; gap: 0.35rem;
  font-size: 0.82rem; color: #334155; cursor: pointer;
}
.pay-input {
  width: 100%; padding: 0.45rem 0.65rem; border: 1px solid #e2e4ea; border-radius: 8px;
  font-size: 0.82rem; background: #fff; font-family: inherit;
}
.pay-input:disabled { opacity: 0.4; }
.pay-row { display: flex; gap: 0.5rem; }
.pay-row .sign-field { flex: 1; }

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
.sign-done-date { font-size: 0.75rem; color: #94a3b8; }
.view-link {
  display: inline-flex; align-items: center; gap: 0.3rem;
  margin-top: 0.5rem; font-size: 0.82rem; color: #3b82f6;
  font-weight: 600; text-decoration: none;
}
.view-link:hover { text-decoration: underline; }

/* ─── Mobile ─── */
@media (max-width: 768px) {
  .modal-body { flex-direction: column; }
  .sign-panel { width: 100%; border-left: none; border-top: 1px solid #e8edf2; max-height: 50vh; }
  .pdf-panel { min-height: 40vh; }
}
</style>
