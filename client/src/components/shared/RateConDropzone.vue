<template>
  <div class="rc-dz">
    <!-- All drag mechanics, the window-level stray-drop guard, and type/size
         validation now live in FileDropZone → useFileDrop. This component is
         only the rate-con POLICY: what to call, how long to wait, and what each
         failure means to a dispatcher.

         showErrors is false because we surface validation and extraction
         failures through ONE message area below — stacking the zone's own error
         under an extraction error reads as two separate things going wrong. -->
    <FileDropZone
      accept="application/pdf,.pdf"
      :max-size-mb="15"
      :compact="compact"
      :disabled="disabled"
      :busy="busy"
      :show-errors="false"
      :label="label"
      :hint="hintText"
      drop-label="Drop to read this rate-con"
      busy-label="Reading rate-con…"
      :busy-hint="`${busyFileName} · this takes a few seconds`"
      @files="onFiles"
      @reject="onReject"
    />

    <p v-if="notice" class="rc-msg rc-msg-note" aria-live="polite">{{ notice }}</p>
    <p v-if="error" class="rc-msg rc-msg-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="rc-msg-dismiss" @click="error = ''">Dismiss</button>
    </p>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import FileDropZone from './FileDropZone.vue'
import { useApi } from '../../composables/useApi'
import { readFileAsDataURL } from '../../lib/imageUtils'

const props = defineProps({
  // Compact = a slim strip that sits inline above a dashboard table.
  // Full (default) = a taller banner for the top of a form.
  compact: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: 'Drop a rate-con PDF here' },
  // Blank falls back to a variant-appropriate default (see hintText).
  hint: { type: String, default: '' },
})

// Deliberately positional so the review modal / form can be wired in one line.
const emit = defineEmits(['extracted'])

const api = useApi()

// Gemini reads the whole PDF: 2 retries x 15s server-side timeout plus backoff.
// The 20s useApi default would abort a request that was going to succeed.
const EXTRACT_TIMEOUT_MS = 90000

const busy = ref(false)
const busyFileName = ref('')
const error = ref('')
const notice = ref('')

const hintText = computed(() => {
  if (props.hint) return props.hint
  return props.compact
    ? 'or click to browse — you review everything before the load is created'
    : 'or click to browse. We read the PDF and prefill the form below — nothing is created until you say so.'
})

function onFiles(files) {
  error.value = ''
  notice.value = ''
  extract(files[0])
}

// One file per drop. Bulk rate-con ingestion is a deliberate follow-up, so an
// extra file is a NOTICE (we did something, just not everything) rather than an
// error — while a wrong type or an oversize PDF really is a failure.
function onReject(rejections) {
  const overflow = rejections.filter((r) => r.reason === 'count')
  const real = rejections.filter((r) => r.reason !== 'count')
  if (overflow.length) {
    notice.value = `Only the first PDF was read — drop one rate-con at a time.`
  }
  if (real.length) error.value = real[0].message
}

async function extract(file) {
  busy.value = true
  busyFileName.value = file.name || 'rate-con.pdf'
  try {
    const dataUrl = await readFileAsDataURL(file)
    if (!dataUrl) {
      error.value = "Couldn't read that file off disk. Try dropping it again."
      return
    }
    const pdfBase64 = String(dataUrl).replace(/^data:[^;]*;base64,/, '')
    const res = await api.post(
      '/api/loads/ratecon/extract',
      { pdfBase64, fileName: busyFileName.value },
      { timeout: EXTRACT_TIMEOUT_MS },
    )
    emit('extracted', res.fields || {}, res.warnings || [], pdfBase64, busyFileName.value)
  } catch (err) {
    error.value = messageFor(err)
  } finally {
    busy.value = false
    busyFileName.value = ''
  }
}

// Every failure mode ends in an instruction, because the fallback (type the
// load by hand in /jobs/new) is always available and dispatchers need to know
// when to stop retrying and just do that.
function messageFor(err) {
  const status = err?.status
  if (status === 503) return 'Rate-con reading is switched off on the server. Enter this load manually for now.'
  if (status === 429) return 'Too many rate-cons read in the last few minutes. Wait a bit, then try again.'
  if (status === 403) return "Your account can't read rate-cons. Ask a Super Admin."
  if (status === 400) return err.message || 'That file was rejected — it must be a PDF under 15 MB.'
  if (status === 502) return err.message || "Couldn't read that rate-con. Try a clearer PDF, or enter the load manually."
  if (status === 0) return err.code === 'ABORT' ? 'Cancelled.' : 'Reading the rate-con timed out. Try again, or enter the load manually.'
  return err?.message || 'Failed to read the rate-con.'
}
</script>

<style scoped>
.rc-dz {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.rc-msg {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
  padding: 0.5rem 0.7rem;
  font-size: 0.75rem;
  line-height: 1.4;
  border-radius: 6px;
}
.rc-msg-note {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}
.rc-msg-error {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  justify-content: space-between;
}
.rc-msg-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 700;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
</style>
