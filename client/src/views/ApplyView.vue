<template>
  <div class="apply-page">
    <!-- ═══ LEFT SIDEBAR ═══ -->
    <aside class="apply-sidebar">
      <div class="sidebar-top">
        <div class="sidebar-logo">
          <img src="/logo.avif" alt="LogisX" class="sidebar-logo-img" />
        </div>
        <div class="sidebar-subtitle">Driver Application</div>
      </div>

      <nav class="sidebar-steps">
        <div
          v-for="(s, i) in sidebarSteps"
          :key="i"
          class="sidebar-step"
          :class="{
            active: !submitted && step === i,
            done: submitted || step > i,
            clickable: !submitted && i <= maxStep && i !== step,
          }"
          @click="goToStep(i)"
        >
          <div class="step-icon">
            <svg v-if="submitted || step > i" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            <span v-else>{{ i + 1 }}</span>
          </div>
          <div class="step-text">
            <div class="step-title">{{ s.title }}</div>
            <div class="step-desc">{{ s.desc }}</div>
          </div>
        </div>
      </nav>

      <div class="sidebar-footer">
        &copy; {{ new Date().getFullYear() }} LogisX Inc.
      </div>
    </aside>

    <!-- ═══ MOBILE TOP BAR ═══ -->
    <div v-if="!submitted" class="mobile-topbar">
      <div class="mobile-logo">
        <img src="/logo.avif" alt="LogisX" class="mobile-logo-img" />
        <span>LogisX</span>
      </div>
      <div class="mobile-steps">
        <div v-for="(s, i) in sidebarSteps" :key="i" class="mobile-dot" :class="{ active: step === i, done: step > i }" />
      </div>
      <div class="mobile-step-label">Step {{ step + 1 }} of {{ sidebarSteps.length }}</div>
    </div>

    <!-- ═══ RIGHT CONTENT PANEL ═══ -->
    <main class="apply-content">

      <!-- Success Screen -->
      <div v-if="submitted" class="success-wrap">
        <div class="success-content">
          <div class="success-check">
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          </div>
          <h2>Application Submitted</h2>
          <p>Thank you, <strong>{{ form.first_name }} {{ form.last_name }}</strong>. Your driver application has been submitted successfully.</p>
          <div class="next-steps">
            <h4>What happens next</h4>
            <div class="next-step"><span class="ns-num">1</span><span>Our team will review your application within 1-2 business days</span></div>
            <div class="next-step"><span class="ns-num">2</span><span>You'll receive login credentials via email if accepted</span></div>
            <div class="next-step"><span class="ns-num">3</span><span>Complete onboarding documents to start driving</span></div>
          </div>
        </div>
      </div>

      <template v-else>
        <div class="step-panel">
          <div class="content-header">
            <div class="step-label">Step {{ step + 1 }} of {{ sidebarSteps.length }}</div>
            <h2>{{ sidebarSteps[step].title }}</h2>
            <p>{{ sidebarSteps[step].desc }}</p>
          </div>

          <StepPersonalInfo v-if="step === 0" :form="form" @open-map="showMapPicker = true" />
          <StepExperience v-if="step === 1" :form="form" />
          <StepDrivingHistory v-if="step === 2" :form="form" />
          <StepCertifications v-if="step === 3" :form="form" />
          <StepReferences v-if="step === 4" :form="form" />

          <div v-if="error" class="error-bar">{{ error }}</div>

          <div class="step-actions">
            <button v-if="step > 0" class="btn-ghost" @click="step--; error = ''">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
              Back
            </button>
            <div style="flex:1"></div>
            <button v-if="step < 4" class="btn-primary" @click="nextStep">
              Continue
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
            <button v-else class="btn-primary" :disabled="submitting" @click="submitForm">
              <span v-if="submitting" class="spinner light"></span>
              {{ submitting ? 'Submitting...' : 'Submit Application' }}
            </button>
          </div>
        </div>
      </template>
    </main>

    <LocationPickerModal
      :open="showMapPicker" label="Current Address"
      @close="showMapPicker = false" @confirm="onMapConfirm"
    />
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import LocationPickerModal from '../components/data-manager/LocationPickerModal.vue'
import StepPersonalInfo from '../components/apply/StepPersonalInfo.vue'
import StepExperience from '../components/apply/StepExperience.vue'
import StepDrivingHistory from '../components/apply/StepDrivingHistory.vue'
import StepCertifications from '../components/apply/StepCertifications.vue'
import StepReferences from '../components/apply/StepReferences.vue'

const sidebarSteps = [
  { title: 'Personal Info', desc: 'Basic details & documents' },
  { title: 'Experience', desc: 'Work history & qualifications' },
  { title: 'Driving History', desc: 'Accidents & citations' },
  { title: 'Certifications', desc: 'Skills & availability' },
  { title: 'References', desc: 'Contacts & signature' },
]

const step = ref(0)
const maxStep = ref(0)
const submitting = ref(false)
const submitted = ref(false)
const error = ref('')
const showMapPicker = ref(false)

function onMapConfirm({ displayName }) {
  if (displayName) form.address = displayName
  showMapPicker.value = false
}

const defaultForm = () => ({
  first_name: '', last_name: '', email: '', phone: '', dob: '', address: '', ssn: '', drivers_license: '', position: '',
  cdl_front: '', cdl_back: '', medical_card: '',
  experience: '', has_cdl: '', work_authorized: '', felony_convicted: '', felony_explanation: '',
  accident_history: '', accident_description: '', traffic_citations: '',
  certifications: '', availability: [], skills: '',
  references: [
    { name: '', phone: '', relationship: '' },
    { name: '', phone: '', relationship: '' },
    { name: '', phone: '', relationship: '' },
  ],
  additional_info: '', signature: '', signature_date: '',
})

const form = reactive(defaultForm())

function goToStep(i) {
  if (submitted.value) return
  if (i <= maxStep.value) {
    error.value = ''
    step.value = i
  }
}

function validate(s) {
  if (s === 0) {
    if (!form.first_name || !form.last_name || !form.email || !form.phone || !form.dob || !form.address || !form.ssn || !form.drivers_license || !form.position) return 'Please fill in all required fields in this section.'
    if (!form.cdl_front || !form.cdl_back || !form.medical_card) return 'Please upload CDL (front and back) and medical card images.'
  }
  if (s === 1) {
    if (!form.experience || !form.has_cdl || !form.work_authorized || !form.felony_convicted) return 'Please answer all required questions.'
  }
  if (s === 2) {
    if (!form.accident_history) return 'Please answer the accident history question.'
  }
  if (s === 3) {
    if (form.availability.length === 0 || !form.skills) return 'Please select availability and list your skills.'
  }
  if (s === 4) {
    const missingRef = form.references.some(r => !r.name || !r.phone)
    if (missingRef) return 'Please provide name and phone for all 3 references.'
    if (!form.signature) return 'Please type your full name as a signature.'
  }
  return ''
}

function nextStep() {
  const err = validate(step.value)
  if (err) { error.value = err; return }
  error.value = ''
  step.value++
  maxStep.value = Math.max(maxStep.value, step.value)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

async function submitForm() {
  const err = validate(step.value)
  if (err) { error.value = err; return }
  error.value = ''
  submitting.value = true
  try {
    const payload = { ...form, full_name: `${form.first_name} ${form.last_name}`.trim(), reference_info: JSON.stringify(form.references) }
    const res = await fetch('/api/public/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Submission failed')
    submitted.value = true
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (err) {
    error.value = err.message
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
/* ═══════════════════════════════════════════
   TWO-PANEL LAYOUT (matches /invest)
   ═══════════════════════════════════════════ */
.apply-page {
  display: flex;
  min-height: 100vh;
  font-family: 'DM Sans', system-ui, sans-serif;
  background: #fff;
}

/* ─── SIDEBAR ─── */
.apply-sidebar {
  width: 290px; flex-shrink: 0; background: #0f2847;
  display: flex; flex-direction: column; padding: 2rem 1.5rem;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}
.sidebar-top { margin-bottom: 2.5rem; }
.sidebar-logo { display: flex; align-items: center; gap: 0.65rem; }
.sidebar-logo-img { height: 32px; display: block; filter: brightness(0) invert(1); }
.sidebar-subtitle {
  margin-top: 0.6rem; font-size: 0.78rem; color: rgba(255,255,255,0.4);
  font-weight: 500; letter-spacing: 0.03em;
}

/* ─── Sidebar steps ─── */
.sidebar-steps { flex: 1; display: flex; flex-direction: column; gap: 0.35rem; }
.sidebar-step {
  display: flex; align-items: center; gap: 0.85rem;
  padding: 0.85rem 1rem; border-radius: 10px;
  transition: all 0.2s ease; border-left: 3px solid transparent;
}
.sidebar-step.clickable { cursor: pointer; }
.sidebar-step.clickable:hover { background: rgba(255,255,255,0.05); }
.sidebar-step.active { background: rgba(255,255,255,0.08); border-left-color: #3b82f6; }
.sidebar-step.done .step-icon { background: #22c55e; border-color: #22c55e; color: #fff; }
.step-icon {
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  font-size: 0.78rem; font-weight: 700;
  border: 1.5px solid rgba(255,255,255,0.2); color: rgba(255,255,255,0.4);
  transition: all 0.2s ease;
}
.sidebar-step.active .step-icon { background: #3b82f6; border-color: #3b82f6; color: #fff; }
.step-text { min-width: 0; }
.step-title { font-size: 0.85rem; font-weight: 600; color: rgba(255,255,255,0.45); transition: color 0.2s; }
.sidebar-step.active .step-title, .sidebar-step.done .step-title { color: #fff; }
.step-desc { font-size: 0.72rem; color: rgba(255,255,255,0.25); margin-top: 0.1rem; transition: color 0.2s; }
.sidebar-step.active .step-desc { color: rgba(255,255,255,0.5); }
.sidebar-step.done .step-desc { color: rgba(255,255,255,0.4); }
.sidebar-footer {
  font-size: 0.72rem; color: rgba(255,255,255,0.25);
  padding-top: 1.5rem; border-top: 1px solid rgba(255,255,255,0.08);
}

/* ─── MOBILE TOPBAR ─── */
.mobile-topbar { display: none; }

/* ─── CONTENT PANEL ─── */
.apply-content { flex: 1; overflow-y: auto; display: flex; flex-direction: column; min-height: 100vh; }
.step-panel { flex: 1; padding: 2rem 3rem 2rem; width: 100%; }

/* ─── Content header ─── */
.content-header { margin-bottom: 1.5rem; }
.step-label {
  display: inline-block; font-size: 0.7rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 0.35rem;
}
.content-header h2 {
  font-size: 1.45rem; font-weight: 800; color: #0f172a;
  letter-spacing: -0.02em; margin-bottom: 0.2rem;
}
.content-header p { font-size: 0.85rem; color: #94a3b8; }

/* ─── Buttons ─── */
.btn-primary {
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.72rem 1.6rem; border: none; border-radius: 10px;
  background: #0f2847; color: #fff; font-weight: 700; font-size: 0.88rem;
  cursor: pointer; transition: all 0.15s; font-family: inherit;
}
.btn-primary:hover:not(:disabled) { background: #1a3a6b; }
.btn-primary:active:not(:disabled) { transform: scale(0.98); }
.btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-ghost {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.72rem 1.4rem; border: 1.5px solid #e2e8f0; border-radius: 10px;
  background: #fff; color: #475569; font-weight: 600; font-size: 0.88rem;
  cursor: pointer; transition: all 0.15s; font-family: inherit;
}
.btn-ghost:hover { background: #f8fafc; border-color: #cbd5e1; }
.step-actions {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 1.75rem; gap: 1rem; padding-top: 1.25rem; border-top: 1px solid #f1f5f9;
}

/* ─── Spinner ─── */
.spinner {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid #94a3b8; border-top-color: transparent;
  border-radius: 50%; animation: spin 0.7s linear infinite;
}
.spinner.light { border-color: rgba(255,255,255,0.35); border-top-color: #fff; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ─── Error bar ─── */
.error-bar {
  background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;
  padding: 0.6rem 1rem; font-size: 0.82rem; color: #dc2626; margin-top: 1rem;
}

/* ─── Success ─── */
.success-wrap { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem; }
.success-content { text-align: center; max-width: 480px; }
.success-check {
  width: 72px; height: 72px; border-radius: 50%; margin: 0 auto 1.75rem;
  background: #dcfce7; color: #16a34a;
  display: flex; align-items: center; justify-content: center;
  animation: popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes popIn { 0% { transform: scale(0); } 100% { transform: scale(1); } }
.success-content h2 { font-size: 1.5rem; font-weight: 800; color: #0f172a; margin-bottom: 0.5rem; }
.success-content > p { color: #64748b; font-size: 0.9rem; max-width: 420px; margin: 0 auto; line-height: 1.6; }
.next-steps {
  margin-top: 2.25rem; text-align: left;
  background: #fafbfd; border-radius: 14px; padding: 1.5rem 1.75rem; border: 1px solid #f1f5f9;
}
.next-steps h4 {
  font-size: 0.78rem; font-weight: 700; color: #475569; margin-bottom: 1rem;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.next-step {
  display: flex; align-items: flex-start; gap: 0.85rem;
  margin-bottom: 0.85rem; font-size: 0.85rem; color: #475569; line-height: 1.5;
}
.next-step:last-child { margin-bottom: 0; }
.ns-num {
  flex-shrink: 0; width: 24px; height: 24px; border-radius: 50%;
  background: #0f2847; color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.72rem; font-weight: 800;
}

/* ─── Step component deep styles ─── */
:deep(.section-header) { margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid #e8edf2; }
:deep(.section-header h3) { font-size: 1.1rem; font-weight: 700; color: #111827; margin-bottom: 0.25rem; }
:deep(.section-header p) { font-size: 0.82rem; color: #9ca3af; }
:deep(.field) { margin-bottom: 1.1rem; }
:deep(.field-label) { display: block; font-size: 0.82rem; font-weight: 600; color: #374151; margin-bottom: 0.4rem; }
:deep(.field-label .req) { color: #dc2626; }
:deep(.input-wrap) {
  display: flex; align-items: center; border: 1.5px solid #e2e4ea; border-radius: 10px;
  background: #f9fafb; overflow: hidden; transition: border-color 0.15s, box-shadow 0.15s;
}
:deep(.input-wrap:focus-within) { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); background: #fff; }
:deep(.input-wrap input), :deep(.input-wrap textarea) {
  flex: 1; border: none; outline: none; background: transparent;
  padding: 0.7rem 0.85rem; font-size: 0.88rem; font-family: inherit; color: #111827; resize: vertical;
}
:deep(.input-wrap input::placeholder), :deep(.input-wrap textarea::placeholder) { color: #c4c8d0; }
:deep(.radio-group), :deep(.checkbox-group) { display: flex; flex-direction: column; gap: 0.5rem; }
:deep(.radio-item), :deep(.checkbox-item) {
  display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.85rem;
  border: 1.5px solid #e2e4ea; border-radius: 10px; background: #f9fafb;
  cursor: pointer; transition: all 0.15s; font-size: 0.88rem; color: #374151;
}
:deep(.radio-item:hover), :deep(.checkbox-item:hover) { border-color: #3b82f6; background: #f0f9ff; }
:deep(.radio-item input), :deep(.checkbox-item input) { accent-color: #3b82f6; width: 16px; height: 16px; }
:deep(.grid) { display: grid; }
:deep(.grid-cols-2) { grid-template-columns: 1fr 1fr; }
:deep(.gap-4) { gap: 1rem; }

/* ═══════════════════════════════════════════
   RESPONSIVE
   ═══════════════════════════════════════════ */
@media (max-width: 768px) {
  .apply-sidebar { display: none; }
  .mobile-topbar {
    display: flex; flex-direction: column; align-items: center;
    gap: 0.75rem; padding: 1.25rem 1.5rem; background: #0f2847;
  }
  .mobile-logo { display: flex; align-items: center; gap: 0.5rem; font-size: 1.1rem; font-weight: 800; color: #fff; }
  .mobile-logo-img { height: 26px; filter: brightness(0) invert(1); }
  .mobile-steps { display: flex; gap: 0.5rem; align-items: center; }
  .mobile-dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: rgba(255,255,255,0.2); transition: all 0.2s;
  }
  .mobile-dot.active { background: #3b82f6; width: 28px; border-radius: 99px; }
  .mobile-dot.done { background: #22c55e; }
  .mobile-step-label {
    font-size: 0.7rem; color: rgba(255,255,255,0.45);
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
  }
  .apply-page { flex-direction: column; }
  .apply-content { min-height: auto; }
  .step-panel { padding: 1.5rem 1.25rem 2rem; }
  .content-header h2 { font-size: 1.25rem; }
  :deep(.grid-cols-2) { grid-template-columns: 1fr; }
}
</style>
