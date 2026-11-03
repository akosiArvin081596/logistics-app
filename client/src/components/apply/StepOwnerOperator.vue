<template>
  <div class="step-section">
    <div class="section-header">
      <h3>Your Truck</h3>
      <p>The truck you will drive for LogisX as an owner-operator</p>
    </div>
    <div class="grid grid-cols-3 gap-4">
      <div class="field"><label class="field-label">Year <span class="req">*</span></label><div class="input-wrap"><input v-model="truck.truck_year" inputmode="numeric" maxlength="4" placeholder="2020" /></div></div>
      <div class="field"><label class="field-label">Make <span class="req">*</span></label><div class="input-wrap"><input v-model="truck.truck_make" maxlength="40" placeholder="Make" /></div></div>
      <div class="field"><label class="field-label">Model <span class="req">*</span></label><div class="input-wrap"><input v-model="truck.truck_model" maxlength="40" placeholder="Model" /></div></div>
    </div>
    <div class="field"><label class="field-label">VIN <span class="req">*</span></label><div class="input-wrap"><input v-model="truck.truck_vin" maxlength="17" autocapitalize="characters" placeholder="17 characters, as on the title or registration" /></div></div>
    <div class="grid grid-cols-3 gap-4">
      <div class="field"><label class="field-label">License plate <span class="req">*</span></label><div class="input-wrap"><input v-model="truck.truck_plate" maxlength="12" autocapitalize="characters" placeholder="Plate" /></div></div>
      <div class="field"><label class="field-label">Plate state <span class="req">*</span></label><div class="input-wrap"><input v-model="truck.truck_plate_state" maxlength="2" autocapitalize="characters" placeholder="TX" /></div></div>
      <div class="field"><label class="field-label">Unit number <span class="opt">(optional)</span></label><div class="input-wrap"><input v-model="truck.truck_unit" maxlength="20" placeholder="If it has one" /></div></div>
    </div>
    <div class="field">
      <label class="field-label">Do you own it or lease it? <span class="req">*</span></label>
      <div class="radio-group">
        <label class="radio-item"><input type="radio" v-model="truck.truck_ownership" value="own" /><span>I own it</span></label>
        <label class="radio-item"><input type="radio" v-model="truck.truck_ownership" value="lease" /><span>I lease it</span></label>
      </div>
    </div>
    <div class="field"><label class="field-label">Registered owner <span class="req">*</span></label><div class="input-wrap"><input v-model="truck.registered_owner" maxlength="100" placeholder="As on the title or registration" /></div></div>
    <div class="field"><label class="field-label">Business name <span class="opt">(optional)</span></label><div class="input-wrap"><input v-model="truck.business_name" maxlength="100" placeholder="If you run your truck as a business" /></div></div>
  </div>
</template>

<script setup>
// Edits the form's `owner_operator` object (ApplyView.vue); ApplyView checks it
// with validateOwnerOperatorTruck() (src/lib/ownerOperatorApply.js) on Continue.
defineProps({ truck: { type: Object, required: true } })
</script>
