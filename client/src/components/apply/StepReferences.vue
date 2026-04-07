<template>
  <div class="step-section">
    <div class="section-header">
      <h3>References &amp; Signature</h3>
      <p>Add any additional information along with a reference contact</p>
    </div>
    <div class="field">
      <label class="field-label">Please provide the name and contact information for at least one professional reference</label>
      <div class="input-wrap"><textarea v-model="form.reference_info" rows="3" placeholder="Name, phone, email, relationship..."></textarea></div>
    </div>
    <div class="field">
      <label class="field-label">Is there anything else you would like for us to know?</label>
      <div class="input-wrap"><textarea v-model="form.additional_info" rows="3" placeholder="Any additional information..."></textarea></div>
    </div>
    <div class="certification-box">
      <p>"I certify that the information provided in this application is true and complete to the best of my knowledge. I understand that any false statements or omissions may result in disqualification or termination of employment. I authorize investigation of all statements and release all persons from liability for providing truthful information."</p>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field">
        <label class="field-label">Applicant Signature (Type Full Name) <span class="req">*</span></label>
        <div class="input-wrap"><input v-model="form.signature" placeholder="Type your full name" required class="signature-input" /></div>
      </div>
      <div class="field">
        <label class="field-label">Date</label>
        <div class="input-wrap"><input :value="form.signature_date" type="date" readonly class="readonly-date" /></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
const props = defineProps({ form: { type: Object, required: true } })
onMounted(() => {
  props.form.signature_date = new Date().toISOString().split('T')[0]
})
</script>

<style scoped>
.certification-box {
  background: #f0f9ff;
  border: 1px solid #bae6fd;
  border-left: 4px solid hsl(199, 89%, 48%);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin-bottom: 1.25rem;
}
.certification-box p {
  font-size: 0.82rem;
  color: #374151;
  line-height: 1.6;
  font-style: italic;
}
.signature-input {
  font-family: 'Segoe Script', 'Dancing Script', cursive, serif !important;
  font-size: 1.1rem !important;
}
.readonly-date {
  background: #f3f4f6 !important;
  color: #6b7280 !important;
  cursor: not-allowed !important;
}
</style>
