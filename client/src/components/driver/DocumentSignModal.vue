<template>
  <van-popup v-model:show="visible" position="bottom" round :style="{ height: '90%' }" @close="$emit('close')">
    <div class="sign-modal">
      <div class="sign-header">
        <div class="sign-title">{{ doc?.doc_name || 'Document' }}</div>
        <button class="sign-close" @click="$emit('close')">&times;</button>
      </div>

      <!-- PDF viewer -->
      <div class="pdf-container">
        <iframe v-if="pdfUrl" :src="pdfUrl" class="pdf-frame"></iframe>
        <div v-else class="pdf-placeholder">Loading document...</div>
      </div>

      <!-- Signing area -->
      <div v-if="doc && !doc.signed" class="sign-area">
        <label class="sign-checkbox">
          <input type="checkbox" v-model="agreed" />
          <span>I have read and agree to the terms of this document</span>
        </label>
        <div class="sign-input-row">
          <input
            v-model="signatureText"
            type="text"
            class="sign-input"
            placeholder="Type your full name as signature"
            :disabled="!agreed"
          />
          <button
            class="sign-btn"
            :disabled="!agreed || !signatureText.trim() || signing"
            @click="handleSign"
          >
            {{ signing ? 'Signing...' : 'Sign Document' }}
          </button>
        </div>
      </div>

      <!-- Already signed -->
      <div v-else-if="doc?.signed" class="sign-done">
        <span class="sign-done-icon">&#9989;</span>
        Signed by {{ doc.signature_text }} on {{ formatDate(doc.signed_at) }}
      </div>
    </div>
  </van-popup>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
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

const pdfUrl = computed(() => {
  if (!props.doc) return ''
  return `/api/onboarding/documents/${props.doc.doc_key}/pdf`
})

watch(() => props.show, (v) => {
  if (v) {
    agreed.value = false
    signatureText.value = ''
    signing.value = false
  }
})

async function handleSign() {
  if (!agreed.value || !signatureText.value.trim() || signing.value) return
  signing.value = true
  try {
    await driverStore.signDocument(props.doc.doc_key, signatureText.value.trim())
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
  padding: 1rem;
  border-bottom: 1px solid var(--bg);
}
.sign-title {
  font-weight: 700;
  font-size: 1rem;
}
.sign-close {
  font-size: 1.5rem;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-dim);
  line-height: 1;
}
.pdf-container {
  flex: 1;
  overflow: hidden;
  background: #f5f5f5;
}
.pdf-frame {
  width: 100%;
  height: 100%;
  border: none;
}
.pdf-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-dim);
  font-size: 0.9rem;
}
.sign-area {
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--bg);
  background: var(--card);
}
.sign-checkbox {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 0.8rem;
  margin-bottom: 0.5rem;
  cursor: pointer;
}
.sign-checkbox input { margin-top: 0.15rem; }
.sign-input-row {
  display: flex;
  gap: 0.5rem;
}
.sign-input {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--bg);
  border-radius: 8px;
  font-size: 0.88rem;
  background: var(--bg);
}
.sign-input:disabled { opacity: 0.5; }
.sign-btn {
  padding: 0.5rem 1rem;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 8px;
  font-weight: 700;
  font-size: 0.85rem;
  cursor: pointer;
  white-space: nowrap;
}
.sign-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sign-done {
  padding: 1rem;
  text-align: center;
  font-size: 0.88rem;
  color: #059669;
  font-weight: 600;
  border-top: 1px solid var(--bg);
}
.sign-done-icon { font-size: 1.2rem; margin-right: 0.25rem; }
</style>
