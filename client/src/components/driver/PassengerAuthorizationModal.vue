<template>
  <Teleport to="body">
    <div v-if="show" class="pam-overlay">
      <div class="pam-screen" role="dialog" aria-modal="true" :aria-labelledby="ids.title" data-testid="pa-modal">
        <div class="pam-header">
          <div :id="ids.title" class="pam-title">Passenger authorization</div>
          <button type="button" class="pam-close" aria-label="Close" data-testid="pa-close" :disabled="state.submitting" @click="emit('close')">&times;</button>
        </div>

        <div v-if="state.sent" class="pam-body pam-done" data-testid="pa-sent">
          <div class="pam-done-icon" aria-hidden="true">&#10003;</div>
          <div class="pam-done-title">Sent to LogisX for signature.</div>
          <p class="pam-done-text">Not valid until the company signs. You'll get a notice when it does.</p>
          <p v-if="state.sent.reference" class="pam-done-ref">Reference {{ state.sent.reference }}</p>
          <button type="button" class="pam-btn pam-primary" @click="emit('close')">Done</button>
        </div>

        <template v-else>
          <div class="pam-body">
            <section class="pam-section">
              <h3 class="pam-h">1. Read the form together</h3>
              <p class="pam-p">
                The passenger (or, for anyone under 18, a parent or legal guardian) and you sign this form on this phone.
                It is not valid until LogisX Inc. signs it.
              </p>
              <div class="pam-pdf"><iframe :src="FORM_PDF_URL" title="Passenger authorization form" class="pam-pdf-frame"></iframe></div>
              <a :href="FORM_PDF_URL" target="_blank" rel="noopener" class="pam-link">Open the form</a>
            </section>

            <section class="pam-section">
              <h3 class="pam-h">2. Passenger and trip</h3>
              <fieldset class="pam-fields" :disabled="controls.detailsLocked">
                <label class="pam-label" :for="ids.name">Passenger's full name</label>
                <input :id="ids.name" v-model="state.passengerName" class="pam-input" type="text" :maxlength="LIMITS.NAME_MAX" autocomplete="off" data-testid="pa-passenger-name" />

                <div :id="ids.age" class="pam-label">Is the passenger 18 or older?</div>
                <div class="pam-radios" role="radiogroup" :aria-labelledby="ids.age">
                  <label class="pam-radio"><input v-model="state.passengerAdult" type="radio" :name="ids.age" :value="true" data-testid="pa-adult-yes" /> Yes</label>
                  <label class="pam-radio"><input v-model="state.passengerAdult" type="radio" :name="ids.age" :value="false" data-testid="pa-adult-no" /> No</label>
                </div>

                <template v-if="state.passengerAdult === false">
                  <label class="pam-label" :for="ids.guardian">Parent or legal guardian's full name</label>
                  <input :id="ids.guardian" v-model="state.guardianName" class="pam-input" type="text" :maxlength="LIMITS.NAME_MAX" autocomplete="off" />
                  <label class="pam-label" :for="ids.relationship">Their relationship to the passenger</label>
                  <input :id="ids.relationship" v-model="state.guardianRelationship" class="pam-input" type="text" :maxlength="LIMITS.RELATIONSHIP_MAX" placeholder="Parent, legal guardian" autocomplete="off" />
                  <label class="pam-check">
                    <input v-model="state.minorAttested" type="checkbox" />
                    <span>The passenger is older than 10 and fits the seat and seat belt as described in Part 3.</span>
                  </label>
                </template>

                <label class="pam-label" :for="ids.truck">Truck unit number</label>
                <input :id="ids.truck" v-model="state.truckUnit" class="pam-input" type="text" :maxlength="LIMITS.TRUCK_UNIT_MAX" autocomplete="off" />

                <label class="pam-label" :for="ids.start">Trip starts at</label>
                <input :id="ids.start" v-model="state.tripStart" class="pam-input" type="text" :maxlength="LIMITS.TRIP_POINT_MAX" placeholder="City, state" autocomplete="off" />
                <label class="pam-label" :for="ids.end">Trip ends at</label>
                <input :id="ids.end" v-model="state.tripEnd" class="pam-input" type="text" :maxlength="LIMITS.TRIP_POINT_MAX" placeholder="City, state" autocomplete="off" />

                <div class="pam-dates">
                  <div class="pam-date">
                    <label class="pam-label" :for="ids.from">Valid from</label>
                    <input :id="ids.from" v-model="state.validFrom" class="pam-input" type="date" :min="bounds.validFromMin" :max="bounds.validFromMax" />
                  </div>
                  <div class="pam-date">
                    <label class="pam-label" :for="ids.until">Expires on</label>
                    <input :id="ids.until" v-model="state.expiresOn" class="pam-input" type="date" :min="bounds.expiresMin" :max="bounds.expiresMax" />
                  </div>
                </div>
              </fieldset>
              <button v-if="controls.changeDetails" type="button" class="pam-btn pam-ghost" data-testid="pa-change" @click="changeDetails">Change details (clears both signatures)</button>
            </section>

            <section class="pam-section">
              <h3 class="pam-h">3. What the form will say</h3>
              <dl class="pam-summary">
                <template v-for="line in summary" :key="line.label">
                  <dt>{{ line.label }}</dt>
                  <dd>{{ line.value || '—' }}</dd>
                </template>
              </dl>
              <p v-if="!details.ok" class="pam-note" role="status" data-testid="pa-missing">{{ details.error }}</p>
            </section>

            <section class="pam-section">
              <h3 class="pam-h">4. {{ state.passengerAdult === false ? 'The parent or guardian signs' : 'The passenger signs' }}</h3>
              <p v-if="signer" class="pam-p">Hand the phone to {{ signer }}.</p>
              <label class="pam-check">
                <input v-model="state.passengerAgreed" type="checkbox" :disabled="!controls.passengerConsent" data-testid="pa-passenger-consent" />
                <span>{{ SIGNING_CONSENT_TEXT }}</span>
              </label>
              <SignaturePad
                ref="passengerPad"
                :label="signer ? `Signature of ${signer}` : 'Signature'"
                :disabled="!controls.passengerPad"
                @change="passengerPadChanged"
              />
            </section>

            <section class="pam-section">
              <h3 class="pam-h">5. You sign</h3>
              <p class="pam-p">After the passenger's side is signed. Signing as {{ driverName }}.</p>
              <label class="pam-check">
                <input v-model="state.driverAgreed" type="checkbox" :disabled="!controls.driverConsent" data-testid="pa-driver-consent" />
                <span>{{ SIGNING_CONSENT_TEXT }}</span>
              </label>
              <SignaturePad
                ref="driverPad"
                label="Your signature"
                :disabled="!controls.driverPad"
                @change="(v) => { state.driverSigned = v }"
              />
            </section>
          </div>

          <div class="pam-footer">
            <p v-if="state.error" class="pam-error" role="alert" data-testid="pa-error">{{ state.error }}</p>
            <p v-else-if="!state.requestId" class="pam-error" role="alert">{{ MESSAGES.NO_REQUEST_ID }}</p>
            <p v-if="state.pending" class="pam-note pam-pending" role="status" data-testid="pa-pending">{{ MESSAGES.PENDING }}</p>
            <button type="button" class="pam-btn pam-primary pam-submit" :disabled="!ready" data-testid="pa-submit" @click="submit">
              {{ controls.submitLabel }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, ref, useId, watch } from 'vue'
import SignaturePad from '../shared/SignaturePad.vue'
import { useApi } from '../../composables/useApi'
import { SIGNING_CONSENT_TEXT } from '../../lib/signingConsent'
import { appToday } from '../../utils/datetime'
import {
  FORM_PDF_URL, LIMITS, LIST_URL, MESSAGES, SUBMIT_TIMEOUT_MS, blankState, buildSubmission, canSubmit, checkDetails,
  createdView, dateBounds, formControls, newRequestId, signerName, submitFailure, summaryLines,
} from '../../lib/passengerAuthorization'

const props = defineProps({
  show: { type: Boolean, default: false },
  driverName: { type: String, default: '' },
  truckUnit: { type: String, default: '' },
})
const emit = defineEmits(['close', 'submitted'])

const api = useApi()
const uid = useId()
const ids = Object.freeze(Object.fromEntries(['title', 'name', 'age', 'guardian', 'relationship', 'truck', 'start', 'end', 'from', 'until'].map((k) => [k, `${uid}-${k}`])))

// Template refs only; the pads live inside the v-if, so each opening gets new ones.
const passengerPad = ref(null)
const driverPad = ref(null)

// One object holds everything typed, ticked and answered, and the instance outlives
// each opening, so it is replaced on both edges of `show`: a new opening starts
// blank with a new request id, and a closed one holds no passenger's name.
const state = ref(blankState())
const today = ref('')
watch(() => props.show, (open) => {
  today.value = open ? appToday() : ''
  state.value = open ? blankState({ requestId: newRequestId(), today: today.value, truckUnit: props.truckUnit }) : blankState()
}, { immediate: true })

const details = computed(() => checkDetails(state.value, today.value))
const bounds = computed(() => dateBounds(today.value, state.value.validFrom))
const summary = computed(() => summaryLines(state.value, props.driverName))
const signer = computed(() => signerName(state.value))
// Which fields, boxes and pads may move: locked once signed, frozen while sent or unanswered.
const controls = computed(() => formControls(state.value, today.value))
const ready = computed(() => canSubmit(state.value, today.value))

// The driver signs last: a passenger's signature cleared and drawn again takes the
// driver's with it.
function passengerPadChanged(drawn) {
  state.value.passengerSigned = drawn
  if (drawn) return
  driverPad.value?.reset()
  Object.assign(state.value, { driverAgreed: false, driverSigned: false })
}

function changeDetails() {
  passengerPad.value?.reset()
  driverPad.value?.reset()
  Object.assign(state.value, { passengerAgreed: false, passengerSigned: false, driverAgreed: false, driverSigned: false, error: '' })
}

async function submit() {
  // Pinned before the first await: a reply that lands after a close writes to the
  // object it belongs to, never to the next opening's form.
  const s = state.value
  if (!canSubmit(s, today.value)) return
  const body = buildSubmission(s, { passenger: passengerPad.value?.toDataURL() ?? null, driver: driverPad.value?.toDataURL() ?? null })
  if (!body) return
  s.submitting = true
  s.error = ''
  try {
    const answer = await api.post(LIST_URL, body, { timeout: SUBMIT_TIMEOUT_MS })
    s.sent = createdView(answer) || { reference: '' }
    emit('submitted')
  } catch (err) {
    const failure = submitFailure(err)
    s.error = failure.text
    if (failure.lost) s.pending = true
  } finally {
    s.submitting = false
  }
}
</script>

<style scoped>
.pam-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); z-index: 999;
  display: flex; align-items: center; justify-content: center;
}
/* The overlay's size is the part of the window a phone shows; the safe-area padding
   keeps the close (x) clear of the notch and Submit clear of the home bar. */
.pam-screen {
  background: #fff; width: 100%; height: 100%; max-width: 760px; box-sizing: border-box;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  display: flex; flex-direction: column;
}
.pam-header {
  display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
  padding: 0.5rem 1rem; border-bottom: 1px solid #e8edf2;
}
.pam-title { font-weight: 700; font-size: 1.05rem; color: #0f172a; }
.pam-close {
  width: 44px; height: 44px; font-size: 1.6rem; background: none; border: none; cursor: pointer;
  color: #6b7085; display: flex; align-items: center; justify-content: center; border-radius: 8px;
}
.pam-close:disabled { opacity: 0.35; cursor: not-allowed; }
/* Only the body scrolls, so the close and Submit stay on screen at any height; a
   swipe past its end never scrolls the page behind. */
.pam-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0.75rem 1rem 1rem; -webkit-overflow-scrolling: touch; }
.pam-section { padding: 0.75rem 0; border-bottom: 1px solid #eef1f5; display: flex; flex-direction: column; gap: 0.5rem; }
.pam-section:last-child { border-bottom: none; }
.pam-h { margin: 0; font-size: 0.95rem; font-weight: 700; color: #0f172a; }
.pam-p { margin: 0; font-size: 0.85rem; color: #475569; line-height: 1.45; }
.pam-pdf { height: 45vh; height: 45dvh; min-height: 220px; background: #f5f5f5; border: 1px solid #e8edf2; border-radius: 8px; overflow: hidden; }
.pam-pdf-frame { width: 100%; height: 100%; border: none; }
.pam-link { align-self: flex-start; display: inline-flex; align-items: center; min-height: 44px; font-size: 0.85rem; font-weight: 600; color: #0369a1; }
.pam-fields { border: none; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.pam-fields:disabled { opacity: 0.7; }
.pam-label { font-size: 0.8rem; font-weight: 600; color: #475569; margin-top: 0.4rem; }
/* 16 px stops iOS zooming the page on focus. */
.pam-input {
  width: 100%; box-sizing: border-box; min-height: 44px; padding: 0.5rem 0.7rem; font-size: 1rem; font-family: inherit;
  border: 1px solid #d5dae3; border-radius: 8px; background: #fff; color: #0f172a;
}
.pam-radios { display: flex; gap: 1.25rem; }
.pam-radio, .pam-check { display: flex; align-items: flex-start; gap: 0.5rem; min-height: 44px; font-size: 0.88rem; color: #334155; cursor: pointer; }
.pam-radio { align-items: center; }
.pam-radio input, .pam-check input { width: 20px; height: 20px; margin: 0.1rem 0 0; flex-shrink: 0; }
.pam-dates { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.pam-date { flex: 1 1 140px; display: flex; flex-direction: column; gap: 0.35rem; }
.pam-summary { margin: 0; display: grid; grid-template-columns: minmax(110px, 40%) 1fr; gap: 0.3rem 0.75rem; font-size: 0.85rem; }
.pam-summary dt { color: #64748b; }
.pam-summary dd { margin: 0; color: #0f172a; font-weight: 600; overflow-wrap: anywhere; }
.pam-note { margin: 0; font-size: 0.82rem; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 0.5rem 0.65rem; }
.pam-footer { flex-shrink: 0; padding: 0.6rem 1rem 0.75rem; border-top: 1px solid #e8edf2; background: #fff; }
.pam-error { margin: 0 0 0.5rem; font-size: 0.82rem; color: #b91c1c; }
.pam-pending { margin: 0 0 0.5rem; }
.pam-btn {
  min-height: 44px; padding: 0.6rem 1rem; border-radius: 10px; font-family: inherit; font-size: 0.9rem; font-weight: 700; cursor: pointer;
}
.pam-primary { background: #0f2847; color: #fff; border: none; }
.pam-primary:disabled { opacity: 0.35; cursor: not-allowed; }
.pam-ghost { align-self: flex-start; background: transparent; color: #0369a1; border: 1px solid #bae6fd; font-weight: 600; }
.pam-submit { width: 100%; }
.pam-done { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; text-align: center; padding: 2rem 1.25rem; }
.pam-done-icon {
  width: 56px; height: 56px; border-radius: 50%; background: #dcfce7; color: #16a34a;
  display: flex; align-items: center; justify-content: center; font-size: 1.6rem; font-weight: 700;
}
.pam-done-title { font-size: 1.1rem; font-weight: 700; color: #0f172a; }
.pam-done-text, .pam-done-ref { margin: 0; font-size: 0.88rem; color: #475569; }
</style>
