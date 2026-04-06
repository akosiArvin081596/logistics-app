<template>
  <div class="step-section">
    <div class="section-header">
      <h3>Personal Information</h3>
      <p>Please provide your basic details</p>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">Full Name <span class="req">*</span></label><div class="input-wrap"><input v-model="form.full_name" placeholder="John Doe" required /></div></div>
      <div class="field"><label class="field-label">Email Address <span class="req">*</span></label><div class="input-wrap"><input v-model="form.email" type="email" placeholder="you@email.com" required /></div></div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">Phone Number <span class="req">*</span></label><div class="input-wrap"><input v-model="form.phone" type="tel" placeholder="(555) 555-5555" required /></div></div>
      <div class="field"><label class="field-label">Date of Birth <span class="req">*</span></label><div class="input-wrap"><input v-model="form.dob" type="date" required /></div></div>
    </div>
    <div class="field"><label class="field-label">Current Address and Zip Code <span class="req">*</span></label><div class="input-wrap"><textarea v-model="form.address" rows="2" placeholder="123 Main St, City, State 12345" required></textarea></div></div>
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
const props = defineProps({ form: { type: Object, required: true } })
const positions = ['Company Driver', 'Owner Operator', 'Other']
</script>
