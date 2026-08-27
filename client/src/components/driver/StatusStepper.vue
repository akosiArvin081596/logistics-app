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
          <div class="step-label">{{ step.short || step.label }}</div>
        </div>
      </div>

      <!-- Driver-only action UI. Suppressed entirely in readOnly mode
           (public tracker page) so customers see the stepper without any
           controls that would 403 on them. -->
      <template v-if="!readOnly">
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
      </template>
    </div>

    <!-- Confirm modals — driver-only; never render in readOnly mode. -->
    <template v-if="!readOnly">
      <ConfirmModal
        :open="showConfirm"
        title="Update Status"
        :message="`Set status to &quot;${nextStep ? nextStep.label : ''}&quot;?`"
        confirm-text="Confirm"
        @confirm="onConfirm"
        @cancel="showConfirm = false"
      />
      <ConfirmModal
        :open="showPodReminder"
        title="Upload Proof of Delivery"
        message="You've arrived at the receiver. Please upload a Proof of Delivery (POD) in the Documents section before marking this load as Delivered."
        confirm-text="Got it"
        @confirm="showPodReminder = false"
        @cancel="showPodReminder = false"
      />
    </template>
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
  // When true, hide every driver-side action button / modal. Used by the
  // public /track/:loadId page where customers only read the progression.
  readOnly: { type: Boolean, default: false },
})

const emit = defineEmits(['update'])

const showConfirm = ref(false)
const showPodReminder = ref(false)
const updating = ref(false)

// `label` is the full sentence used on the action button ("Heading to Shipper").
// `short` is the caption under the stepper dot, and it exists because six full
// labels do not fit six ~58px columns on a phone — the row overflowed its card
// and the last step rendered outside it. The short forms are the actual status
// values, so the caption now matches the badge shown beside the load id.
const statusFlow = [
  { value: 'Heading to Shipper', label: 'Heading to Shipper', short: 'Heading' },
  { value: 'At Shipper', label: 'Arrived at Shipper', short: 'At Shipper' },
  { value: 'Loading', label: 'Loading', short: 'Loading' },
  { value: 'In Transit', label: 'In Transit', short: 'In Transit' },
  { value: 'At Receiver', label: 'Arrived at Receiver', short: 'At Receiver' },
  { value: 'Delivered', label: 'Delivered', short: 'Delivered' },
]

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

const loadIdCol = computed(() => findCol(props.headers, /load.?id|job.?id/i))
const loadId = computed(() => loadIdCol.value ? props.load[loadIdCol.value] : '')

const currentIdx = computed(() => {
  const s = (props.currentStatus || '').trim()
  // Assigned/Dispatched come before the first step (Heading to Shipper).
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
    const status = nextStep.value.value
    updating.value = true
    emit('update', { newStatus: status, load: props.load })
    // Show POD reminder after arriving at receiver
    if (status === 'At Receiver') {
      setTimeout(() => { showPodReminder.value = true }, 1500)
    }
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
  /* flex-start, not center: the labels wrap to different line counts ("LOADING"
     on one line, "ARRIVED AT RECEIVER" on three), and centering each column
     vertically pushed the dots to visibly different heights. Aligning to the
     top keeps all six dots on one line, which is what the connecting rule
     behind them assumes. */
  align-items: flex-start;
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
  /* ⚠️ LOAD-BEARING. A flex item defaults to min-width:auto, which refuses to
     shrink below its content. With six steps in a ~350px card each column gets
     ~58px, so the labels could not fit and the row overflowed its container
     (measured 369px of content in 350px, with overflow-x visible) — the last
     step rendered outside the card and read as "DELIVEI". */
  min-width: 0;
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
  /* Was a fixed 60px, which is wider than a column at phone width and so
     guaranteed the overflow above. Track the column instead, and break a long
     word rather than letting it push the layout. */
  max-width: 100%;
  line-height: 1.2;
  /* ⚠️ Overriding an INHERITED uppercase (it is not set here — it comes from a
     global rule). Uppercase plus its letter-spacing is what pushed six captions
     past the card's width. Sentence case is narrower and, at 9.6px on a phone
     in a moving truck, easier to read. */
  text-transform: none;
  letter-spacing: 0;
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
