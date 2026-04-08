<template>
  <van-popup v-model:show="visible" position="bottom" round :style="{ height: '92%' }" @close="$emit('close')">
    <div class="sign-modal">
      <div class="sign-header">
        <div class="sign-title">{{ doc?.doc_name || 'Document' }}</div>
        <button class="sign-close" @click="$emit('close')">&times;</button>
      </div>

      <!-- PDF viewer -->
      <div class="pdf-container" :style="{ flex: pdfFlex }">
        <iframe v-if="pdfUrl" :src="pdfUrl" class="pdf-frame"></iframe>
        <div v-else class="pdf-placeholder">Loading document...</div>
      </div>

      <!-- Drag handle to resize -->
      <div v-if="doc && !doc.signed" class="resize-handle" @pointerdown="startResize">
        <div class="resize-bar"></div>
      </div>

      <!-- Signing area -->
      <details v-if="doc && !doc.signed" class="sign-area-collapse">
        <summary class="sign-toggle">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          Sign this document
        </summary>
        <div class="sign-area" :style="{ maxHeight: signAreaHeight + 'px', overflowY: 'auto' }">
          <label class="sign-checkbox">
            <input type="checkbox" v-model="agreed" />
            <span>I have read and agree to the terms of this document</span>
          </label>

          <input
            v-model="signatureText"
            type="text"
            class="sign-input"
            placeholder="Type your full name"
            :disabled="!agreed"
          />

          <div v-if="isContractorAgreement" class="payment-section">
            <div class="payment-title">Payment Method (Exhibit A)</div>
            <div class="payment-radios">
              <label><input type="radio" v-model="paymentMethod" value="check" :disabled="!agreed" /> Check</label>
              <label><input type="radio" v-model="paymentMethod" value="ach" :disabled="!agreed" /> Direct Deposit (ACH)</label>
            </div>
            <input v-if="paymentMethod === 'check'" v-model="checkName" class="pay-input" placeholder="Name on Account" :disabled="!agreed" />
            <template v-if="paymentMethod === 'ach'">
              <input v-model="bankName" class="pay-input" placeholder="Name of Bank" :disabled="!agreed" />
              <input v-model="bankAddress" class="pay-input" placeholder="Bank Address" :disabled="!agreed" />
              <input v-model="bankPhone" class="pay-input" placeholder="Bank Phone #" :disabled="!agreed" />
              <input v-model="bankRouting" class="pay-input" placeholder="Routing #" :disabled="!agreed" />
              <input v-model="bankAccount" class="pay-input" placeholder="Account #" :disabled="!agreed" />
              <input v-model="bankAcctName" class="pay-input" placeholder="Name(s) on Account" :disabled="!agreed" />
              <select v-model="accountType" class="pay-input" :disabled="!agreed">
                <option value="">Account Type...</option>
                <option value="Checking">Checking</option>
                <option value="Savings">Savings</option>
              </select>
            </template>
          </div>

          <div class="canvas-wrapper" :class="{ disabled: !agreed }">
            <div class="canvas-label">
              <span>Draw your signature below</span>
              <button v-if="hasDrawn" class="canvas-clear" @click="clearCanvas">Clear</button>
            </div>
            <canvas
              ref="canvasRef"
              class="sig-canvas"
              @pointerdown="startDraw"
              @pointermove="draw"
              @pointerup="endDraw"
              @pointerleave="endDraw"
            ></canvas>
          </div>

          <button
            class="sign-btn"
            :disabled="!canSign"
            @click="handleSign"
          >
            {{ signing ? 'Signing...' : 'Sign Document' }}
          </button>
        </div>
      </details>

      <!-- Already signed -->
      <div v-else-if="doc?.signed" class="sign-done">
        <span class="sign-done-icon">&#9989;</span>
        <div>Signed by {{ doc.signature_text }}</div>
        <div class="sign-done-date">{{ formatDate(doc.signed_at) }}</div>
        <a v-if="doc.signed_pdf_url" :href="doc.signed_pdf_url" target="_blank" class="view-signed-link">View Signed PDF</a>
      </div>
    </div>
  </van-popup>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { Popup as VanPopup } from 'vant'
import { useDriverStore } from '../../stores/driver'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  show: { type: Boolean, default: false },
  doc: { type: Object, default: null },
})
const emit = defineEmits(['close', 'signed'])

const driverStore = useDriverStore()
const { show: toast } = useToast()

const visible = computed({
  get: () => props.show,
  set: (v) => { if (!v) emit('close') },
})

const agreed = ref(false)
const signatureText = ref('')
const signing = ref(false)
const canvasRef = ref(null)
const isDrawing = ref(false)
const hasDrawn = ref(false)
const signAreaHeight = ref(280)
const pdfFlex = ref('1')
const isResizing = ref(false)

function startResize(e) {
  isResizing.value = true
  const startY = e.clientY
  const startH = signAreaHeight.value
  const onMove = (ev) => {
    const diff = startY - ev.clientY
    signAreaHeight.value = Math.max(150, Math.min(600, startH + diff))
  }
  const onUp = () => {
    isResizing.value = false
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
}

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
  return {
    x: (e.clientX || e.touches?.[0]?.clientX || 0) - rect.left,
    y: (e.clientY || e.touches?.[0]?.clientY || 0) - rect.top,
  }
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

function endDraw() {
  isDrawing.value = false
}

function clearCanvas() {
  hasDrawn.value = false
  initCanvas()
}

function getSignatureImage() {
  const canvas = canvasRef.value
  if (!canvas) return null
  return canvas.toDataURL('image/png')
}

async function handleSign() {
  if (!canSign.value) return
  signing.value = true
  try {
    const signatureImage = getSignatureImage()
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
.sign-modal {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.sign-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--bg);
}
.sign-title { font-weight: 700; font-size: 1rem; }
.sign-close {
  font-size: 1.5rem; background: none; border: none;
  cursor: pointer; color: var(--text-dim); line-height: 1;
}
.pdf-container { flex: 1; overflow: hidden; background: #f5f5f5; }
.pdf-frame { width: 100%; height: 100%; border: none; }
.pdf-placeholder {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: var(--text-dim); font-size: 0.9rem;
}
.sign-area-collapse { border-top: 1px solid var(--bg); }
.sign-toggle {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.65rem 1rem; cursor: pointer; user-select: none;
  font-size: 0.85rem; font-weight: 700; color: var(--text);
  list-style: none; background: var(--card);
}
.sign-toggle::-webkit-details-marker { display: none; }
.sign-toggle svg { color: #3b82f6; }
.sign-area-collapse[open] .sign-toggle { border-bottom: 1px solid var(--bg); }
.sign-area {
  padding: 0.75rem 1rem;
  background: var(--card);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.sign-checkbox {
  display: flex; align-items: flex-start; gap: 0.5rem;
  font-size: 0.8rem; cursor: pointer;
}
.sign-checkbox input { margin-top: 0.15rem; }
.sign-input {
  width: 100%; padding: 0.5rem 0.75rem;
  border: 1px solid var(--bg); border-radius: 8px;
  font-size: 1.1rem; background: var(--bg);
  font-family: 'Dancing Script', 'Brush Script MT', 'Segoe Script', cursive;
  font-style: italic;
}
.sign-input:disabled { opacity: 0.5; }
.canvas-wrapper { position: relative; }
.canvas-wrapper.disabled { opacity: 0.4; pointer-events: none; }
.canvas-label {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 0.75rem; color: var(--text-dim); margin-bottom: 0.25rem;
}
.canvas-clear {
  font-size: 0.72rem; color: var(--accent); background: none;
  border: none; cursor: pointer; font-weight: 600;
}
.sig-canvas {
  width: 100%; height: 100px; border: 1px solid var(--bg);
  border-radius: 8px; cursor: crosshair; touch-action: none;
}
.sign-btn {
  width: 100%; padding: 0.65rem;
  background: var(--accent); color: white; border: none;
  border-radius: 8px; font-weight: 700; font-size: 0.9rem; cursor: pointer;
}
.sign-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.resize-handle {
  height: 16px; display: flex; align-items: center; justify-content: center;
  cursor: ns-resize; background: var(--card); border-top: 1px solid var(--bg);
  touch-action: none; flex-shrink: 0;
}
.resize-bar {
  width: 40px; height: 4px; border-radius: 2px; background: #d1d5db;
}
.payment-section {
  border: 1px solid var(--bg); border-radius: 8px; padding: 0.6rem;
  background: #fafbfc;
}
.payment-title {
  font-weight: 700; font-size: 0.82rem; margin-bottom: 0.4rem;
}
.payment-radios {
  display: flex; gap: 1rem; font-size: 0.82rem; margin-bottom: 0.4rem;
}
.payment-radios label { display: flex; align-items: center; gap: 0.3rem; cursor: pointer; }
.pay-input {
  width: 100%; padding: 0.4rem 0.6rem; margin-top: 0.3rem;
  border: 1px solid var(--bg); border-radius: 6px; font-size: 0.82rem; background: white;
}
.pay-input:disabled { opacity: 0.5; }
.sign-done {
  padding: 1rem; text-align: center;
  font-size: 0.88rem; color: #059669; font-weight: 600;
  border-top: 1px solid var(--bg);
}
.sign-done-icon { font-size: 1.5rem; display: block; margin-bottom: 0.25rem; }
.sign-done-date { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.15rem; }
.view-signed-link {
  display: inline-block; margin-top: 0.5rem; font-size: 0.82rem;
  color: var(--accent); font-weight: 600;
}
</style>
