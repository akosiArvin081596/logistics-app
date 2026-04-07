<template>
  <div class="apply-page">
    <div class="apply-container">
      <!-- Header -->
      <div class="apply-header">
        <img src="/logo.avif" alt="LogisX" class="apply-logo" />
        <h1>Employment Application</h1>
        <p>Fill out the form below to apply for a position at LogisX</p>
      </div>

      <!-- Success -->
      <Card v-if="submitted" class="apply-card success-card">
        <CardContent class="p-8 text-center">
          <div class="success-icon">&#10003;</div>
          <h2 class="text-xl font-bold text-gray-900 mt-4">Application Submitted!</h2>
          <p class="text-gray-500 mt-2">Thank you for applying to LogisX. We'll review your application and contact you soon.</p>
        </CardContent>
      </Card>

      <!-- Form -->
      <template v-else>
        <Card class="apply-card">
          <CardContent style="padding:2rem;">
            <StepIndicator :steps="stepLabels" :current="step" />

            <StepPersonalInfo v-if="step === 0" :form="form" />
            <StepExperience v-if="step === 1" :form="form" />
            <StepDrivingHistory v-if="step === 2" :form="form" />
            <StepCertifications v-if="step === 3" :form="form" />
            <StepReferences v-if="step === 4" :form="form" />

            <div v-if="error" class="error-bar">{{ error }}</div>

            <div class="step-actions">
              <button v-if="step > 0" class="back-btn" @click="step--">Back</button>
              <div class="spacer"></div>
              <button v-if="step < 4" class="next-btn" @click="nextStep">Next</button>
              <button v-else class="submit-btn" :disabled="submitting" @click="submitForm">
                {{ submitting ? 'Submitting...' : 'Submit Application' }}
              </button>
            </div>
          </CardContent>
        </Card>
      </template>

      <div class="apply-footer">&copy; 2026 LogisX. All rights reserved.</div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { Card, CardContent } from '@/components/ui/card'
import StepIndicator from '../components/apply/StepIndicator.vue'
import StepPersonalInfo from '../components/apply/StepPersonalInfo.vue'
import StepExperience from '../components/apply/StepExperience.vue'
import StepDrivingHistory from '../components/apply/StepDrivingHistory.vue'
import StepCertifications from '../components/apply/StepCertifications.vue'
import StepReferences from '../components/apply/StepReferences.vue'

const stepLabels = ['Personal Info', 'Experience', 'Driving History', 'Certifications', 'References']
const step = ref(0)
const submitting = ref(false)
const submitted = ref(false)
const error = ref('')

const defaultForm = () => ({
  first_name: '', last_name: '', email: '', phone: '', dob: '', address: '', ssn: '', drivers_license: '', position: '',
  experience: '', has_cdl: '', work_authorized: '', felony_convicted: '', felony_explanation: '',
  accident_history: '', accident_description: '', traffic_citations: '',
  certifications: '', availability: [], skills: '',
  reference_info: '', additional_info: '', signature: '', signature_date: '',
})

const form = reactive(defaultForm())

function validate(s) {
  if (s === 0) {
    if (!form.first_name || !form.last_name || !form.email || !form.phone || !form.dob || !form.address || !form.ssn || !form.drivers_license || !form.position) return 'Please fill in all required fields in this section.'
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
    if (!form.signature) return 'Please type your full name as a signature.'
  }
  return ''
}

function nextStep() {
  const err = validate(step.value)
  if (err) { error.value = err; return }
  error.value = ''
  step.value++
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

async function submitForm() {
  const err = validate(step.value)
  if (err) { error.value = err; return }
  error.value = ''
  submitting.value = true
  try {
    const payload = { ...form, full_name: `${form.first_name} ${form.last_name}`.trim() }
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

function resetForm() {
  Object.assign(form, defaultForm())
  step.value = 0
  submitted.value = false
  error.value = ''
}
</script>

<style scoped>
.apply-page {
  min-height: 100vh;
  background: #f8f9fb;
  padding: 2rem 1rem;
}
.apply-container {
  max-width: 720px;
  margin: 0 auto;
}
.apply-header {
  text-align: center;
  margin-bottom: 2rem;
}
.apply-logo {
  width: 140px;
  height: auto;
  margin: 0 auto 0.75rem;
}
.apply-header h1 {
  font-size: 1.5rem;
  font-weight: 700;
  color: #111827;
  margin-bottom: 0.25rem;
}
.apply-header p {
  font-size: 0.88rem;
  color: #9ca3af;
}
.apply-card {
  border-radius: 14px !important;
  border: 1px solid #e8edf2 !important;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06) !important;
}
.apply-footer {
  text-align: center;
  margin-top: 2rem;
  font-size: 0.72rem;
  color: #d1d5db;
}

/* Step sections */
:deep(.section-header) {
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #e8edf2;
}
:deep(.section-header h3) {
  font-size: 1.1rem;
  font-weight: 700;
  color: #111827;
  margin-bottom: 0.25rem;
}
:deep(.section-header p) {
  font-size: 0.82rem;
  color: #9ca3af;
}

/* Fields */
:deep(.field) {
  margin-bottom: 1.1rem;
}
:deep(.field-label) {
  display: block;
  font-size: 0.82rem;
  font-weight: 600;
  color: #374151;
  margin-bottom: 0.4rem;
}
:deep(.field-label .req) {
  color: #dc2626;
}
:deep(.input-wrap) {
  display: flex;
  align-items: center;
  border: 1.5px solid #e2e4ea;
  border-radius: 10px;
  background: #f9fafb;
  overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}
:deep(.input-wrap:focus-within) {
  border-color: hsl(199, 89%, 48%);
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.1);
  background: #fff;
}
:deep(.input-wrap input),
:deep(.input-wrap textarea) {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  padding: 0.7rem 0.85rem;
  font-size: 0.88rem;
  font-family: inherit;
  color: #111827;
  resize: vertical;
}
:deep(.input-wrap input::placeholder),
:deep(.input-wrap textarea::placeholder) {
  color: #c4c8d0;
}

/* Radio / Checkbox */
:deep(.radio-group),
:deep(.checkbox-group) {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
:deep(.radio-item),
:deep(.checkbox-item) {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.85rem;
  border: 1.5px solid #e2e4ea;
  border-radius: 10px;
  background: #f9fafb;
  cursor: pointer;
  transition: all 0.15s;
  font-size: 0.88rem;
  color: #374151;
}
:deep(.radio-item:hover),
:deep(.checkbox-item:hover) {
  border-color: hsl(199, 89%, 48%);
  background: #f0f9ff;
}
:deep(.radio-item input),
:deep(.checkbox-item input) {
  accent-color: hsl(199, 89%, 48%);
  width: 16px;
  height: 16px;
}

/* Actions */
.step-actions {
  display: flex;
  align-items: center;
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #e8edf2;
}
.spacer { flex: 1; }
.back-btn {
  padding: 0.7rem 1.5rem;
  border: 1.5px solid #e2e4ea;
  border-radius: 10px;
  background: white;
  color: #374151;
  font-size: 0.88rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}
.back-btn:hover {
  border-color: #9ca3af;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.next-btn, .submit-btn {
  padding: 0.7rem 2rem;
  border: none;
  border-radius: 10px;
  background: hsl(199, 89%, 48%);
  color: white;
  font-size: 0.88rem;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}
.next-btn:hover, .submit-btn:hover:not(:disabled) {
  background: hsl(199, 89%, 42%);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(56, 189, 248, 0.3);
}
.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.error-bar {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 0.6rem 1rem;
  font-size: 0.82rem;
  color: #dc2626;
  margin-top: 1rem;
}

/* Success */
.success-card { text-align: center; }
.success-icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: #ecfdf5;
  color: #059669;
  font-size: 1.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
}

/* Grid helper */
:deep(.grid) { display: grid; }
:deep(.grid-cols-2) { grid-template-columns: 1fr 1fr; }
:deep(.gap-4) { gap: 1rem; }
@media (max-width: 640px) {
  :deep(.grid-cols-2) { grid-template-columns: 1fr; }
}
</style>
