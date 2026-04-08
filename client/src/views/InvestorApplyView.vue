<template>
  <div class="invest-page">
    <div class="invest-container">
      <div class="invest-header">
        <img src="/logo.avif" alt="LogisX" class="invest-logo" />
        <h1>Investor Onboarding</h1>
        <p>Complete the steps below to get started with LogisX.</p>
      </div>

      <!-- Success screen -->
      <div v-if="completed" class="invest-success">
        <div class="success-icon">&#9989;</div>
        <h2>Onboarding Complete</h2>
        <p>Thank you, {{ form.legal_name }}. Your application has been submitted and all documents are signed. Our team will review and contact you shortly.</p>
      </div>

      <template v-else>
        <StepIndicator :steps="['Application', 'Documents', 'W-9 & Banking']" :current="step" />

        <!-- STEP 1: Application -->
        <div v-if="step === 0" class="step-content">
          <h2 class="step-title">Investor Application</h2>

          <div class="form-section">General Information</div>
          <div class="form-grid">
            <div class="form-group full"><label>Legal Name (Individual or Entity) *</label><input v-model="form.legal_name" required /></div>
            <div class="form-group"><label>DBA (if applicable)</label><input v-model="form.dba" /></div>
            <div class="form-group"><label>Entity Type</label>
              <select v-model="form.entity_type"><option value="">Select...</option><option>LLC</option><option>Corp</option><option>Sole Prop</option><option>Other</option></select>
            </div>
            <div class="form-group full"><label>Principal Address *</label>
              <div class="address-row">
                <input ref="addressInput" v-model="form.address" placeholder="Start typing an address..." required autocomplete="off" />
                <button type="button" class="map-pick-btn" @click="showMapPicker = true" title="Pick on map">&#128205;</button>
              </div>
            </div>
            <div class="form-group"><label>Primary Contact Person</label><input v-model="form.contact_person" /></div>
            <div class="form-group"><label>Title</label><input v-model="form.contact_title" /></div>
            <div class="form-group"><label>Phone *</label><input v-model="form.phone" type="tel" required /></div>
            <div class="form-group"><label>Email *</label><input v-model="form.email" type="email" required /></div>
          </div>

          <div class="form-section">Business Profile</div>
          <div class="form-grid">
            <div class="form-group"><label>Years in Operation</label><input v-model="form.years_in_operation" /></div>
            <div class="form-group"><label>Industry Experience</label>
              <select v-model="form.industry_experience"><option value="">Select...</option><option>Yes</option><option>No</option></select>
            </div>
            <div class="form-group"><label>Total Fleet Size (Currently Owned)</label><input v-model="form.fleet_size" /></div>
            <div class="form-group"><label>Preferred Communication</label>
              <select v-model="form.preferred_communication"><option value="">Select...</option><option>Email</option><option>Text</option><option>Phone</option></select>
            </div>
          </div>

          <div class="form-section">Financial & Tax</div>
          <div class="form-grid">
            <div class="form-group"><label>Tax Classification</label>
              <select v-model="form.tax_classification"><option value="">Select...</option><option>C-Corp</option><option>S-Corp</option><option>Partnership</option><option>Individual/LLC</option></select>
            </div>
            <div class="form-group"><label>EIN or SSN *</label><input v-model="form.ein_ssn" required /></div>
            <div class="form-group"><label>Monthly Reporting Delivery</label>
              <select v-model="form.reporting_preference"><option value="">Select...</option><option>Digital Portal</option><option>Email PDF</option></select>
            </div>
          </div>

          <div class="step-actions">
            <div></div>
            <button class="btn-primary" :disabled="!canProceedStep1 || submitting" @click="submitApplication">
              {{ submitting ? 'Submitting...' : 'Next: Sign Documents' }}
            </button>
          </div>
        </div>

        <!-- STEP 2: Document Signing -->
        <div v-if="step === 1" class="step-content">
          <h2 class="step-title">Sign Onboarding Documents</h2>
          <p class="step-desc">{{ signedCount }}/{{ totalDocs }} documents signed</p>

          <!-- Vehicle info (for Exhibit A) -->
          <div v-if="!vehicleInfoDone" class="card vehicle-form">
            <div class="form-section">Vehicle Information (Exhibit A)</div>
            <div class="form-grid">
              <div class="form-group"><label>Year *</label><input v-model="vehicle.year" required /></div>
              <div class="form-group"><label>Make *</label><input v-model="vehicle.make" required /></div>
              <div class="form-group"><label>Model *</label><input v-model="vehicle.model" required /></div>
              <div class="form-group"><label>VIN *</label><input v-model="vehicle.vin" required /></div>
              <div class="form-group"><label>Current Mileage</label><input v-model="vehicle.mileage" /></div>
              <div class="form-group"><label>Title State</label><input v-model="vehicle.titleState" /></div>
              <div class="form-group"><label>Existing Liens</label><input v-model="vehicle.liens" /></div>
              <div class="form-group"><label>Registered Owner</label><input v-model="vehicle.registeredOwner" /></div>
            </div>
            <button class="btn-primary" :disabled="!vehicle.year || !vehicle.make || !vehicle.model || !vehicle.vin" @click="vehicleInfoDone = true">Save Vehicle Info</button>
          </div>

          <!-- Document list -->
          <div v-else class="doc-list">
            <div v-for="doc in documents" :key="doc.doc_key" class="card doc-item" @click="openDoc(doc)">
              <div class="doc-icon" v-html="doc.signed ? '&#9989;' : '&#9723;'"></div>
              <div class="doc-info">
                <div class="doc-name">{{ doc.doc_name }}</div>
                <div class="doc-status" :class="doc.signed ? 'signed' : ''">{{ doc.signed ? 'Signed' : 'Pending' }}</div>
              </div>
              <div class="doc-action">{{ doc.signed ? 'View' : 'Sign' }}</div>
            </div>
            <div class="step-actions">
              <div></div> <!-- no back from Step 2 — application already submitted -->
              <button class="btn-primary" :disabled="signedCount < totalDocs" @click="step = 2">Next: Banking</button>
            </div>
          </div>
        </div>

        <!-- STEP 3: W-9 & Banking -->
        <div v-if="step === 2" class="step-content">
          <h2 class="step-title">Banking Information</h2>
          <p class="step-desc">Provide your ACH/Direct Deposit details for Net-60 settlements.</p>
          <div class="form-grid">
            <div class="form-group full"><label>Bank Name *</label><input v-model="banking.bank_name" required /></div>
            <div class="form-group"><label>Account Type</label>
              <select v-model="banking.account_type"><option value="">Select...</option><option>Business Checking</option><option>Personal Checking</option><option>Savings</option></select>
            </div>
            <div class="form-group"><label>Name on Account</label><input v-model="banking.account_name" /></div>
            <div class="form-group"><label>Routing Number (9 digits) *</label><input v-model="banking.routing_number" required /></div>
            <div class="form-group"><label>Account Number *</label><input v-model="banking.account_number" required /></div>
          </div>
          <div class="step-actions">
            <button class="btn-secondary" @click="step = 1">Back</button>
            <button class="btn-primary" :disabled="!canSubmitBanking || submitting" @click="submitBanking">
              {{ submitting ? 'Submitting...' : 'Complete Onboarding' }}
            </button>
          </div>
        </div>
      </template>

      <!-- Document sign modal -->
      <InvestorSignModal
        :show="showSignModal"
        :doc="selectedDoc"
        :pdf-url="selectedPdfUrl"
        :application-id="applicationId"
        :access-token="accessToken"
        :vehicle-info="vehicleInfoDone ? vehicle : null"
        @close="showSignModal = false"
        @signed="handleSigned"
      />

      <LocationPickerModal
        :open="showMapPicker"
        label="Principal Address"
        @close="showMapPicker = false"
        @confirm="onMapConfirm"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted } from 'vue'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import StepIndicator from '../components/apply/StepIndicator.vue'
import InvestorSignModal from '../components/invest/InvestorSignModal.vue'
import LocationPickerModal from '../components/data-manager/LocationPickerModal.vue'

const addressInput = ref(null)
const showMapPicker = ref(false)
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
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places,marker&v=weekly`
    script.onload = () => initAddrAutocomplete()
    document.head.appendChild(script)
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
.address-row { display: flex; gap: 0.5rem; }
.address-row input { flex: 1; }
.map-pick-btn {
  flex-shrink: 0; width: 38px; height: 38px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid #ddd; border-radius: 6px; background: #fff;
  font-size: 1.1rem; cursor: pointer;
}
.map-pick-btn:hover { background: #f0f0f0; border-color: #bbb; }
.invest-page {
  min-height: 100vh;
  background: #f5f6fa;
  padding: 2rem 1rem;
}
.invest-container {
  max-width: 720px;
  margin: 0 auto;
}
.invest-header {
  text-align: center;
  margin-bottom: 2rem;
}
.invest-logo { height: 48px; margin-bottom: 0.75rem; }
.invest-header h1 { font-size: 1.5rem; font-weight: 800; color: #1a1d27; }
.invest-header p { font-size: 0.88rem; color: #6b7085; margin-top: 0.25rem; }
.invest-success {
  text-align: center; padding: 3rem 1rem;
  background: white; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
.success-icon { font-size: 3rem; margin-bottom: 1rem; }
.invest-success h2 { font-size: 1.3rem; font-weight: 800; }
.invest-success p { color: #6b7085; margin-top: 0.5rem; max-width: 400px; margin-inline: auto; }
.step-content {
  background: white; border-radius: 14px; padding: 1.5rem;
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
.step-title { font-size: 1.15rem; font-weight: 800; margin-bottom: 0.25rem; }
.step-desc { font-size: 0.82rem; color: #6b7085; margin-bottom: 1rem; }
.form-section {
  font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
  color: #6b7085; margin: 1.25rem 0 0.5rem; padding-bottom: 0.3rem; border-bottom: 1px solid #e8edf2;
}
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
.form-group { display: flex; flex-direction: column; gap: 0.2rem; }
.form-group.full { grid-column: 1 / -1; }
.form-group label { font-size: 0.75rem; font-weight: 600; color: #374151; }
.form-group input, .form-group select {
  padding: 0.5rem 0.65rem; border: 1px solid #e2e4ea; border-radius: 8px; font-size: 0.88rem;
}
.step-actions { display: flex; justify-content: space-between; margin-top: 1.5rem; gap: 1rem; }
.btn-primary {
  padding: 0.65rem 1.5rem; background: #38bdf8; color: white; border: none; border-radius: 10px;
  font-weight: 700; font-size: 0.88rem; cursor: pointer;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary {
  padding: 0.65rem 1.5rem; background: white; color: #374151; border: 1px solid #e2e4ea;
  border-radius: 10px; font-weight: 600; font-size: 0.88rem; cursor: pointer;
}
.doc-list { display: flex; flex-direction: column; gap: 0.5rem; }
.doc-item {
  display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem;
  cursor: pointer; border-radius: 10px; border: 1px solid #e8edf2; transition: background 0.15s;
}
.doc-item:hover { background: #f9fafb; }
.doc-icon { font-size: 1.2rem; flex-shrink: 0; }
.doc-info { flex: 1; }
.doc-name { font-weight: 600; font-size: 0.88rem; }
.doc-status { font-size: 0.72rem; color: #9ca3af; }
.doc-status.signed { color: #059669; }
.doc-action {
  font-size: 0.72rem; font-weight: 700; color: #38bdf8; padding: 0.2rem 0.6rem;
  border-radius: 99px; background: rgba(56,189,248,0.1);
}
.card { background: white; border-radius: 12px; padding: 1rem; border: 1px solid #e8edf2; }
.vehicle-form { margin-bottom: 1rem; }
@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; }
}
</style>
