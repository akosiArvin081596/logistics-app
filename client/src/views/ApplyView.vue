<template>
  <div class="apply-page">
    <!-- ═══ LEFT SIDEBAR ═══ -->
    <aside class="apply-sidebar">
      <div class="sidebar-top">
        <div class="sidebar-logo">
          <img src="/logo.png" alt="LogisX" class="sidebar-logo-img" />
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
        <img src="/logo.png" alt="LogisX" class="mobile-logo-img" />
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
          <p>Thanks for getting your paperwork squared away, <strong>{{ form.first_name }}</strong>. Now that the legal stuff is signed and uploaded, you've officially cleared Phase 1. We are currently reviewing your file.</p>

          <div class="next-steps">
            <h4>Here is what happens next</h4>
            <div class="next-step">
              <span class="ns-num">1</span>
              <span><strong>Pre-Employment Screening:</strong> A member of our safety team will contact you shortly to schedule your <strong>pre-appointment drug test</strong>. If you've already completed one recently for another carrier, let us know, but expect to be sent for a new one under the LogisX account.</span>
            </div>
            <div class="next-step">
              <span class="ns-num">2</span>
              <span><strong>FMCSA Clearinghouse:</strong> This is mandatory. If you haven't already, make sure you are enrolled in the <strong>FMCSA Clearinghouse</strong> and have granted LogisX Inc. permission to run your full query. We cannot put you in a truck until this is cleared.</span>
            </div>
            <div class="next-step">
              <span class="ns-num">3</span>
              <span><strong>Driver Training:</strong> While we finalize your background check, it's time to get in the right mindset. At LogisX, we pride ourselves on professional, elite operation.</span>
            </div>
          </div>

          <div class="pro-tip">
            <div class="pro-tip-header">Pro-Tip: Don't end up on the internet for the wrong reasons.</div>
            <p>To understand the standard of safety we expect, take a look at what <em>not</em> to do out there. Check out these "professional" moves on <strong>Bonehead Truckers</strong> — study them so you don't repeat them.</p>
          </div>

          <!-- Link button instead of iframe embed — the video owner disabled
               off-site playback so the embed rendered as "Video unavailable".
               Matches the red CTA button used in the acceptance email. -->
          <div class="video-link-wrap">
            <a
              href="https://www.youtube.com/watch?v=KpHxeBQ3TSc&list=PL7DBE50EBBC23F024"
              target="_blank"
              rel="noopener noreferrer"
              class="video-link"
            >
              <span class="video-link-play">&#9654;</span>
              Watch Bonehead Truckers
            </a>
          </div>

          <div class="standby-note">
            <p>Stand by for a call from our safety coordinator.</p>
            <p class="team-sign">— The LogisX Safety Team</p>
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
            <button v-else class="btn-primary" @click="openReview">
              Review &amp; Submit
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
          </div>
        </div>
      </template>
    </main>

    <!-- Review Modal -->
    <div v-if="showReviewModal" class="review-overlay" @click.self="showReviewModal = false">
      <div class="review-modal">
        <div class="review-header">
          <h3>Review Your Application</h3>
          <button class="review-close" @click="showReviewModal = false">&times;</button>
        </div>
        <div class="review-body">
          <!-- Personal Info -->
          <div class="review-section">
            <div class="review-section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              Personal Information
            </div>
            <div class="review-grid">
              <div class="review-item"><span class="review-label">Full Name</span><span class="review-value">{{ form.first_name }} {{ form.last_name }}</span></div>
              <div class="review-item"><span class="review-label">Email</span><span class="review-value">{{ form.email }}</span></div>
              <div class="review-item"><span class="review-label">Phone</span><span class="review-value">{{ form.phone }}</span></div>
              <div v-if="form.cell" class="review-item"><span class="review-label">Cell</span><span class="review-value">{{ form.cell }}</span></div>
              <div class="review-item"><span class="review-label">Date of Birth</span><span class="review-value">{{ form.dob }}</span></div>
              <div class="review-item full"><span class="review-label">Address</span><span class="review-value">{{ form.address }}</span></div>
              <div class="review-item"><span class="review-label">City</span><span class="review-value">{{ form.city }}</span></div>
              <div class="review-item"><span class="review-label">State</span><span class="review-value">{{ form.state }}</span></div>
              <div class="review-item"><span class="review-label">ZIP</span><span class="review-value">{{ form.zip }}</span></div>
              <div class="review-item"><span class="review-label">Driver's License</span><span class="review-value">{{ form.drivers_license }}</span></div>
              <div class="review-item"><span class="review-label">Position</span><span class="review-value">{{ form.position }}</span></div>
              <div class="review-item"><span class="review-label">Hazmat</span><span class="review-value">{{ form.hazmat }}</span></div>
              <div v-if="form.dot" class="review-item"><span class="review-label">DOT #</span><span class="review-value">{{ form.dot }}</span></div>
              <div v-if="form.mc" class="review-item"><span class="review-label">MC #</span><span class="review-value">{{ form.mc }}</span></div>
              <div class="review-item"><span class="review-label">CDL Front</span><span class="review-value" :class="form.cdl_front ? 'text-green' : 'text-amber'">{{ form.cdl_front ? 'Uploaded' : 'Missing' }}</span></div>
              <div class="review-item"><span class="review-label">CDL Back</span><span class="review-value" :class="form.cdl_back ? 'text-green' : 'text-amber'">{{ form.cdl_back ? 'Uploaded' : 'Missing' }}</span></div>
              <div class="review-item"><span class="review-label">Medical Card</span><span class="review-value" :class="form.medical_card ? 'text-green' : 'text-amber'">{{ form.medical_card ? 'Uploaded' : 'Missing' }}</span></div>
            </div>
          </div>

          <!-- Experience -->
          <div class="review-section">
            <div class="review-section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
              Experience
            </div>
            <div class="review-grid">
              <div class="review-item"><span class="review-label">Years of Experience</span><span class="review-value">{{ form.experience }}</span></div>
              <div class="review-item"><span class="review-label">Valid CDL</span><span class="review-value">{{ form.has_cdl }}</span></div>
              <div class="review-item"><span class="review-label">Work Authorized</span><span class="review-value">{{ form.work_authorized }}</span></div>
              <div class="review-item"><span class="review-label">Felony Conviction</span><span class="review-value">{{ form.felony_convicted }}</span></div>
              <div v-if="form.felony_explanation" class="review-item full"><span class="review-label">Felony Explanation</span><span class="review-value">{{ form.felony_explanation }}</span></div>
            </div>
          </div>

          <!-- Driving History -->
          <div class="review-section">
            <div class="review-section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
              Driving History
            </div>
            <div class="review-grid">
              <div class="review-item"><span class="review-label">Accident History</span><span class="review-value">{{ form.accident_history }}</span></div>
              <div v-if="form.accident_description" class="review-item full"><span class="review-label">Accident Description</span><span class="review-value">{{ form.accident_description }}</span></div>
              <div v-if="form.traffic_citations" class="review-item full"><span class="review-label">Traffic Citations</span><span class="review-value">{{ form.traffic_citations }}</span></div>
            </div>
          </div>

          <!-- Certifications -->
          <div class="review-section">
            <div class="review-section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              Certifications &amp; Availability
            </div>
            <div class="review-grid">
              <div v-if="form.certifications" class="review-item full"><span class="review-label">Certifications</span><span class="review-value">{{ form.certifications }}</span></div>
              <div class="review-item full"><span class="review-label">Availability</span><span class="review-value">{{ form.availability.join(', ') || 'None' }}</span></div>
              <div class="review-item full"><span class="review-label">Skills</span><span class="review-value">{{ form.skills }}</span></div>
            </div>
          </div>

          <!-- References -->
          <div class="review-section" style="border-bottom:none;margin-bottom:0;">
            <div class="review-section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              References &amp; Signature
            </div>
            <div v-for="(r, i) in form.references" :key="i" class="review-ref">
              <div class="review-ref-label">Reference {{ i + 1 }}</div>
              <div class="review-grid">
                <div class="review-item"><span class="review-label">Company</span><span class="review-value">{{ r.name }}</span></div>
                <div class="review-item"><span class="review-label">Phone</span><span class="review-value">{{ r.phone }}</span></div>
                <div v-if="r.relationship" class="review-item"><span class="review-label">Email</span><span class="review-value">{{ r.relationship }}</span></div>
                <div v-if="r.contactPerson" class="review-item"><span class="review-label">Contact Person</span><span class="review-value">{{ r.contactPerson }}</span></div>
              </div>
            </div>
            <div class="review-grid" style="margin-top:0.75rem;">
              <div class="review-item full"><span class="review-label">Signature</span><span class="review-value" style="font-family:'Dancing Script',cursive;font-size:1.1rem;font-style:italic">{{ form.signature }}</span></div>
            </div>
          </div>
        </div>

        <div class="review-footer">
          <button class="btn-ghost" @click="showReviewModal = false">Go Back &amp; Edit</button>
          <button class="btn-primary" :disabled="submitting" @click="showReviewModal = false; submitForm()">
            <span v-if="submitting" class="spinner light"></span>
            {{ submitting ? 'Submitting...' : 'Submit Application' }}
          </button>
        </div>
      </div>
    </div>

    <LocationPickerModal
      :open="showMapPicker" label="Current Address"
      @close="showMapPicker = false" @confirm="onMapConfirm"
    />
  </div>
</template>

<script setup>
import { ref, reactive, watch, onMounted } from 'vue'
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
const showReviewModal = ref(false)

function openReview() {
  const err = validate(step.value)
  if (err) { error.value = err; return }
  error.value = ''
  showReviewModal.value = true
}

function onMapConfirm({ displayName }) {
  if (displayName) form.address = displayName
  showMapPicker.value = false
}

const defaultForm = () => ({
  first_name: '', last_name: '', email: '', phone: '', cell: '', dob: '',
  address: '', city: '', state: '', zip: '',
  ssn: '', drivers_license: '', position: '',
  dot: '', mc: '', hazmat: '',
  cdl_front: '', cdl_back: '', medical_card: '',
  experience: '', has_cdl: '', work_authorized: '', felony_convicted: '', felony_explanation: '',
  accident_history: '', accident_description: '', traffic_citations: '',
  certifications: '', availability: [], skills: '',
  references: [
    { name: '', phone: '', relationship: '', contactPerson: '' },
    { name: '', phone: '', relationship: '', contactPerson: '' },
    { name: '', phone: '', relationship: '', contactPerson: '' },
  ],
  additional_info: '', signature: '', signature_date: '',
})

const form = reactive(defaultForm())

// ── State persistence: localStorage for text + IndexedDB for photos ──
const STORAGE_KEY = 'logisx_apply_state'
const IDB_NAME = 'logisx_apply'
const IDB_STORE = 'uploads'

// localStorage: all text fields (sync, reliable, same as /invest)
function saveState() {
  try {
    const { cdl_front, cdl_back, medical_card, ...lite } = form
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      step: step.value, maxStep: maxStep.value, form: lite,
      submitted: submitted.value,
    }))
  } catch { /* full */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const s = JSON.parse(raw)
    if (s.step != null) step.value = s.step
    if (s.maxStep != null) maxStep.value = s.maxStep
    if (s.form) Object.assign(form, s.form)
    if (s.submitted) submitted.value = s.submitted
    maxStep.value = Math.max(maxStep.value, step.value)
  } catch { /* corrupt */ }
}

// IndexedDB: photo uploads only (handles large base64)
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbSave(key, value) {
  idbOpen().then(db => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => db.close()
    tx.onerror = () => db.close()
  }).catch(() => {})
}

function idbLoad(key) {
  return idbOpen().then(db => new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(key)
    req.onsuccess = () => { db.close(); resolve(req.result || '') }
    req.onerror = () => { db.close(); resolve('') }
  })).catch(() => '')
}

function idbClear() {
  idbOpen().then(db => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).clear()
    tx.oncomplete = () => db.close()
  }).catch(() => {})
}

// Save photos to IndexedDB when they change
watch(() => form.cdl_front, (v) => { if (v) idbSave('cdl_front', v) })
watch(() => form.cdl_back, (v) => { if (v) idbSave('cdl_back', v) })
watch(() => form.medical_card, (v) => { if (v) idbSave('medical_card', v) })

// Auto-save text to localStorage on any change
watch(step, saveState)
watch(submitted, saveState)
watch(form, saveState, { deep: true })

// Load on mount: localStorage (sync) + IndexedDB photos (async)
onMounted(async () => {
  loadState()
  const [cdl_front, cdl_back, medical_card] = await Promise.all([
    idbLoad('cdl_front'), idbLoad('cdl_back'), idbLoad('medical_card'),
  ])
  if (cdl_front) form.cdl_front = cdl_front
  if (cdl_back) form.cdl_back = cdl_back
  if (medical_card) form.medical_card = medical_card
})

function goToStep(i) {
  if (submitted.value) return
  if (i <= maxStep.value) {
    error.value = ''
    step.value = i
  }
}

function validate(s) {
  if (s === 0) {
    if (!form.first_name || !form.last_name || !form.email || !form.phone || !form.dob || !form.address || !form.city || !form.state || !form.zip || !form.ssn || !form.drivers_license || !form.position || !form.hazmat) return 'Please fill in all required fields in this section.'
    if (!form.cdl_front || !form.cdl_back || !form.medical_card) return 'Please upload CDL (front and back) and medical card images.'
  }
  if (s === 1) {
    if (!form.experience || !form.has_cdl || !form.work_authorized || !form.felony_convicted) return 'Please answer all required questions.'
  }
  if (s === 2) {
    if (!form.accident_history) return 'Please answer the accident history question.'
  }
  if (s === 3) {
    if (form.availability.length === 0) return 'Please select your availability.'
  }
  if (s === 4) {
    const missingRef = form.references.some(r => !r.name || !r.phone)
    if (missingRef) return 'Please provide company and phone for all 3 references.'
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
    localStorage.removeItem(STORAGE_KEY)
    idbClear()
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

.pro-tip {
  margin-top: 1.75rem; padding: 1.25rem 1.5rem;
  background: #fffbeb; border: 1px solid #fef3c7; border-left: 4px solid #f59e0b;
  border-radius: 10px;
}
.pro-tip-header { font-size: 0.88rem; font-weight: 700; color: #92400e; margin-bottom: 0.5rem; }
.pro-tip p { font-size: 0.85rem; color: #78350f; line-height: 1.6; margin: 0; }

.video-link-wrap {
  margin-top: 1.5rem;
  text-align: center;
}
.video-link {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  background: #dc2626;
  color: #ffffff;
  padding: 0.75rem 1.75rem;
  border-radius: 8px;
  text-decoration: none;
  font-weight: 700;
  font-size: 0.88rem;
  transition: background 0.15s ease, transform 0.15s ease;
}
.video-link:hover {
  background: #b91c1c;
  transform: translateY(-1px);
}
.video-link-play {
  font-size: 0.85rem;
  line-height: 1;
}

.standby-note {
  margin-top: 1.75rem; text-align: center;
}
.standby-note p { font-size: 0.9rem; color: #475569; margin: 0 0 0.25rem; }
.team-sign { font-weight: 700; color: #0f172a; font-size: 0.88rem; margin-top: 0.5rem !important; }
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

/* ─── Review Modal ─── */
.review-overlay {
  position: fixed; inset: 0; z-index: 999;
  background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center; padding: 1rem;
}
.review-modal {
  background: #fff; border-radius: 14px;
  width: 100%; max-width: 700px; max-height: 90vh;
  display: flex; flex-direction: column; overflow: hidden;
}
.review-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 1rem 1.5rem; border-bottom: 1px solid #e9edf3;
}
.review-header h3 { font-size: 1.1rem; font-weight: 700; color: #0f172a; margin: 0; }
.review-close {
  font-size: 1.5rem; background: none; border: none;
  cursor: pointer; color: #94a3b8; line-height: 1;
}
.review-body { flex: 1; overflow-y: auto; padding: 1.25rem 1.5rem; }
.review-section {
  margin-bottom: 1.25rem; padding-bottom: 1rem; border-bottom: 1px solid #f1f5f9;
}
.review-section-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.82rem; font-weight: 700; color: #0f172a;
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.75rem;
}
.review-section-title svg { color: #3b82f6; }
.review-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 1rem; }
.review-item { display: flex; flex-direction: column; gap: 0.1rem; }
.review-item.full { grid-column: 1 / -1; }
.review-label { font-size: 0.7rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
.review-value { font-size: 0.85rem; color: #0f172a; font-weight: 500; }
.text-green { color: #16a34a; }
.text-amber { color: #d97706; }
.review-ref {
  margin-bottom: 0.75rem; padding: 0.65rem 0.85rem;
  background: #fafbfd; border-radius: 8px; border: 1px solid #f1f5f9;
}
.review-ref-label { font-size: 0.75rem; font-weight: 700; color: #475569; margin-bottom: 0.5rem; }
.review-footer {
  display: flex; justify-content: space-between; align-items: center;
  padding: 1rem 1.5rem; border-top: 1px solid #e9edf3; gap: 1rem;
}
</style>
