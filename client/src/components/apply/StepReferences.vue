<template>
  <div class="step-section">
    <div class="section-header">
      <h3>References &amp; Signature</h3>
      <p>Provide 3 professional references and sign your application</p>
    </div>

    <!-- 3 References -->
    <div v-for="(ref, i) in form.references" :key="i" class="reference-block">
      <label class="field-label ref-title">Reference {{ i + 1 }} <span class="req">*</span></label>
      <div class="grid grid-cols-2 gap-3">
        <div class="field"><label class="field-label">Company</label><div class="input-wrap"><input v-model="ref.name" placeholder="Company name" /></div></div>
        <div class="field"><label class="field-label">Phone Number</label><div class="input-wrap"><input v-model="ref.phone" type="tel" placeholder="Phone number" /></div></div>
        <div class="field"><label class="field-label">Email</label><div class="input-wrap"><input v-model="ref.relationship" type="email" placeholder="Email address" /></div></div>
        <div class="field"><label class="field-label">Contact Person</label><div class="input-wrap"><input v-model="ref.contactPerson" placeholder="Contact person name" /></div></div>
      </div>
    </div>

    <div class="field">
      <label class="field-label">Is there anything else you would like for us to know?</label>
      <div class="input-wrap"><textarea v-model="form.additional_info" rows="3" placeholder="Any additional information..."></textarea></div>
    </div>

    <!-- Policy Documents -->
    <div class="policy-section">
      <h4 class="policy-title">Company Policies &amp; Documents</h4>
      <p class="policy-desc">Please review the following documents before signing your application.</p>
      <div class="policy-cards">
        <a href="/policies/LogisX-Mobile-Policy.pdf" target="_blank" class="policy-card">
          <div class="policy-icon">&#128241;</div>
          <div class="policy-info">
            <div class="policy-name">LogisX Inc. Mobile Policy</div>
            <div class="policy-meta">PDF &middot; View &amp; review</div>
          </div>
          <div class="policy-action">&#128065;</div>
        </a>
        <a href="/policies/LogisX-Substance-Policy.pdf" target="_blank" class="policy-card">
          <div class="policy-icon">&#128203;</div>
          <div class="policy-info">
            <div class="policy-name">LogisX Substance Policy and Procedure</div>
            <div class="policy-meta">PDF &middot; View &amp; review</div>
          </div>
          <div class="policy-action">&#128065;</div>
        </a>
      </div>
    </div>

    <!-- Applicant Signature -->
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
.reference-block {
  margin-bottom: 1rem;
  padding: 1rem;
  background: #f8fafc;
  border: 1px solid #e8edf2;
  border-radius: 10px;
}
.ref-title {
  margin-bottom: 0.5rem !important;
  font-size: 0.85rem !important;
}
.policy-section {
  margin-bottom: 1.5rem;
  padding: 1.25rem;
  background: #f8fafc;
  border: 1px solid #e8edf2;
  border-radius: 12px;
}
.policy-title { font-size: 0.88rem; font-weight: 700; color: #111827; margin-bottom: 0.25rem; }
.policy-desc { font-size: 0.78rem; color: #9ca3af; margin-bottom: 1rem; }
.policy-cards { display: flex; flex-direction: column; gap: 0.65rem; }
.policy-card {
  display: flex; align-items: center; gap: 0.85rem;
  padding: 0.85rem 1rem; border: 1.5px solid #e2e4ea; border-radius: 10px;
  background: white; text-decoration: none; color: inherit; transition: all 0.15s;
}
.policy-card:hover { border-color: hsl(199, 89%, 48%); box-shadow: 0 2px 8px rgba(56, 189, 248, 0.1); transform: translateY(-1px); }
.policy-icon { font-size: 1.5rem; flex-shrink: 0; }
.policy-info { flex: 1; min-width: 0; }
.policy-name { font-size: 0.85rem; font-weight: 600; color: #111827; }
.policy-meta { font-size: 0.72rem; color: #9ca3af; margin-top: 0.1rem; }
.policy-action { font-size: 1.1rem; color: hsl(199, 89%, 48%); flex-shrink: 0; }
.certification-box {
  background: #f0f9ff; border: 1px solid #bae6fd; border-left: 4px solid hsl(199, 89%, 48%);
  border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.25rem;
}
.certification-box p { font-size: 0.82rem; color: #374151; line-height: 1.6; font-style: italic; }
.signature-input { font-family: 'Segoe Script', 'Dancing Script', cursive, serif !important; font-size: 1.1rem !important; }
.readonly-date { background: #f3f4f6 !important; color: #6b7280 !important; cursor: not-allowed !important; }
.grid-cols-2 { grid-template-columns: 1fr 1fr; }
.grid-cols-3 { grid-template-columns: 1fr 1fr 1fr; }
@media (max-width: 640px) { .grid-cols-2, .grid-cols-3 { grid-template-columns: 1fr; } }
</style>
