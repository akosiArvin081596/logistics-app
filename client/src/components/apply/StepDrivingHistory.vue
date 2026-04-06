<template>
  <div class="step-section">
    <div class="section-header">
      <h3>Driving and Accident History</h3>
      <p>Information on accidents or citations in the past 3 years</p>
    </div>
    <div class="field">
      <label class="field-label">Have you ever been involved in a motor vehicle accident while driving commercially? <span class="req">*</span></label>
      <div class="radio-group">
        <label class="radio-item" v-for="opt in yesNo" :key="opt"><input type="radio" v-model="form.accident_history" :value="opt" /><span>{{ opt }}</span></label>
      </div>
    </div>
    <div v-if="form.accident_history === 'Yes'" class="field">
      <label class="field-label">If yes, give a brief description of the accident and if you were at fault</label>
      <div class="input-wrap"><textarea v-model="form.accident_description" rows="3" placeholder="Describe the accident..."></textarea></div>
    </div>
    <div class="field">
      <label class="field-label">Have you received any traffic citations in the past 3 years?</label>
      <div class="radio-group">
        <label class="radio-item" v-for="opt in yesNo" :key="'t'+opt"><input type="radio" v-model="form.traffic_citations" :value="opt" /><span>{{ opt }}</span></label>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({ form: { type: Object, required: true } })
const yesNo = ['Yes', 'No']
</script>
