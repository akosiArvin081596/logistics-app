<template>
  <div class="onboarding-panel">
    <!-- Progress -->
    <div class="card onboarding-progress">
      <div class="progress-header">
        <span class="progress-title">Onboarding Progress</span>
        <span class="progress-count">{{ signedCount }}/{{ totalDocs }} Documents</span>
      </div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" :style="{ width: progressPct + '%' }"></div>
      </div>
      <div class="status-badges">
        <span :class="['status-badge', stepClass('documents')]">Documents</span>
        <span :class="['status-badge', stepClass('complete')]">Complete</span>
      </div>
    </div>

    <!-- Document list -->
    <div class="section-header">Documents to Sign</div>
    <div v-for="doc in documents" :key="doc.doc_key" class="card doc-card" @click="openDoc(doc)">
      <div class="doc-row">
        <div class="doc-icon" v-html="doc.signed ? '&#9989;' : '&#128196;'"></div>
        <div class="doc-info">
          <div class="doc-name">{{ doc.doc_name }}</div>
          <div class="doc-status" :class="doc.signed ? 'signed' : 'unsigned'">
            {{ doc.signed ? `Signed on ${formatDate(doc.signed_at)}` : 'Pending signature' }}
          </div>
        </div>
        <div class="doc-action" v-html="doc.signed ? '&#128065;' : '&#9998;'"></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  onboarding: { type: Object, required: true },
  documents: { type: Array, default: () => [] },
  totalDocs: { type: Number, default: 6 },
})

const emit = defineEmits(['open-doc'])

const signedCount = computed(() => props.documents.filter(d => d.signed).length)
// Progress bar reflects document signing only. The drug test step is
// intentionally hidden from drivers (legal requirement) and the final
// completion status is driven by the admin-side flow.
const progressPct = computed(() => (signedCount.value / props.totalDocs) * 100)

function stepClass(step) {
  if (step === 'documents') {
    if (signedCount.value === props.totalDocs) return 'step-done'
    if (signedCount.value > 0) return 'step-active'
    return 'step-pending'
  }
  if (step === 'complete') {
    return props.onboarding.status === 'fully_onboarded' ? 'step-done' : 'step-pending'
  }
  return 'step-pending'
}

function formatDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function openDoc(doc) {
  emit('open-doc', doc)
}
</script>

<style scoped>
.onboarding-panel {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.onboarding-progress {
  padding: 1rem;
}
.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}
.progress-title {
  font-weight: 700;
  font-size: 0.95rem;
}
.progress-count {
  font-size: 0.78rem;
  color: var(--text-dim);
}
.progress-bar-track {
  height: 8px;
  border-radius: 4px;
  background: var(--bg);
  overflow: hidden;
  margin-bottom: 0.75rem;
}
.progress-bar-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
  transition: width 0.4s ease;
}
.status-badges {
  display: flex;
  gap: 0.5rem;
}
.status-badge {
  font-size: 0.72rem;
  padding: 0.2rem 0.6rem;
  border-radius: 99px;
  font-weight: 600;
}
.step-done { background: #d1fae5; color: #065f46; }
.step-active { background: #dbeafe; color: #1e40af; }
.step-pending { background: #f3f4f6; color: #6b7280; }

.doc-card {
  padding: 0.75rem 1rem;
  cursor: pointer;
  transition: background 0.15s;
}
.doc-card:active { background: var(--bg); }
.doc-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.doc-icon { font-size: 1.3rem; flex-shrink: 0; }
.doc-info { flex: 1; min-width: 0; }
.doc-name {
  font-size: 0.88rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.doc-status {
  font-size: 0.72rem;
  margin-top: 0.1rem;
}
.doc-status.signed { color: #059669; }
.doc-status.unsigned { color: #9ca3af; }
.doc-action {
  font-size: 1.1rem;
  color: var(--text-dim);
  flex-shrink: 0;
}
</style>
