<template>
  <div class="step-section">
    <div class="section-header">
      <h3>Experience and Qualifications</h3>
      <p>Answer the questions below</p>
    </div>
    <div class="field">
      <label class="field-label">How many years of experience do you have in the trucking or logistics industry? <span class="req">*</span></label>
      <div class="radio-group">
        <label class="radio-item" v-for="opt in experienceOpts" :key="opt"><input type="radio" v-model="form.experience" :value="opt" /><span>{{ opt }}</span></label>
      </div>
    </div>
    <div class="field">
      <label class="field-label">Do you have a valid commercial driver's license (CDL)? <span class="req">*</span></label>
      <div class="radio-group">
        <label class="radio-item" v-for="opt in cdlOpts" :key="opt"><input type="radio" v-model="form.has_cdl" :value="opt" /><span>{{ opt }}</span></label>
      </div>
    </div>
    <div class="field">
      <label class="field-label">Are you legally authorized to work in the United States? <span class="req">*</span></label>
      <div class="radio-group">
        <label class="radio-item" v-for="opt in yesNo" :key="opt"><input type="radio" v-model="form.work_authorized" :value="opt" /><span>{{ opt }}</span></label>
      </div>
    </div>
    <div class="field">
      <label class="field-label">Have you ever been convicted of a felony? <span class="req">*</span></label>
      <div class="radio-group">
        <label class="radio-item" v-for="opt in yesNo" :key="'f'+opt"><input type="radio" v-model="form.felony_convicted" :value="opt" /><span>{{ opt }}</span></label>
      </div>
    </div>
    <div v-if="form.felony_convicted === 'Yes'" class="field">
      <label class="field-label">If yes, please explain</label>
      <div class="input-wrap"><textarea v-model="form.felony_explanation" rows="3" placeholder="Please provide details..."></textarea></div>
    </div>
  </div>
</template>

<script setup>
defineProps({ form: { type: Object, required: true } })
const experienceOpts = ['None', 'Less than 1 yr', '1-3 years', 'More than 3 years']
const cdlOpts = ['Yes', 'No', 'Not Applicable (For non-Driver Positions)']
const yesNo = ['Yes', 'No']
</script>
