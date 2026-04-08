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
            clickable: !completed && i <= maxStep && i !== step,
          }"
          @click="goToStep(i)"
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
            <div class="field">
              <label>Title</label>
              <select v-model="form.contact_title">
                <option value="">Select...</option>
                <option>Owner</option><option>CEO</option><option>President</option>
                <option>Managing Member</option><option>Partner</option><option>Manager</option>
                <option>Director</option><option>CFO</option><option>Other</option>
              </select>
            </div>
            <div class="field"><label>Phone <span class="req">*</span></label><input v-model="form.phone" type="tel" placeholder="(555) 123-4567" required /></div>
            <div class="field"><label>Email <span class="req">*</span></label><input v-model="form.email" type="email" placeholder="you@company.com" required /></div>
          </div>

          <div class="section-divider">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            <span>Business Profile</span>
          </div>
          <div class="form-grid">
            <div class="field"><label>Years in Operation</label><input v-model="form.years_in_operation" type="number" min="0" max="100" placeholder="0" /></div>
            <div class="field">
              <label>Industry Experience</label>
              <select v-model="form.industry_experience"><option value="">Select...</option><option>Yes</option><option>No</option></select>
            </div>
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

        <!-- STEP 2: Fleet & Documents -->
        <div v-if="step === 1" class="step-panel">
          <div class="content-header">
            <span class="step-label">Step 2 of 3</span>
            <h2>Fleet &amp; Documents</h2>
            <p>Add your vehicles and sign onboarding documents</p>
          </div>

          <!-- Accordion 1: Fleet Information -->
          <details class="accordion" open>
            <summary class="accordion-toggle">
              <div class="accordion-title">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
                Fleet Information
              </div>
              <span class="accordion-badge" :class="allVehiclesValid ? 'badge-done' : 'badge-pending'">
                {{ allVehiclesValid ? 'Complete' : 'Required' }}
              </span>
            </summary>
            <div class="accordion-body">
              <div class="form-grid" style="margin-bottom: 1.25rem;">
                <div class="field">
                  <label>Total Fleet Size (Currently Owned) <span class="req">*</span></label>
                  <input v-model="form.fleet_size" type="number" min="1" max="20" placeholder="How many vehicles?" />
                </div>
              </div>

              <div v-if="parseInt(form.fleet_size) > 0">
                <div class="vehicle-tabs">
                  <button
                    v-for="(v, i) in vehicles"
                    :key="i"
                    class="vehicle-tab"
                    :class="{ active: activeVehicleTab === i, valid: v.year && v.make && v.model && v.vin }"
                    @click="activeVehicleTab = i"
                  >
                    <svg v-if="v.year && v.make && v.model && v.vin" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    Vehicle {{ String.fromCharCode(65 + i) }}
                  </button>
                </div>

                <div class="form-grid">
                  <div class="field">
                    <label>Status</label>
                    <select v-model="vehicles[activeVehicleTab].status">
                      <option value="Active">Active</option>
                      <option value="Inactive">Inactive</option>
                      <option value="Maintenance">Maintenance</option>
                      <option value="OOS">OOS</option>
                    </select>
                  </div>
                  <div class="field">
                    <label>Make <span class="req">*</span></label>
                    <select v-model="vehicles[activeVehicleTab].make">
                      <option value="">-- Select make --</option>
                      <option v-for="m in truckMakes" :key="m" :value="m">{{ m }}</option>
                    </select>
                  </div>
                  <div class="field">
                    <label>Model <span class="req">*</span></label>
                    <select v-model="vehicles[activeVehicleTab].model" :disabled="!vehicles[activeVehicleTab].make">
                      <option value="">{{ vehicles[activeVehicleTab].make ? '-- Select model --' : '-- Select make first --' }}</option>
                      <option v-for="m in activeModelOptions" :key="m" :value="m">{{ m }}</option>
                    </select>
                  </div>
                  <div class="field"><label>Year <span class="req">*</span></label><input v-model="vehicles[activeVehicleTab].year" type="number" placeholder="e.g. 2022" required /></div>
                  <div class="field"><label>VIN <span class="req">*</span></label><input v-model="vehicles[activeVehicleTab].vin" placeholder="Vehicle Identification Number" required /></div>
                  <div class="field"><label>License Plate</label><input v-model="vehicles[activeVehicleTab].licensePlate" placeholder="e.g. ABC-1234" /></div>
                  <div class="field"><label>Current Mileage</label><input v-model="vehicles[activeVehicleTab].mileage" placeholder="e.g. 120,000" /></div>
                  <div class="field state-field">
                    <label>Title State</label>
                    <input
                      v-model="vehicles[activeVehicleTab].titleState"
                      placeholder="Type to search state..."
                      autocomplete="off"
                      @focus="stateDropOpen = true"
                      @blur="setTimeout(() => stateDropOpen = false, 200)"
                    />
                    <div v-if="stateDropOpen && filteredStates.length" class="state-dropdown">
                      <div
                        v-for="st in filteredStates"
                        :key="st"
                        class="state-option"
                        @mousedown.prevent="vehicles[activeVehicleTab].titleState = st; stateDropOpen = false"
                      >{{ st }}</div>
                    </div>
                  </div>
                  <div class="field"><label>Existing Liens</label><input v-model="vehicles[activeVehicleTab].liens" placeholder="None or lien holder name" /></div>
                  <div class="field">
                    <label>Registered Owner</label>
                    <select v-model="vehicles[activeVehicleTab].registeredOwner">
                      <option value="">-- Select --</option>
                      <option v-if="form.legal_name" :value="form.legal_name">{{ form.legal_name }}</option>
                      <option v-if="form.contact_person && form.contact_person !== form.legal_name" :value="form.contact_person">{{ form.contact_person }}</option>
                    </select>
                  </div>
                  <div class="field full">
                    <label>Notes <span class="opt">(optional)</span></label>
                    <textarea v-model="vehicles[activeVehicleTab].notes" class="form-textarea" rows="2" placeholder="Any additional notes..."></textarea>
                  </div>
                  <div class="field full">
                    <label>Truck Photo <span class="opt">(optional)</span></label>
                    <div class="photo-row">
                      <label class="photo-choose-btn">
                        Choose File
                        <input :key="'photo-' + activeVehicleTab" type="file" accept="image/*" @change="onVehiclePhoto" class="photo-file-hidden" />
                      </label>
                      <span v-if="vehicles[activeVehicleTab].photoName" class="photo-filename">{{ vehicles[activeVehicleTab].photoName }}</span>
                      <span v-else class="photo-filename dim">No file chosen</span>
                      <a v-if="vehicles[activeVehicleTab].photo" href="#" class="photo-view-link" @click.prevent="photoPreviewUrl = vehicles[activeVehicleTab].photo">View</a>
                    </div>
                  </div>
                </div>

                <details class="biz-config" open>
                  <summary class="biz-config-label">Business Configuration</summary>
                  <div class="form-grid" style="margin-top: 0.75rem;">
                    <div class="field"><label>Purchase Price ($)</label><input v-model.number="vehicles[activeVehicleTab].purchasePrice" type="number" min="0" placeholder="58000" /></div>
                    <div class="field">
                      <label>Title Status</label>
                      <select v-model="vehicles[activeVehicleTab].titleStatus">
                        <option value="Clean">Clean</option>
                        <option value="Lien">Lien</option>
                      </select>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </details>

          <!-- Accordion 2: Onboarding Documents -->
          <details class="accordion" open>
            <summary class="accordion-toggle">
              <div class="accordion-title">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                Onboarding Documents
              </div>
              <span class="accordion-badge" :class="signedCount >= totalDocs ? 'badge-done' : 'badge-pending'">
                {{ signedCount }} / {{ totalDocs }} signed
              </span>
            </summary>
            <div class="accordion-body">
              <div class="doc-list">
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
              </div>
            </div>
          </details>

          <div class="step-actions">
            <div></div>
            <button class="btn-primary" :disabled="!allVehiclesValid || signedCount < totalDocs" @click="vehicleInfoDone = true; step = 2; maxStep = Math.max(maxStep, 2)">
              Continue
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
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

    <!-- Photo fullscreen preview -->
    <div v-if="photoPreviewUrl" class="photo-overlay" @click="photoPreviewUrl = ''">
      <button class="photo-overlay-close">&times;</button>
      <img :src="photoPreviewUrl" class="photo-overlay-img" />
    </div>

    <!-- Modals -->
    <InvestorSignModal
      :show="showSignModal" :doc="selectedDoc" :pdf-url="selectedPdfUrl"
      :application-id="applicationId" :access-token="accessToken"
      :vehicle-info="vehicles"
      @close="showSignModal = false" @signed="handleSigned"
    />
    <LocationPickerModal
      :open="showMapPicker" label="Principal Address"
      @close="showMapPicker = false" @confirm="onMapConfirm"
    />
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, watch } from 'vue'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import InvestorSignModal from '../components/invest/InvestorSignModal.vue'
import LocationPickerModal from '../components/data-manager/LocationPickerModal.vue'

const sidebarSteps = [
  { title: 'Application', desc: 'Business & contact info' },
  { title: 'Documents', desc: 'Sign onboarding docs' },
  { title: 'Banking', desc: 'ACH settlement details' },
]

const STORAGE_KEY = 'logisx_invest_state'
const addressInput = ref(null)
const showMapPicker = ref(false)
const geolocating = ref(false)
const api = useApi()
const { show: toast } = useToast()

const step = ref(0)
const maxStep = ref(0)
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

const usStates = [
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware',
  'Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky',
  'Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi',
  'Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico',
  'New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania',
  'Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont',
  'Virginia','Washington','West Virginia','Wisconsin','Wyoming',
]

const truckMakes = [
  'Freightliner', 'Kenworth', 'Peterbilt', 'Volvo', 'International',
  'Mack', 'Western Star', 'Hino', 'Isuzu', 'Ford', 'Chevrolet',
  'RAM', 'GMC', 'Tesla', 'Nikola', 'Other',
]
const truckModels = {
  Freightliner: ['Cascadia', 'Columbia', 'Coronado', 'M2 106', 'M2 112', '114SD', '122SD'],
  Kenworth: ['T680', 'T880', 'W900', 'W990', 'T270', 'T370', 'T440', 'T470'],
  Peterbilt: ['579', '389', '567', '520', '337', '348', '365', '367'],
  Volvo: ['VNL 760', 'VNL 860', 'VNL 300', 'VNR 300', 'VNR 400', 'VNR 600', 'VHD 300', 'VHD 400'],
  International: ['LT', 'RH', 'HV', 'HX', 'MV', 'CV'],
  Mack: ['Anthem', 'Pinnacle', 'Granite', 'LR', 'MD', 'TerraPro'],
  'Western Star': ['4900', '5700XE', '4700', '49X', '47X'],
  Hino: ['L6', 'L7', 'XL7', 'XL8', '268', '338'],
  Isuzu: ['NRR', 'NQR', 'NPR', 'NPR-HD', 'FTR', 'FVR'],
  Ford: ['F-650', 'F-750', 'F-59'],
  Chevrolet: ['Silverado 4500HD', 'Silverado 5500HD', 'Silverado 6500HD'],
  RAM: ['3500', '4500', '5500'],
  GMC: ['Sierra 3500HD', 'Sierra 4500HD', 'Sierra 5500HD'],
  Tesla: ['Semi'],
  Nikola: ['Tre BEV', 'Tre FCEV', 'Two'],
}

function emptyVehicle() {
  return {
    make: '', model: '', year: '', vin: '',
    licensePlate: '', status: 'Active',
    mileage: '', titleState: '', liens: '', registeredOwner: '',
    notes: '', photo: '', photoName: '',
    purchasePrice: 0, titleStatus: 'Clean',
  }
}
const vehicles = ref([emptyVehicle()])
const activeVehicleTab = ref(0)
const activeModelOptions = computed(() => truckModels[vehicles.value[activeVehicleTab.value]?.make] || [])
const stateDropOpen = ref(false)
const photoPreviewUrl = ref('')
const filteredStates = computed(() => {
  const q = (vehicles.value[activeVehicleTab.value]?.titleState || '').toLowerCase()
  if (!q) return usStates
  return usStates.filter(s => s.toLowerCase().includes(q))
})

// Reset model when make changes (but not when switching tabs)
let lastTab = activeVehicleTab.value
watch(() => vehicles.value[activeVehicleTab.value]?.make, (newMake, oldMake) => {
  const tabSwitched = activeVehicleTab.value !== lastTab
  lastTab = activeVehicleTab.value
  if (tabSwitched) return
  if (oldMake && newMake !== oldMake && vehicles.value[activeVehicleTab.value]) {
    vehicles.value[activeVehicleTab.value].model = ''
  }
})

watch(() => form.fleet_size, (val) => {
  const count = Math.max(1, Math.min(parseInt(val) || 1, 20))
  while (vehicles.value.length < count) vehicles.value.push(emptyVehicle())
  if (vehicles.value.length > count) vehicles.value.splice(count)
  if (activeVehicleTab.value >= count) activeVehicleTab.value = count - 1
})

const banking = reactive({
  bank_name: '', account_type: '', routing_number: '', account_number: '', account_name: '',
})

// ── State persistence ──
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      step: step.value, maxStep: maxStep.value, form: { ...form },
      vehicles: vehicles.value, banking: { ...banking },
      vehicleInfoDone: vehicleInfoDone.value, activeVehicleTab: activeVehicleTab.value,
      applicationId: applicationId.value, accessToken: accessToken.value,
      completed: completed.value,
    }))
  } catch { /* full storage */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const s = JSON.parse(raw)
    if (s.step != null) step.value = s.step
    if (s.maxStep != null) maxStep.value = s.maxStep
    if (s.form) Object.assign(form, s.form)
    if (s.vehicles?.length) vehicles.value = s.vehicles
    if (s.banking) Object.assign(banking, s.banking)
    if (s.vehicleInfoDone != null) vehicleInfoDone.value = s.vehicleInfoDone
    if (s.activeVehicleTab != null) activeVehicleTab.value = s.activeVehicleTab
    if (s.applicationId) applicationId.value = s.applicationId
    if (s.accessToken) accessToken.value = s.accessToken
    if (s.completed) completed.value = s.completed
    // Ensure maxStep is at least the current step
    maxStep.value = Math.max(maxStep.value, step.value)
  } catch { /* corrupt data */ }
}

// Auto-save on any change (individual watchers for reliability)
watch(step, saveState)
watch(completed, saveState)
watch(vehicleInfoDone, saveState)
watch(activeVehicleTab, saveState)
watch(vehicles, saveState, { deep: true })
watch(form, saveState, { deep: true })
watch(banking, saveState, { deep: true })

// Sidebar navigation
function goToStep(i) {
  if (completed.value) return
  if (i <= maxStep.value) step.value = i
}

// Restore state + Google Places autocomplete
onMounted(async () => {
  loadState()
  // Reload documents if we have an active onboarding session
  if (applicationId.value && accessToken.value && !completed.value) {
    loadOnboarding().catch(() => {})
  }
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

function onVehiclePhoto(e) {
  const file = e.target.files[0]
  if (!file) return
  const v = vehicles.value[activeVehicleTab.value]
  v.photoName = file.name
  const img = new Image()
  img.onload = () => {
    const MAX = 1600
    let { width, height } = img
    if (width > MAX || height > MAX) {
      if (width > height) { height = Math.round(height * MAX / width); width = MAX }
      else { width = Math.round(width * MAX / height); height = MAX }
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, width, height)
    v.photo = canvas.toDataURL('image/jpeg', 0.92)
  }
  img.src = URL.createObjectURL(file)
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
const allVehiclesValid = computed(() => vehicles.value.every(v => v.year && v.make && v.model && v.vin))
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
    maxStep.value = Math.max(maxStep.value, 1)
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

async function openDoc(doc) {
  // Save vehicles to server first (strip photos to keep payload small)
  if (applicationId.value && vehicles.value.length) {
    try {
      const stripped = vehicles.value.map(({ photo, photoName, ...rest }) => rest)
      await api.post(`/api/public/investor-onboarding/${applicationId.value}/vehicles`, {
        vehicles: stripped, accessToken: accessToken.value,
      })
    } catch { /* skip */ }
  }
  selectedDoc.value = doc
  selectedPdfUrl.value = doc.signed && doc.signed_pdf_url
    ? doc.signed_pdf_url
    : `/api/public/investor-onboarding/${applicationId.value}/documents/${doc.doc_key}/pdf?token=${accessToken.value}`
  showSignModal.value = true
}

async function handleSigned(docKey) {
  await loadOnboarding()
  // Refresh the modal to show the signed PDF
  const signedDoc = documents.value.find(d => d.doc_key === docKey)
  if (signedDoc) {
    selectedDoc.value = signedDoc
    selectedPdfUrl.value = signedDoc.signed_pdf_url || selectedPdfUrl.value
  }
}

async function submitBanking() {
  if (submitting.value) return
  submitting.value = true
  try {
    await api.post(`/api/public/investor-onboarding/${applicationId.value}/banking`, { ...banking, accessToken: accessToken.value })
    completed.value = true
    localStorage.removeItem(STORAGE_KEY)
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

.sidebar-step.clickable { cursor: pointer; }
.sidebar-step.clickable:hover { background: rgba(255, 255, 255, 0.05); }

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

/* ─── Accordions ─── */
.accordion {
  border: 1.5px solid #e9edf3;
  border-radius: 12px;
  margin-bottom: 1rem;
  overflow: hidden;
  background: #fff;
}
.accordion-toggle {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.85rem 1.15rem;
  cursor: pointer;
  user-select: none;
  list-style: none;
  background: #fafbfd;
  transition: background 0.15s;
}
.accordion-toggle:hover { background: #f1f5f9; }
.accordion-toggle::-webkit-details-marker { display: none; }
.accordion-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  font-weight: 700;
  color: #0f172a;
}
.accordion-title svg { color: #64748b; }
.accordion[open] .accordion-title svg { color: #3b82f6; }
.accordion-badge {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.2rem 0.6rem;
  border-radius: 99px;
}
.badge-done { background: #dcfce7; color: #16a34a; }
.badge-pending { background: #fef3c7; color: #b45309; }
.accordion-body {
  padding: 1.15rem;
  border-top: 1px solid #e9edf3;
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
  margin: 1.75rem 0 1rem;
  padding: 0.6rem 0;
  border-top: 1px solid #e9edf3;
  border-bottom: 1px solid #e9edf3;
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
.form-textarea {
  padding: 0.55rem 0.8rem;
  border: 1.5px solid #e2e8f0;
  border-radius: 9px;
  font-size: 0.85rem;
  color: #0f172a;
  background: #fff;
  font-family: inherit;
  resize: vertical;
  transition: all 0.15s ease;
}
.form-textarea:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}
.photo-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.photo-choose-btn {
  display: inline-flex; align-items: center;
  padding: 0.4rem 0.85rem; border: 1.5px solid #e2e8f0; border-radius: 8px;
  background: #fff; font-size: 0.8rem; font-weight: 600; color: #475569;
  cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.photo-choose-btn:hover { background: #f8fafc; border-color: #cbd5e1; }
.photo-file-hidden { display: none; }
.photo-filename {
  font-size: 0.78rem; color: #0f172a; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.photo-filename.dim { color: #94a3b8; }
.photo-view-link {
  font-size: 0.78rem;
  font-weight: 600;
  color: #3b82f6;
  white-space: nowrap;
  margin-left: auto;
}
.photo-view-link:hover { text-decoration: underline; }
.photo-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0, 0, 0, 0.85);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.photo-overlay-close {
  position: absolute; top: 1rem; right: 1.5rem;
  font-size: 2rem; color: #fff; background: none; border: none;
  cursor: pointer; z-index: 1001;
}
.photo-overlay-img {
  max-width: 90vw; max-height: 90vh;
  object-fit: contain; border-radius: 8px;
}
/* ─── State searchable dropdown ─── */
.state-field { position: relative; }
.state-dropdown {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 50;
  background: #fff; border: 1.5px solid #e2e8f0; border-radius: 9px;
  margin-top: 2px; max-height: 180px; overflow-y: auto;
  box-shadow: 0 4px 14px rgba(0,0,0,0.1);
}
.state-option {
  padding: 0.5rem 0.8rem; font-size: 0.84rem; cursor: pointer;
  color: #0f172a; transition: background 0.1s;
}
.state-option:hover { background: #f1f5f9; }

.biz-config {
  margin-top: 1.25rem;
  padding-top: 0.75rem;
  border-top: 1px solid #e9edf3;
}
.biz-config-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #64748b;
  cursor: pointer;
  user-select: none;
}

/* ─── Vehicle tabs ─── */
.vehicle-tabs {
  display: flex;
  gap: 0.35rem;
  margin-bottom: 1.25rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid #e9edf3;
  flex-wrap: wrap;
}
.vehicle-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.45rem 1rem;
  border: 1.5px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  color: #64748b;
  font-size: 0.78rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}
.vehicle-tab:hover { border-color: #cbd5e1; color: #475569; }
.vehicle-tab.active {
  background: #0f2847;
  border-color: #0f2847;
  color: #fff;
}
.vehicle-tab.valid:not(.active) {
  border-color: #bbf7d0;
  background: #f0fdf4;
  color: #16a34a;
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
