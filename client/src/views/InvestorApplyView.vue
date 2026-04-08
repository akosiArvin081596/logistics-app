<template>
  <div class="invest-page">
    <!-- ═══ LEFT SIDEBAR ═══ -->
    <aside class="invest-sidebar">
      <div class="sidebar-top">
        <div class="sidebar-logo">
          <img src="/logo.avif" alt="LogisX" class="sidebar-logo-img" />
        </div>
        <div class="sidebar-subtitle">Investor Onboarding Wizard</div>
      </div>

      <nav class="sidebar-steps">
        <div
          v-for="(s, i) in sidebarSteps"
          :key="i"
          class="sidebar-step"
          :class="{
            active: !completed && step === i,
            done: completed || step > i,
          }"
        >
          <div class="step-icon">
            <!-- Completed checkmark -->
            <svg v-if="completed || step > i" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            <!-- Step number -->
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

    <!-- ═══ MOBILE TOP BAR (hidden on desktop) ═══ -->
    <div v-if="!completed" class="mobile-topbar">
      <div class="mobile-logo">
        <img src="/logo.avif" alt="LogisX" class="mobile-logo-img" />
        <span>LogisX</span>
      </div>
      <div class="mobile-steps">
        <div
          v-for="(s, i) in sidebarSteps"
          :key="i"
          class="mobile-dot"
          :class="{ active: step === i, done: step > i }"
        />
      </div>
      <div class="mobile-step-label">Step {{ step + 1 }} of 3</div>
    </div>

    <!-- ═══ RIGHT CONTENT PANEL ═══ -->
    <main class="invest-content">

      <!-- Success Screen -->
      <div v-if="completed" class="success-wrap">
        <div class="success-content">
          <div class="success-check">
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          </div>
          <h2>Onboarding Complete</h2>
          <p>Thank you, <strong>{{ form.legal_name }}</strong>. Your application and all documents have been submitted successfully.</p>
          <div class="next-steps">
            <h4>What happens next</h4>
            <div class="next-step"><span class="ns-num">1</span><span>Our team will review your application within 1-2 business days</span></div>
            <div class="next-step"><span class="ns-num">2</span><span>You'll receive login credentials via email once approved</span></div>
            <div class="next-step"><span class="ns-num">3</span><span>Access your investor dashboard to track fleet performance</span></div>
          </div>
        </div>
      </div>

      <template v-else>
        <!-- STEP 1: Application -->
        <div v-if="step === 0" class="step-panel">
          <div class="content-header">
            <span class="step-label">Step 1 of 3</span>
            <h2>Investor Application</h2>
            <p>Tell us about you and your business</p>
            <div class="trust-badge">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <span>256-bit encrypted &amp; secure</span>
            </div>
          </div>

          <div class="section-divider">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            <span>General Information</span>
          </div>
          <div class="form-grid">
            <div class="field full">
              <label>Legal Name (Individual or Entity) <span class="req">*</span></label>
              <input v-model="form.legal_name" placeholder="e.g. John Doe or Doe Enterprises LLC" required />
            </div>
            <div class="field">
              <label>DBA <span class="opt">(if applicable)</span></label>
              <input v-model="form.dba" placeholder="Doing business as..." />
            </div>
            <div class="field">
              <label>Entity Type</label>
              <select v-model="form.entity_type">
                <option value="">Select type...</option>
                <option>LLC</option><option>Corp</option><option>Sole Prop</option><option>Other</option>
              </select>
            </div>
            <div class="field full">
              <label>Principal Address <span class="req">*</span></label>
              <div class="address-row">
                <div class="address-input-wrap">
                  <input ref="addressInput" v-model="form.address" placeholder="Start typing an address..." required autocomplete="off" />
                  <button type="button" class="addr-action-btn" :disabled="geolocating" @click="useCurrentLocation" title="Use my current location">
                    <svg v-if="!geolocating" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
                    <span v-else class="spinner"></span>
                  </button>
                </div>
                <button type="button" class="map-btn" @click="showMapPicker = true" title="Pick on map">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
                </button>
              </div>
            </div>
            <div class="field"><label>Primary Contact Person</label><input v-model="form.contact_person" placeholder="Full name" /></div>
            <div class="field"><label>Title</label><input v-model="form.contact_title" placeholder="e.g. Owner, Manager" /></div>
            <div class="field"><label>Phone <span class="req">*</span></label><input v-model="form.phone" type="tel" placeholder="(555) 123-4567" required /></div>
            <div class="field"><label>Email <span class="req">*</span></label><input v-model="form.email" type="email" placeholder="you@company.com" required /></div>
          </div>

          <div class="section-divider">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            <span>Business Profile</span>
          </div>
          <div class="form-grid">
            <div class="field"><label>Years in Operation</label><input v-model="form.years_in_operation" placeholder="e.g. 5" /></div>
            <div class="field">
              <label>Industry Experience</label>
              <select v-model="form.industry_experience"><option value="">Select...</option><option>Yes</option><option>No</option></select>
            </div>
            <div class="field"><label>Total Fleet Size (Currently Owned)</label><input v-model="form.fleet_size" placeholder="e.g. 3" /></div>
            <div class="field">
              <label>Preferred Communication</label>
              <select v-model="form.preferred_communication"><option value="">Select...</option><option>Email</option><option>Text</option><option>Phone</option></select>
            </div>
          </div>

          <div class="section-divider">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            <span>Financial &amp; Tax</span>
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Tax Classification</label>
              <select v-model="form.tax_classification"><option value="">Select...</option><option>C-Corp</option><option>S-Corp</option><option>Partnership</option><option>Individual/LLC</option></select>
            </div>
            <div class="field"><label>EIN or SSN <span class="req">*</span></label><input v-model="form.ein_ssn" placeholder="XX-XXXXXXX" required /></div>
            <div class="field">
              <label>Monthly Reporting Delivery</label>
              <select v-model="form.reporting_preference"><option value="">Select...</option><option>Digital Portal</option><option>Email PDF</option></select>
            </div>
          </div>

          <div class="step-actions">
            <div></div>
            <button class="btn-primary" :disabled="!canProceedStep1 || submitting" @click="submitApplication">
              <span v-if="submitting" class="spinner light"></span>
              {{ submitting ? 'Submitting...' : 'Continue' }}
              <svg v-if="!submitting" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
          </div>
        </div>

        <!-- STEP 2: Document Signing -->
        <div v-if="step === 1" class="step-panel">
          <div class="content-header">
            <span class="step-label">Step 2 of 3</span>
            <h2>Sign Onboarding Documents</h2>
            <p>Review and sign each document to proceed</p>
          </div>

          <div class="doc-progress">
            <div class="doc-progress-bar">
              <div class="doc-progress-fill" :style="{ width: (signedCount / totalDocs * 100) + '%' }"></div>
            </div>
            <span class="doc-progress-text">{{ signedCount }} of {{ totalDocs }} signed</span>
          </div>

          <!-- Vehicle info (for Exhibit A) -->
          <div v-if="!vehicleInfoDone" class="vehicle-card">
            <div class="section-divider">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
              <span>Vehicle Information (Exhibit A)</span>
            </div>
            <div class="form-grid">
              <div class="field"><label>Year <span class="req">*</span></label><input v-model="vehicle.year" placeholder="e.g. 2022" required /></div>
              <div class="field"><label>Make <span class="req">*</span></label><input v-model="vehicle.make" placeholder="e.g. Freightliner" required /></div>
              <div class="field"><label>Model <span class="req">*</span></label><input v-model="vehicle.model" placeholder="e.g. Cascadia" required /></div>
              <div class="field"><label>VIN <span class="req">*</span></label><input v-model="vehicle.vin" placeholder="17-character VIN" required /></div>
              <div class="field"><label>Current Mileage</label><input v-model="vehicle.mileage" placeholder="e.g. 120,000" /></div>
              <div class="field"><label>Title State</label><input v-model="vehicle.titleState" placeholder="e.g. Texas" /></div>
              <div class="field"><label>Existing Liens</label><input v-model="vehicle.liens" placeholder="None or lien holder name" /></div>
              <div class="field"><label>Registered Owner</label><input v-model="vehicle.registeredOwner" placeholder="Owner on title" /></div>
            </div>
            <div class="step-actions">
              <div></div>
              <button class="btn-primary" :disabled="!vehicle.year || !vehicle.make || !vehicle.model || !vehicle.vin" @click="vehicleInfoDone = true">
                Save &amp; Continue
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
              </button>
            </div>
          </div>

          <!-- Document list -->
          <div v-else class="doc-list">
            <div v-for="doc in documents" :key="doc.doc_key" class="doc-card" :class="{ signed: doc.signed }" @click="openDoc(doc)">
              <div class="doc-icon-wrap" :class="doc.signed ? 'done' : 'pending'">
                <svg v-if="doc.signed" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              </div>
              <div class="doc-info">
                <div class="doc-name">{{ doc.doc_name }}</div>
                <div class="doc-meta">{{ doc.signed ? 'Completed' : 'Awaiting your signature' }}</div>
              </div>
              <span class="doc-chip" :class="doc.signed ? 'chip-done' : 'chip-sign'">
                {{ doc.signed ? 'View' : 'Sign' }}
              </span>
            </div>

            <div class="step-actions">
              <div></div>
              <button class="btn-primary" :disabled="signedCount < totalDocs" @click="step = 2">
                Continue
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
              </button>
            </div>
          </div>
        </div>

        <!-- STEP 3: Banking -->
        <div v-if="step === 2" class="step-panel">
          <div class="content-header">
            <span class="step-label">Step 3 of 3</span>
            <h2>Banking Information</h2>
            <p>ACH/Direct Deposit details for Net-60 settlements</p>
          </div>

          <div class="bank-security-note">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <span>Your banking information is encrypted and stored securely.</span>
          </div>

          <div class="form-grid">
            <div class="field full"><label>Bank Name <span class="req">*</span></label><input v-model="banking.bank_name" placeholder="e.g. Chase, Wells Fargo" required /></div>
            <div class="field">
              <label>Account Type</label>
              <select v-model="banking.account_type"><option value="">Select...</option><option>Business Checking</option><option>Personal Checking</option><option>Savings</option></select>
            </div>
            <div class="field"><label>Name on Account</label><input v-model="banking.account_name" placeholder="As it appears on the account" /></div>
            <div class="field"><label>Routing Number <span class="req">*</span></label><input v-model="banking.routing_number" placeholder="9-digit routing number" required /></div>
            <div class="field"><label>Account Number <span class="req">*</span></label><input v-model="banking.account_number" placeholder="Account number" required /></div>
          </div>

          <div class="step-actions">
            <button class="btn-ghost" @click="step = 1">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
              Back
            </button>
            <button class="btn-primary" :disabled="!canSubmitBanking || submitting" @click="submitBanking">
              <span v-if="submitting" class="spinner light"></span>
              {{ submitting ? 'Submitting...' : 'Complete Onboarding' }}
            </button>
          </div>
        </div>
      </template>
    </main>

    <!-- Modals -->
    <InvestorSignModal
      :show="showSignModal" :doc="selectedDoc" :pdf-url="selectedPdfUrl"
      :application-id="applicationId" :access-token="accessToken"
      :vehicle-info="vehicleInfoDone ? vehicle : null"
      @close="showSignModal = false" @signed="handleSigned"
    />
    <LocationPickerModal
      :open="showMapPicker" label="Principal Address"
      @close="showMapPicker = false" @confirm="onMapConfirm"
    />
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted } from 'vue'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import InvestorSignModal from '../components/invest/InvestorSignModal.vue'
import LocationPickerModal from '../components/data-manager/LocationPickerModal.vue'

const sidebarSteps = [
  { title: 'Application', desc: 'Business & contact info' },
  { title: 'Documents', desc: 'Sign onboarding docs' },
  { title: 'Banking', desc: 'ACH settlement details' },
]

const addressInput = ref(null)
const showMapPicker = ref(false)
const geolocating = ref(false)
const api = useApi()
const { show: toast } = useToast()

const step = ref(0)
const submitting = ref(false)
const completed = ref(false)
const applicationId = ref(null)
const accessToken = ref('')
const documents = ref([])
const totalDocs = ref(3)
const showSignModal = ref(false)
const selectedDoc = ref(null)
const selectedPdfUrl = ref('')
const vehicleInfoDone = ref(false)

const form = reactive({
  legal_name: '', dba: '', entity_type: '', address: '', contact_person: '', contact_title: '',
  phone: '', email: '', years_in_operation: '', industry_experience: '', fleet_size: '',
  preferred_communication: '', tax_classification: '', ein_ssn: '', bankruptcy_liens: '', reporting_preference: '',
})

const vehicle = reactive({
  year: '', make: '', model: '', vin: '', mileage: '', titleState: '', liens: '', registeredOwner: '',
})

const banking = reactive({
  bank_name: '', account_type: '', routing_number: '', account_number: '', account_name: '',
})

// Google Places autocomplete for address
onMounted(async () => {
  try {
    const { key } = await api.get('/api/config/maps-key')
    if (!key) return
    if (window.google?.maps?.places) { initAddrAutocomplete(); return }
    const existing = document.querySelector('script[src*="maps.googleapis.com/maps/api"]')
    if (existing) {
      const check = setInterval(() => {
        if (window.google?.maps?.places) { clearInterval(check); initAddrAutocomplete() }
      }, 200)
      return
    }
    await new Promise((resolve, reject) => {
      const cbName = '_gmInvestReady' + Date.now()
      window[cbName] = () => { delete window[cbName]; resolve() }
      const script = document.createElement('script')
      script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places,marker&v=weekly&loading=async&callback=${cbName}`
      script.async = true
      script.onerror = reject
      document.head.appendChild(script)
    })
    initAddrAutocomplete()
  } catch { /* skip */ }
})
function initAddrAutocomplete() {
  if (!addressInput.value) return
  const ac = new window.google.maps.places.Autocomplete(addressInput.value, { types: ['address'], componentRestrictions: { country: 'us' } })
  ac.addListener('place_changed', () => {
    const place = ac.getPlace()
    if (place?.formatted_address) form.address = place.formatted_address
  })
}

function onMapConfirm({ displayName }) {
  if (displayName) form.address = displayName
  showMapPicker.value = false
}

async function useCurrentLocation() {
  if (!navigator.geolocation) return
  geolocating.value = true
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const res = await fetch(`/api/geocode?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`)
        if (res.ok) {
          const data = await res.json()
          if (data.results?.[0]?.formatted_address) {
            form.address = data.results[0].formatted_address
          }
        }
      } catch { /* skip */ }
      geolocating.value = false
    },
    () => { geolocating.value = false },
    { timeout: 8000, enableHighAccuracy: false }
  )
}

const canProceedStep1 = computed(() => form.legal_name && form.email && form.phone && form.address && form.ein_ssn)
const signedCount = computed(() => documents.value.filter(d => d.signed).length)
const canSubmitBanking = computed(() => banking.bank_name && banking.routing_number && banking.account_number)

async function submitApplication() {
  if (submitting.value) return
  submitting.value = true
  try {
    const result = await api.post('/api/public/investor-apply', { ...form })
    applicationId.value = result.applicationId
    accessToken.value = result.accessToken
    await loadOnboarding()
    step.value = 1
    toast('Application submitted', 'success')
  } catch (err) {
    toast(err.message || 'Submission failed', 'error')
  } finally {
    submitting.value = false
  }
}

async function loadOnboarding() {
  if (!applicationId.value) return
  const data = await api.get(`/api/public/investor-onboarding/${applicationId.value}?token=${accessToken.value}`)
  documents.value = data.documents || []
  totalDocs.value = data.totalDocs || 3
}

function openDoc(doc) {
  selectedDoc.value = doc
  selectedPdfUrl.value = `/api/public/investor-onboarding/${applicationId.value}/documents/${doc.doc_key}/pdf?token=${accessToken.value}`
  showSignModal.value = true
}

async function handleSigned() {
  showSignModal.value = false
  await loadOnboarding()
}

async function submitBanking() {
  if (submitting.value) return
  submitting.value = true
  try {
    await api.post(`/api/public/investor-onboarding/${applicationId.value}/banking`, { ...banking, accessToken: accessToken.value })
    completed.value = true
    toast('Onboarding complete!', 'success')
  } catch (err) {
    toast(err.message || 'Submission failed', 'error')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
/* ═══════════════════════════════════════════
   TWO-PANEL LAYOUT
   ═══════════════════════════════════════════ */
.invest-page {
  display: flex;
  min-height: 100vh;
  font-family: 'DM Sans', system-ui, sans-serif;
  background: #fff;
}

/* ─── SIDEBAR ─── */
.invest-sidebar {
  width: 290px;
  flex-shrink: 0;
  background: #0f2847;
  display: flex;
  flex-direction: column;
  padding: 2rem 1.5rem;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}

.sidebar-top { margin-bottom: 2.5rem; }

.sidebar-logo {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}
.sidebar-logo-img {
  height: 32px;
  display: block;
  filter: brightness(0) invert(1);
}
.sidebar-subtitle {
  margin-top: 0.6rem;
  font-size: 0.78rem;
  color: rgba(255, 255, 255, 0.4);
  font-weight: 500;
  letter-spacing: 0.03em;
}

/* ─── Sidebar steps ─── */
.sidebar-steps {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.sidebar-step {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.85rem 1rem;
  border-radius: 10px;
  transition: all 0.2s ease;
  border-left: 3px solid transparent;
}

.sidebar-step.active {
  background: rgba(255, 255, 255, 0.08);
  border-left-color: #3b82f6;
}

.sidebar-step.done .step-icon {
  background: #22c55e;
  border-color: #22c55e;
  color: #fff;
}

.step-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.78rem;
  font-weight: 700;
  border: 1.5px solid rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.4);
  transition: all 0.2s ease;
}

.sidebar-step.active .step-icon {
  background: #3b82f6;
  border-color: #3b82f6;
  color: #fff;
}

.step-text { min-width: 0; }

.step-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.45);
  transition: color 0.2s;
}

.sidebar-step.active .step-title,
.sidebar-step.done .step-title {
  color: #fff;
}

.step-desc {
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.25);
  margin-top: 0.1rem;
  transition: color 0.2s;
}

.sidebar-step.active .step-desc {
  color: rgba(255, 255, 255, 0.5);
}
.sidebar-step.done .step-desc {
  color: rgba(255, 255, 255, 0.4);
}

/* ─── Sidebar footer ─── */
.sidebar-footer {
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.25);
  padding-top: 1.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

/* ─── MOBILE TOPBAR (hidden desktop) ─── */
.mobile-topbar { display: none; }

/* ─── CONTENT PANEL ─── */
.invest-content {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.step-panel {
  flex: 1;
  padding: 2rem 3rem 2rem;
  width: 100%;
  max-width: 880px;
}

/* ─── Content header ─── */
.content-header { margin-bottom: 1.5rem; }

.step-label {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #94a3b8;
  margin-bottom: 0.35rem;
}

.content-header h2 {
  font-size: 1.45rem;
  font-weight: 800;
  color: #0f172a;
  letter-spacing: -0.02em;
  margin-bottom: 0.2rem;
}

.content-header p {
  font-size: 0.85rem;
  color: #94a3b8;
}

.trust-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.85rem;
  padding: 0.3rem 0.85rem;
  background: #f0fdf4;
  border-radius: 99px;
  font-size: 0.72rem;
  font-weight: 600;
  color: #15803d;
}

/* ─── Section dividers ─── */
.section-divider {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 1.5rem 0 0.85rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #f1f5f9;
  color: #64748b;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* ─── Form fields ─── */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.9rem 1.1rem;
}
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field.full { grid-column: 1 / -1; }
.field label { font-size: 0.75rem; font-weight: 600; color: #475569; }
.req { color: #ef4444; }
.opt { font-weight: 400; color: #94a3b8; font-size: 0.72rem; }

.field input,
.field select {
  padding: 0.55rem 0.8rem;
  border: 1.5px solid #e2e8f0;
  border-radius: 9px;
  font-size: 0.85rem;
  color: #0f172a;
  background: #fff;
  font-family: inherit;
  transition: all 0.15s ease;
}
.field input::placeholder { color: #cbd5e1; }
.field input:hover,
.field select:hover { border-color: #cbd5e1; }
.field input:focus,
.field select:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

/* ─── Address row ─── */
.address-row { display: flex; gap: 0.5rem; }
.address-input-wrap { flex: 1; position: relative; }
.address-input-wrap input { width: 100%; padding-right: 38px; }
.addr-action-btn {
  position: absolute; right: 7px; top: 50%; transform: translateY(-50%);
  width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 6px; background: transparent;
  color: #94a3b8; cursor: pointer; transition: all 0.15s;
}
.addr-action-btn:hover { background: #f1f5f9; color: #475569; }
.addr-action-btn:disabled { cursor: wait; opacity: 0.4; }
.map-btn {
  flex-shrink: 0; width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  border: 1.5px solid #e2e8f0; border-radius: 10px; background: #fff;
  color: #94a3b8; cursor: pointer; transition: all 0.15s;
}
.map-btn:hover { border-color: #3b82f6; color: #3b82f6; }

/* ─── Spinner ─── */
.spinner {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid #94a3b8; border-top-color: transparent;
  border-radius: 50%; animation: spin 0.7s linear infinite;
}
.spinner.light { border-color: rgba(255,255,255,0.35); border-top-color: #fff; }
@keyframes spin { to { transform: rotate(360deg); } }

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
  margin-top: 1.75rem; gap: 1rem;
  padding-top: 1.25rem;
  border-top: 1px solid #f1f5f9;
}

/* ─── Document progress ─── */
.doc-progress { margin-bottom: 1.75rem; }
.doc-progress-bar {
  height: 4px; background: #f1f5f9; border-radius: 99px; overflow: hidden;
}
.doc-progress-fill {
  height: 100%; border-radius: 99px;
  background: #0f2847; transition: width 0.4s ease;
}
.doc-progress-text {
  display: block; text-align: right; margin-top: 0.4rem;
  font-size: 0.72rem; font-weight: 600; color: #94a3b8;
}

/* ─── Document cards ─── */
.doc-list { display: flex; flex-direction: column; gap: 0.65rem; }
.doc-card {
  display: flex; align-items: center; gap: 0.85rem;
  padding: 1rem 1.15rem; border-radius: 14px;
  border: 1.5px solid #f1f5f9; cursor: pointer;
  transition: all 0.15s ease; background: #fff;
}
.doc-card:hover { border-color: #e2e8f0; background: #fafbfd; }
.doc-card.signed { border-color: #d1fae5; background: #f7fdf9; }
.doc-icon-wrap {
  width: 40px; height: 40px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.doc-icon-wrap.done { background: #dcfce7; color: #16a34a; }
.doc-icon-wrap.pending { background: #f1f5f9; color: #94a3b8; }
.doc-info { flex: 1; min-width: 0; }
.doc-name { font-weight: 600; font-size: 0.88rem; color: #0f172a; }
.doc-meta { font-size: 0.72rem; color: #94a3b8; margin-top: 0.15rem; }
.doc-chip {
  flex-shrink: 0; padding: 0.3rem 0.85rem; border-radius: 99px;
  font-size: 0.72rem; font-weight: 700;
}
.chip-sign { background: #f1f5f9; color: #475569; }
.chip-done { background: #dcfce7; color: #16a34a; }

/* ─── Vehicle card ─── */
.vehicle-card {
  background: #fafbfd; border: 1.5px solid #f1f5f9; border-radius: 14px; padding: 1.5rem;
}

/* ─── Banking security ─── */
.bank-security-note {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.7rem 1rem; margin-bottom: 1.5rem;
  background: #f0fdf4; border: 1px solid #d1fae5; border-radius: 10px;
  font-size: 0.78rem; color: #15803d; font-weight: 500;
}

/* ─── Success ─── */
.success-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}
.success-content { text-align: center; max-width: 480px; }
.success-check {
  width: 72px; height: 72px; border-radius: 50%; margin: 0 auto 1.75rem;
  background: #dcfce7; color: #16a34a;
  display: flex; align-items: center; justify-content: center;
  animation: popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes popIn { 0% { transform: scale(0); } 100% { transform: scale(1); } }
.success-content h2 {
  font-size: 1.5rem; font-weight: 800; color: #0f172a; margin-bottom: 0.5rem;
}
.success-content > p {
  color: #64748b; font-size: 0.9rem; max-width: 420px; margin: 0 auto; line-height: 1.6;
}
.next-steps {
  margin-top: 2.25rem; text-align: left;
  background: #fafbfd; border-radius: 14px; padding: 1.5rem 1.75rem;
  border: 1px solid #f1f5f9;
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

/* ═══════════════════════════════════════════
   RESPONSIVE
   ═══════════════════════════════════════════ */
@media (max-width: 768px) {
  .invest-sidebar { display: none; }

  .mobile-topbar {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding: 1.25rem 1.5rem;
    background: #0f2847;
  }

  .mobile-logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.1rem;
    font-weight: 800;
    color: #fff;
  }
  .mobile-logo-img {
    height: 26px;
    filter: brightness(0) invert(1);
  }

  .mobile-steps {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .mobile-dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: rgba(255, 255, 255, 0.2);
    transition: all 0.2s;
  }
  .mobile-dot.active {
    background: #3b82f6;
    width: 28px;
    border-radius: 99px;
  }
  .mobile-dot.done { background: #22c55e; }

  .mobile-step-label {
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.45);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .invest-page { flex-direction: column; }
  .invest-content { min-height: auto; }
  .step-panel { padding: 1.5rem 1.25rem 2rem; }
  .content-header h2 { font-size: 1.25rem; }
  .form-grid { grid-template-columns: 1fr; }
}
</style>
