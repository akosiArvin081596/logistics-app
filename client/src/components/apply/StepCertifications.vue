<template>
  <div class="step-section">
    <div class="section-header">
      <h3>Certifications &amp; Availability</h3>
      <p>Answer the questions below</p>
    </div>
    <div class="field">
      <label class="field-label">If you have any certifications / endorsements, list them below</label>
      <div class="input-wrap"><textarea v-model="form.certifications" rows="3" placeholder="e.g. Hazmat, Tanker, Doubles/Triples..."></textarea></div>
    </div>
    <div class="field">
      <label class="field-label">What days and times are you available to work? <span class="req">*</span></label>
      <div class="checkbox-group">
        <label class="checkbox-item" v-for="opt in availOpts" :key="opt">
          <input type="checkbox" :value="opt" v-model="form.availability" />
          <span>{{ opt }}</span>
        </label>
      </div>
    </div>
    <div class="field">
      <label class="field-label">List a few skills you may have that can be beneficial while working with LogisX <span class="req">*</span></label>
      <div class="input-wrap"><textarea v-model="form.skills" rows="3" placeholder="Your relevant skills..."></textarea></div>
    </div>
  </div>
</template>

<script setup>
defineProps({ form: { type: Object, required: true } })
const availOpts = ['Monday-Friday (Day shift)', 'Monday-Friday (Night Shift)', 'Weekends', 'Flexible']
</script>
