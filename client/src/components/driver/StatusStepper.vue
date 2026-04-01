<template>
  <div class="status-stepper-wrapper">
    <!-- Load selector when multiple active loads -->
    <slot name="selector"></slot>

    <div class="card">
      <div class="card-header">
        <span class="card-title">{{ loadId || 'Load' }}</span>
        <StatusBadge :status="currentStatus" />
      </div>

      <!-- Stepper -->
      <div class="stepper">
        <div
          v-for="(step, i) in statusFlow"
          :key="step.value"
          :class="['step', stepState(i)]"
        >
          <div class="step-dot">
            <template v-if="stepState(i) === 'done'">&#10003;</template>
            <template v-else>{{ i + 1 }}</template>
          </div>
          <div class="step-label">{{ step.label }}</div>
        </div>
      </div>

      <!-- Upload gate: require POD before allowing "Delivered" -->
      <div v-if="requiresUpload" class="upload-hint">
        Upload a Proof of Delivery in the <strong>Documents</strong> section before marking as Delivered.
      </div>

      <!-- Blocked: another job is active -->
      <div v-else-if="blocked" class="blocked-hint">
        Complete your current active job before starting a new one.
      </div>

      <!-- Normal action button -->
      <template v-else>
        <button
          v-if="allDone"
          class="action-btn completed-btn"
          disabled
        >&#10003; Load Delivered</button>
        <button
          v-else-if="nextStep"
          class="action-btn primary"
          :disabled="updating"
          @click="showConfirm = true"
        >{{ updating ? 'Updating...' : nextStep.label }}</button>
      </template>
    </div>

    <!-- Confirm modal -->
    <ConfirmModal
      :open="showConfirm"
      title="Update Status"
      :message="`Set status to &quot;${nextStep ? nextStep.label : ''}&quot;?`"
      confirm-text="Confirm"
      @confirm="onConfirm"
      @cancel="showConfirm = false"
    />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import StatusBadge from '../shared/StatusBadge.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'

const props = defineProps({
  load: { type: Object, required: true },
  headers: { type: Array, default: () => [] },
  currentStatus: { type: String, default: '' },
  driverName: { type: String, default: '' },
  blocked: { type: Boolean, default: false },
})

const emit = defineEmits(['update'])

const showConfirm = ref(false)
const updating = ref(false)

const statusFlow = [
  { value: 'At Shipper', label: 'Arrived at Shipper' },
  { value: 'Loading', label: 'Loading' },
  { value: 'In Transit', label: 'In Transit' },
  { value: 'At Receiver', label: 'Arrived at Receiver' },
  { value: 'Delivered', label: 'Delivered' },
]

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

const loadIdCol = computed(() => findCol(props.headers, /load.?id|job.?id/i))
const loadId = computed(() => loadIdCol.value ? props.load[loadIdCol.value] : '')

const currentIdx = computed(() => {
  const s = (props.currentStatus || '').trim()
  if (/^(assigned|dispatched)$/i.test(s)) return -1
  return statusFlow.findIndex(
    (st) => st.value.toLowerCase() === s.toLowerCase()
  )
})

const allDone = computed(() => currentIdx.value >= statusFlow.length - 1)

const nextStep = computed(() => {
  if (allDone.value) return null
  return statusFlow[currentIdx.value + 1] || null
})

// Gate: require document upload before allowing "Delivered"
const requiresUpload = computed(() => {
  if (!nextStep.value) return false
  return nextStep.value.value === 'Delivered' && (props.load._podCount || 0) === 0
})

function stepState(i) {
  if (allDone.value && i <= currentIdx.value) return 'done'
  if (i < currentIdx.value + 1) return 'done'
  if (i === currentIdx.value + 1 && !allDone.value) return 'current'
  return 'pending'
}

async function onConfirm() {
  showConfirm.value = false
  if (nextStep.value) {
    updating.value = true
    emit('update', { newStatus: nextStep.value.value, load: props.load })
    // Reset after a timeout (parent controls actual completion)
    setTimeout(() => { updating.value = false }, 5000)
  }
}
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.card-title {
  font-size: 0.95rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
}

/* Stepper */
.stepper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 1.25rem 0;
  position: relative;
}

.stepper::before {
  content: '';
  position: absolute;
  top: 16px;
  left: 24px;
  right: 24px;
  height: 3px;
  background: var(--border);
  z-index: 0;
}

.step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  z-index: 1;
  flex: 1;
}

.step-dot {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 3px solid var(--border);
  background: var(--surface);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  transition: all 0.2s;
}

.step.done .step-dot {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.step.current .step-dot {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-dim);
}

.step-label {
  font-size: 0.6rem;
  color: var(--text-dim);
  text-align: center;
  font-weight: 500;
  max-width: 60px;
  line-height: 1.2;
}

.step.done .step-label,
.step.current .step-label {
  color: var(--accent);
  font-weight: 600;
}

/* Blocked / Upload hints */
.blocked-hint {
  text-align: center;
  font-size: 0.82rem;
  color: var(--text-dim);
  padding: 0.75rem;
  background: var(--bg);
  border-radius: var(--radius);
  line-height: 1.4;
}

.upload-hint {
  text-align: center;
  font-size: 0.82rem;
  color: var(--text-dim);
  padding: 0.75rem;
  background: var(--bg);
  border-radius: var(--radius);
  margin-bottom: 0.75rem;
  line-height: 1.4;
}

/* Action buttons */
.action-btn {
  width: 100%;
  padding: 1rem;
  border: none;
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  min-height: 56px;
}

.action-btn.primary {
  background: var(--accent);
  color: #fff;
}

.action-btn.primary:hover {
  opacity: 0.9;
}

.action-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  animation: btnPulse 1s infinite;
}

@keyframes btnPulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 0.4; }
}

.action-btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.completed-btn {
  background: var(--accent-dim);
  color: var(--accent);
  cursor: default;
}
</style>
