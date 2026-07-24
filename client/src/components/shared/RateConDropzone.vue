<template>
  <!-- Drag handlers live on the WRAPPER, never on the inner <button>: a disabled
       button stops firing events, the drop would bubble to the document, and the
       browser would happily navigate away from the SPA to render the PDF. The
       wrapper always preventDefault()s, busy or not. -->
  <div
    class="rc-dz"
    :class="{ 'rc-dz-compact': compact }"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <button
      type="button"
      class="rc-zone"
      :class="{ 'is-over': dragActive, 'is-busy': busy }"
      :disabled="busy || disabled"
      :aria-busy="busy"
      @click="openPicker"
    >
      <span v-if="busy" class="rc-spinner" aria-hidden="true"></span>
      <svg v-else class="rc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="12" y1="18" x2="12" y2="12" />
        <polyline points="9 15 12 12 15 15" />
      </svg>
      <span class="rc-copy">
        <span class="rc-title">
          <template v-if="busy">Reading rate-con&hellip;</template>
          <template v-else-if="dragActive">Drop to read this rate-con</template>
          <template v-else>{{ label }}</template>
        </span>
        <span class="rc-hint">
          <template v-if="busy">{{ busyFileName }} &middot; this takes a few seconds</template>
          <template v-else>{{ hintText }}</template>
        </span>
      </span>
    </button>

    <input
      ref="inputRef"
      type="file"
      accept="application/pdf,.pdf"
      class="rc-file"
      tabindex="-1"
      aria-hidden="true"
      @change="onPicked"
    />

    <p v-if="notice" class="rc-msg rc-msg-note" aria-live="polite">{{ notice }}</p>
    <p v-if="error" class="rc-msg rc-msg-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="rc-msg-dismiss" @click="error = ''">Dismiss</button>
    </p>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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

// Server caps the upload around 15 MB; reject client-side so a 40 MB scan
// doesn't spend a minute uploading only to come back a 400.
const MAX_PDF_BYTES = 15 * 1024 * 1024
// Gemini reads the whole PDF: 2 retries x 15s server-side timeout plus backoff.
// The 20s useApi default would abort a request that was going to succeed.
const EXTRACT_TIMEOUT_MS = 90000

const inputRef = ref(null)
const busy = ref(false)
const busyFileName = ref('')
const error = ref('')
const notice = ref('')
// dragenter/dragleave also fire when the pointer crosses child elements, so
// track depth instead of toggling a boolean (otherwise the highlight flickers).
const dragDepth = ref(0)
const dragActive = computed(() => dragDepth.value > 0 && !busy.value && !props.disabled)

const hintText = computed(() => {
  if (props.hint) return props.hint
  return props.compact
    ? 'or click to browse — you review everything before the load is created'
    : 'or click to browse. We read the PDF and prefill the form below — nothing is created until you say so.'
})

// Missing the zone by a few pixels must not cost the dispatcher their page:
// the browser's default action for a file drop anywhere on the document is to
// navigate to that file, which would tear down the SPA (unsaved form state and
// all). While a dropzone is on screen, swallow file drops everywhere else.
// Our own handlers run first (target phase), so this only catches the misses.
function blockStrayFileDrop(e) {
  const types = e.dataTransfer && Array.from(e.dataTransfer.types || [])
  if (!types || !types.includes('Files')) return // leave text/link drags alone
  e.preventDefault()
}
onMounted(() => {
  window.addEventListener('dragover', blockStrayFileDrop)
  window.addEventListener('drop', blockStrayFileDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener('dragover', blockStrayFileDrop)
  window.removeEventListener('drop', blockStrayFileDrop)
})

function openPicker() {
  if (busy.value || props.disabled) return
  inputRef.value?.click()
}

function onDragEnter() {
  dragDepth.value++
}
function onDragOver(e) {
  // Required every frame, not just on enter, or the drop is never allowed.
  if (e.dataTransfer) e.dataTransfer.dropEffect = busy.value || props.disabled ? 'none' : 'copy'
}
function onDragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

function onDrop(e) {
  dragDepth.value = 0
  if (busy.value) {
    notice.value = 'Still reading the last rate-con — wait for it to finish.'
    return
  }
  if (props.disabled) return
  const files = Array.from(e.dataTransfer?.files || [])
  handleFiles(files)
}

function onPicked(e) {
  const files = Array.from(e.target.files || [])
  // Allow re-picking the same file after an error.
  if (inputRef.value) inputRef.value.value = ''
  handleFiles(files)
}

function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
}

function handleFiles(files) {
  error.value = ''
  notice.value = ''
  if (!files.length) return

  // One file per drop. Bulk rate-con ingestion is a deliberate follow-up — say
  // so plainly rather than silently ignoring the rest.
  const file = files[0]
  if (files.length > 1) {
    notice.value = `${files.length} files dropped — only "${file.name}" was read. Drop one rate-con at a time.`
  }

  if (!isPdf(file)) {
    error.value = `"${file.name}" isn't a PDF. Rate-cons must be dropped as a PDF file.`
    return
  }
  if (file.size > MAX_PDF_BYTES) {
    error.value = `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 15 MB. Try re-saving or splitting the PDF.`
    return
  }
  extract(file)
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

.rc-zone {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  text-align: left;
  font-family: inherit;
  padding: 1.25rem 1.1rem;
  border: 1.5px dashed var(--border, #e2e4ea);
  border-radius: var(--radius, 10px);
  background: var(--surface, #fff);
  color: var(--text, #1a1d27);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.rc-zone:hover:not(:disabled) {
  border-color: var(--accent, #38bdf8);
  background: var(--accent-dim, rgba(56, 189, 248, 0.1));
}
.rc-zone:focus-visible {
  outline: 2px solid var(--accent, #38bdf8);
  outline-offset: 2px;
}
.rc-zone.is-over {
  border-color: var(--accent, #38bdf8);
  border-style: solid;
  background: var(--accent-dim, rgba(56, 189, 248, 0.1));
}
.rc-zone:disabled { cursor: default; }
.rc-zone.is-busy {
  border-style: solid;
  border-color: var(--accent, #38bdf8);
  background: var(--accent-dim, rgba(56, 189, 248, 0.1));
  opacity: 1;
}

.rc-dz-compact .rc-zone { padding: 0.6rem 0.85rem; gap: 0.6rem; }

.rc-icon {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  color: var(--accent, #38bdf8);
}
.rc-dz-compact .rc-icon { width: 20px; height: 20px; }

.rc-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.rc-title {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
}
.rc-hint {
  font-size: 0.75rem;
  color: var(--text-dim, #6b7085);
  line-height: 1.35;
}
.rc-dz-compact .rc-title { font-size: 0.8125rem; }
.rc-dz-compact .rc-hint { font-size: 0.7rem; }

.rc-spinner {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border: 2px solid var(--accent-dim, rgba(56, 189, 248, 0.25));
  border-top-color: var(--accent, #38bdf8);
  border-radius: 50%;
  animation: rc-spin 0.7s linear infinite;
}
@keyframes rc-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .rc-spinner { animation-duration: 2s; }
}

/* Off-screen rather than display:none so assistive tech and programmatic
   .click() both behave predictably across browsers. */
.rc-file {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
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

@media (max-width: 640px) {
  .rc-zone { padding: 0.85rem 0.75rem; }
  .rc-dz-compact .rc-zone { padding: 0.55rem 0.7rem; }
}
</style>
