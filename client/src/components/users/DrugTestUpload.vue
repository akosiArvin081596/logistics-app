<template>
  <div v-if="show" class="drug-test-overlay" @click.self="$emit('close')">
    <div class="drug-test-modal">
      <div class="modal-header">
        <h3>Upload Drug Test — {{ driverName }}</h3>
        <button class="close-btn" @click="$emit('close')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Result</label>
          <select v-model="state.result" class="form-select">
            <option value="">Select result...</option>
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
          </select>
        </div>
        <div class="form-group">
          <label>Upload Document</label>
          <!-- Extension-only accept, unchanged from the input it replaces: it is
               what the server names the file from, and .webp stays out because
               it was never in. On a drop the attribute is decorative, so this
               list is now enforced by the shared validator instead.

               `:key` is the wrong-driver guard for the state this component does
               NOT own. The zone keeps its own rejection text (which NAMES the
               chosen file), its drag depth and its <input type="file"> element
               inside useFileDrop, and none of it is reachable from out here. A
               fresh token per open (see blankState) rebuilds the zone, so the
               previous driver's filename can never be on screen under this
               driver's name — including if this overlay is ever changed from
               `v-if` to `v-show`, which is the change that would otherwise
               quietly re-open the hole. -->
          <FileDropZone
            :key="state.token"
            accept=".pdf,.jpg,.jpeg,.png"
            :max-size-mb="10"
            :disabled="state.uploading"
            :label="state.fileName || 'Drop the drug test result'"
            @files="handleFile"
          />
        </div>
        <button
          class="submit-btn"
          :disabled="!state.result || state.uploading"
          @click="handleSubmit"
        >
          {{ state.uploading ? 'Uploading...' : 'Upload Result' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'
import FileDropZone from '../shared/FileDropZone.vue'
import { readFileAsDataURL } from '../../lib/imageUtils'

const props = defineProps({
  show: { type: Boolean, default: false },
  userId: { type: Number, default: 0 },
  driverName: { type: String, default: '' },
})
// `uploaded` carries the user id the result was actually filed against, because
// the POST can land after the admin has moved on to the next driver. The parent
// is the only place that knows who is on screen now, so it — not this component
// — decides whether that completion should close the modal. Deliberately no
// `close` on the success path for the same reason: a stale instance emitting it
// would shut a DIFFERENT driver's half-filled form.
const emit = defineEmits(['close', 'uploaded'])

const api = useApi()
const { show: toast } = useToast()

// ─────────────────────────────────────────────────────────────────────────────
// ONE object holds every piece of state that must not survive one driver's modal
// into the next, and resetting it is ONE assignment. That is not tidiness. This
// component is a DOT compliance record: it was mounted unconditionally, only the
// overlay below was `v-if`'d, so `result` / `fileName` / `fileData` chosen for
// driver A were still armed when it reopened for driver B and Upload filed A's
// document against B's user id.
//
// Resetting by listing fields is what makes that recurrable — the next field
// somebody adds is the next field somebody forgets. A field added to
// blankState() is cleared for free, forever.
//
// This is not hypothetical, and the same defect was found in two more places the
// same day: DocumentSignModal.vue and InvestorSignModal.vue both reset by
// enumeration and both omitted `isDrawing`, so a cancelled pen stroke left the
// canvas armed and the NEXT signer's first pointer move drew a stray mark into
// someone else's signature on a legal document. Both now use this same factory
// shape. If you are adding a modal that a parent mounts unconditionally, copy
// the pattern here rather than enumerating.
//
// `token` is minted from the same counter that issues tickets to async work, so
// a single "is my ticket still the newest?" test answers both "was I superseded
// by a later pick?" and "was I superseded by a different driver?". It also keys
// <FileDropZone> so the zone's own retained state cannot cross a driver either.
let seq = 0

function blankState() {
  return {
    token: ++seq, // identity of this open; rotates the drop zone
    result: '', // 'pass' | 'fail'
    fileName: '', // shown on the zone — only ever set together with fileData
    fileData: '', // base64 of the document, data-URL prefix stripped
    uploading: false, // in-flight POST
  }
}

const state = ref(blankState())

// Belt and braces with the `v-if` at the call site (ApplicationsView). That
// v-if is the primary guarantee, because unmounting re-runs every initializer
// including ones added long after today; this watch keeps the component correct
// *on its own*, since mounting it unconditionally is exactly how the bug shipped
// and is exactly what a future call site may do again. Reset on BOTH edges: on
// open so nothing is inherited, and on close so a stranger's medical document is
// not left sitting in memory behind a modal nobody has open.
watch(() => props.show, () => {
  state.value = blankState()
})

// Receives an already-validated File[] from BOTH paths — the zone's click-to-
// browse and a drop on it. One file at a time (`multiple` is off on the zone).
async function handleFile(files) {
  // Take a ticket BEFORE the first await. Two quick picks are two concurrent
  // FileReader jobs and the slower one wins by default, so the file the admin
  // abandoned would overwrite the one they chose. blankState() draws from this
  // same counter, so a reset invalidates in-flight reads too — a read started
  // for driver A can never land in driver B's modal.
  const ticket = ++seq
  const s = state.value
  const file = files && files[0]

  // A files event carrying nothing must CLEAR, never `return`. Bailing out here
  // leaves the previous document armed under whatever name the form shows now —
  // the same wrong-driver failure at a smaller scale. Nothing has been awaited
  // yet, so this cannot be a superseded write.
  if (!file) {
    s.fileName = ''
    s.fileData = ''
    return
  }

  const dataUrl = await readFileAsDataURL(file)
  if (ticket !== seq) return // superseded while we were reading — drop it silently

  // readFileAsDataURL resolves '' on an unreadable file rather than rejecting,
  // and a data URL with no comma would split to `undefined`. Naming the file
  // without its bytes would let Upload run and file a drug test result with no
  // document attached, so the bytes are proven FIRST and the name is written
  // only once they are in hand — "a name is shown" and "we hold the document"
  // can never disagree.
  const base64 = dataUrl ? String(dataUrl).split(',')[1] : ''
  if (!base64) {
    s.fileName = ''
    s.fileData = ''
    toast(`Couldn't read "${file.name}". Try choosing it again.`, 'error')
    return
  }
  s.fileData = base64
  s.fileName = file.name
}

async function handleSubmit() {
  // Capture the state object this click belongs to. Every write below lands on
  // `s`, so if the modal is reset mid-upload the late completion writes to an
  // orphaned object and is structurally incapable of touching the driver now on
  // screen. The payload is read before the first await for the same reason.
  const s = state.value
  if (!s.result || s.uploading) return

  // Pin the target. The toast and the emit both run after the await, when the
  // props may already describe somebody else.
  const userId = props.userId
  const driverName = props.driverName

  // The call site's `|| 0` fallback means an applicant with no driver account
  // would POST to /api/onboarding/0/drug-test. Refuse rather than file a
  // compliance record against nobody.
  if (!userId) {
    toast('This applicant has no driver account yet — accept the application first.', 'error')
    return
  }

  s.uploading = true
  try {
    await api.post(`/api/onboarding/${userId}/drug-test`, {
      result: s.result,
      fileData: s.fileData || undefined,
      fileName: s.fileName || undefined,
    })
    // Name the driver. This toast can land over the NEXT driver's open form, and
    // a bare "Drug test uploaded: pass" there reads as confirmation for them.
    toast(`Drug test uploaded for ${driverName || 'driver'}: ${s.result}`, 'success')
    emit('uploaded', { userId })
  } catch (err) {
    toast(err.message || 'Upload failed', 'error')
  } finally {
    s.uploading = false
  }
}
</script>

<style scoped>
.drug-test-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
}
.drug-test-modal {
  background: white;
  border-radius: 14px;
  width: 400px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #e8edf2;
}
.modal-header h3 {
  font-size: 1rem;
  font-weight: 700;
  margin: 0;
}
.close-btn {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: #6b7280;
}
.modal-body {
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.form-group label {
  display: block;
  font-size: 0.82rem;
  font-weight: 600;
  color: #374151;
  margin-bottom: 0.3rem;
}
.form-select, .form-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid #e2e4ea;
  border-radius: 8px;
  font-size: 0.88rem;
}
.submit-btn {
  width: 100%;
  padding: 0.65rem;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 8px;
  font-weight: 700;
  font-size: 0.88rem;
  cursor: pointer;
}
.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
