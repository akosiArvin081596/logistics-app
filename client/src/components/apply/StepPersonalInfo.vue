<template>
  <div class="step-section">
    <div class="section-header">
      <h3>Personal Information</h3>
      <p>Please provide your basic details</p>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">First Name <span class="req">*</span></label><div class="input-wrap"><input v-model="form.first_name" placeholder="John" required /></div></div>
      <div class="field"><label class="field-label">Last Name <span class="req">*</span></label><div class="input-wrap"><input v-model="form.last_name" placeholder="Doe" required /></div></div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">Email Address <span class="req">*</span></label><div class="input-wrap"><input v-model="form.email" type="email" placeholder="you@email.com" required /></div></div>
      <div class="field"><label class="field-label">Phone Number <span class="req">*</span></label><div class="input-wrap"><input v-model="form.phone" type="tel" placeholder="(555) 555-5555" required /></div></div>
    </div>
    <div class="field"><label class="field-label">Date of Birth <span class="req">*</span></label><div class="input-wrap"><input v-model="form.dob" type="date" required /></div></div>
    <div class="field">
      <label class="field-label">Current Address and Zip Code <span class="req">*</span></label>
      <div class="input-wrap"><input ref="addressInput" v-model="form.address" placeholder="Start typing an address..." required autocomplete="off" /></div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">Social Security Number (SSN) <span class="req">*</span></label><div class="input-wrap"><input v-model="form.ssn" placeholder="XXX-XX-XXXX" required /></div></div>
      <div class="field"><label class="field-label">Drivers License Number <span class="req">*</span></label><div class="input-wrap"><input v-model="form.drivers_license" placeholder="License number" required /></div></div>
    </div>

    <!-- CDL + Medical Card Uploads -->
    <div class="upload-section">
      <label class="field-label">CDL &amp; Medical Card Uploads <span class="req">*</span></label>
      <p class="upload-hint">Upload clear photos of your CDL (front and back) and medical card</p>
      <div class="upload-grid">
        <div class="upload-card" @click="$refs.cdlFrontInput.click()">
          <input ref="cdlFrontInput" type="file" accept="image/*,.pdf" hidden @change="handleFile($event, 'cdl_front')" />
          <template v-if="form.cdl_front">
            <img v-if="!fileTypes.cdl_front" :src="form.cdl_front" class="upload-preview" />
            <div v-else class="pdf-preview"><div class="pdf-icon">&#128196;</div><div class="upload-label">PDF uploaded</div></div>
          </template>
          <template v-else>
            <div class="upload-placeholder">&#128247;</div>
            <div class="upload-label">CDL Front</div>
          </template>
        </div>
        <div class="upload-card" @click="$refs.cdlBackInput.click()">
          <input ref="cdlBackInput" type="file" accept="image/*,.pdf" hidden @change="handleFile($event, 'cdl_back')" />
          <template v-if="form.cdl_back">
            <img v-if="!fileTypes.cdl_back" :src="form.cdl_back" class="upload-preview" />
            <div v-else class="pdf-preview"><div class="pdf-icon">&#128196;</div><div class="upload-label">PDF uploaded</div></div>
          </template>
          <template v-else>
            <div class="upload-placeholder">&#128247;</div>
            <div class="upload-label">CDL Back</div>
          </template>
        </div>
        <div class="upload-card" @click="$refs.medicalInput.click()">
          <input ref="medicalInput" type="file" accept="image/*,.pdf" hidden @change="handleFile($event, 'medical_card')" />
          <template v-if="form.medical_card">
            <img v-if="!fileTypes.medical_card" :src="form.medical_card" class="upload-preview" />
            <div v-else class="pdf-preview"><div class="pdf-icon">&#128196;</div><div class="upload-label">PDF uploaded</div></div>
          </template>
          <template v-else>
            <div class="upload-placeholder">&#128247;</div>
            <div class="upload-label">Medical Card</div>
          </template>
        </div>
      </div>
    </div>

    <div class="field">
      <label class="field-label">Position Applying For <span class="req">*</span></label>
      <div class="radio-group">
        <label class="radio-item" v-for="opt in positions" :key="opt"><input type="radio" v-model="form.position" :value="opt" /><span>{{ opt }}</span></label>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'

const props = defineProps({ form: { type: Object, required: true } })
const positions = ['Company Driver', 'Owner Operator', 'Other']
const addressInput = ref(null)
const fileTypes = reactive({ cdl_front: false, cdl_back: false, medical_card: false })

function handleFile(event, field) {
  const file = event.target.files[0]
  if (!file) return
  fileTypes[field] = file.type === 'application/pdf'
  const reader = new FileReader()
  reader.onload = (e) => { props.form[field] = e.target.result }
  reader.readAsDataURL(file)
}

onMounted(async () => {
  if (window.google && window.google.maps && window.google.maps.places) {
    initAutocomplete()
    return
  }
  const existing = document.querySelector('script[src*="maps.googleapis.com/maps/api"]')
  if (existing) {
    const check = setInterval(() => {
      if (window.google?.maps?.places) { clearInterval(check); initAutocomplete() }
    }, 200)
    return
  }
  try {
    const res = await fetch('/api/config/maps-key')
    const { key } = await res.json()
    if (!key) return
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=__initApplyAutocomplete`
    script.async = true
    window.__initApplyAutocomplete = () => initAutocomplete()
    document.head.appendChild(script)
  } catch { /* no maps key available */ }
})

function initAutocomplete() {
  if (!addressInput.value) return
  const autocomplete = new window.google.maps.places.Autocomplete(addressInput.value, {
    types: ['address'],
    componentRestrictions: { country: 'us' },
  })
  autocomplete.addListener('place_changed', () => {
    const place = autocomplete.getPlace()
    if (place && place.formatted_address) {
      props.form.address = place.formatted_address
    }
  })
}
</script>

<style scoped>
.upload-section { margin-bottom: 1.1rem; }
.upload-hint { font-size: 0.78rem; color: #9ca3af; margin: 0.25rem 0 0.75rem; }
.upload-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.75rem; }
.upload-card {
  border: 2px dashed #e2e4ea;
  border-radius: 10px;
  padding: 1rem;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #f9fafb;
  overflow: hidden;
}
.upload-card:hover { border-color: hsl(199, 89%, 48%); background: #f0f9ff; }
.upload-placeholder { font-size: 1.75rem; margin-bottom: 0.35rem; }
.upload-label { font-size: 0.75rem; font-weight: 600; color: #6b7280; }
.upload-preview {
  width: 100%;
  height: 100px;
  object-fit: cover;
  border-radius: 6px;
}
.pdf-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}
.pdf-icon {
  font-size: 2rem;
}
@media (max-width: 640px) {
  .upload-grid { grid-template-columns: 1fr; }
}
</style>
