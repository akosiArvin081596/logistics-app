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
      <div class="input-wrap">
        <input ref="addressInput" v-model="form.address" placeholder="Start typing an address..." required autocomplete="off" />
      </div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">Social Security Number (SSN) <span class="req">*</span></label><div class="input-wrap"><input v-model="form.ssn" placeholder="XXX-XX-XXXX" required /></div></div>
      <div class="field"><label class="field-label">Drivers License Number <span class="req">*</span></label><div class="input-wrap"><input v-model="form.drivers_license" placeholder="License number" required /></div></div>
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
import { ref, onMounted } from 'vue'

const props = defineProps({ form: { type: Object, required: true } })
const positions = ['Company Driver', 'Owner Operator', 'Other']
const addressInput = ref(null)

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
