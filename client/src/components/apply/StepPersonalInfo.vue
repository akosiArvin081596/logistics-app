<template>
  <div class="step-section">
    <div class="section-header">
      <h3>Personal Information</h3>
      <p>Please provide your basic details</p>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">First Name <span class="req">*</span></label><div class="input-wrap"><input v-model="form.first_name" placeholder="John" required /></div></div>
      <div class="field"><label class="field-label">Last Name <span class="req">*</span></label><div class="input-wrap"><input v-model="form.last_name" placeholder="Doe" required /></div></div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">Email Address <span class="req">*</span></label><div class="input-wrap"><input v-model="form.email" type="email" placeholder="you@email.com" required /></div></div>
      <div class="field"><label class="field-label">Phone Number <span class="req">*</span></label><div class="input-wrap"><input v-model="form.phone" type="tel" placeholder="(555) 555-5555" required /></div></div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">Cell Number</label><div class="input-wrap"><input v-model="form.cell" type="tel" placeholder="(555) 555-5555" /></div></div>
      <div class="field"><label class="field-label">Date of Birth <span class="req">*</span></label><div class="input-wrap"><input v-model="form.dob" type="date" required /></div></div>
    </div>
    <div class="field">
      <label class="field-label">Current Address <span class="req">*</span></label>
      <div class="address-row">
        <div class="address-input-wrap">
          <input ref="addressInput" v-model="form.address" placeholder="Start typing an address..." required autocomplete="off" />
          <button type="button" class="addr-action-btn" :disabled="geolocating" @click="useCurrentLocation" title="Use my current location">
            <svg v-if="!geolocating" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
            <span v-else class="spinner"></span>
          </button>
        </div>
        <button type="button" class="map-btn" @click="$emit('open-map')" title="Pick on map">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
        </button>
      </div>
      <p class="field-hint">Pick from autocomplete to auto-fill City, State and ZIP below.</p>
    </div>
    <div class="grid grid-cols-3 gap-4">
      <div class="field"><label class="field-label">City <span class="req">*</span></label><div class="input-wrap"><input v-model="form.city" placeholder="City" required /></div></div>
      <div class="field"><label class="field-label">State <span class="req">*</span></label><div class="input-wrap"><input v-model="form.state" placeholder="ST" maxlength="2" style="text-transform:uppercase" required /></div></div>
      <div class="field"><label class="field-label">ZIP <span class="req">*</span></label><div class="input-wrap"><input v-model="form.zip" placeholder="12345" required /></div></div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">Social Security Number (SSN) <span class="req">*</span></label><div class="input-wrap"><input v-model="form.ssn" placeholder="XXX-XX-XXXX" required /></div></div>
      <div class="field"><label class="field-label">Drivers License Number <span class="req">*</span></label><div class="input-wrap"><input v-model="form.drivers_license" placeholder="License number" required /></div></div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="field"><label class="field-label">DOT # <span class="opt">(optional)</span></label><div class="input-wrap"><input v-model="form.dot" placeholder="Only if Owner Operator" /></div></div>
      <div class="field"><label class="field-label">MC # <span class="opt">(optional)</span></label><div class="input-wrap"><input v-model="form.mc" placeholder="Only if Owner Operator" /></div></div>
    </div>
    <div class="field">
      <label class="field-label">Hazmat Endorsement <span class="req">*</span></label>
      <div class="radio-group">
        <label class="radio-item" v-for="opt in hazmatOpts" :key="opt"><input type="radio" v-model="form.hazmat" :value="opt" /><span>{{ opt }}</span></label>
      </div>
    </div>

    <!-- CDL + Medical Card Uploads -->
    <div class="upload-section">
      <label class="field-label">CDL &amp; Medical Card Uploads <span class="req">*</span></label>
      <p class="upload-hint">
        Upload clear photos or PDFs of your CDL (front and back) and medical card<span v-if="supportsDrag"> &mdash; drag a file onto a card, or click to browse</span>
      </p>
      <p class="upload-tip">Tip: for the clearest result, use a photo at least 800&times;500 pixels. Smaller images still work but may look blurry in the printed PDF.</p>
      <!-- Each card is its OWN useFileDrop instance. The chrome (thumbnail, PDF
           icon, low-res warning) is untouched — only the drag handlers and the
           click target changed. -->
      <div class="upload-grid">
        <div
          class="upload-card"
          :class="{ 'is-over': cdlFrontOver }"
          role="button"
          tabindex="0"
          aria-label="CDL Front — upload a photo or PDF"
          v-bind="cdlFrontZone"
          @click="openCdlFront"
          @keydown.enter.prevent="openCdlFront"
          @keydown.space.prevent="openCdlFront"
        >
          <input :ref="setCdlFrontInput" v-bind="cdlFrontInputProps" hidden />
          <template v-if="form.cdl_front">
            <img v-if="!fileTypes.cdl_front" :src="form.cdl_front" class="upload-preview" alt="CDL front preview" />
            <div v-else class="pdf-preview"><div class="pdf-icon">&#128196;</div><div class="upload-label">PDF uploaded</div></div>
          </template>
          <template v-else>
            <div class="upload-placeholder">&#128247; / &#128196;</div>
            <div class="upload-label">CDL Front</div>
            <div class="upload-formats">Image or PDF</div>
          </template>
        </div>
        <div
          class="upload-card"
          :class="{ 'is-over': cdlBackOver }"
          role="button"
          tabindex="0"
          aria-label="CDL Back — upload a photo or PDF"
          v-bind="cdlBackZone"
          @click="openCdlBack"
          @keydown.enter.prevent="openCdlBack"
          @keydown.space.prevent="openCdlBack"
        >
          <input :ref="setCdlBackInput" v-bind="cdlBackInputProps" hidden />
          <template v-if="form.cdl_back">
            <img v-if="!fileTypes.cdl_back" :src="form.cdl_back" class="upload-preview" alt="CDL back preview" />
            <div v-else class="pdf-preview"><div class="pdf-icon">&#128196;</div><div class="upload-label">PDF uploaded</div></div>
          </template>
          <template v-else>
            <div class="upload-placeholder">&#128247; / &#128196;</div>
            <div class="upload-label">CDL Back</div>
            <div class="upload-formats">Image or PDF</div>
          </template>
        </div>
        <div
          class="upload-card"
          :class="{ 'is-over': medicalOver }"
          role="button"
          tabindex="0"
          aria-label="Medical Card — upload a photo or PDF"
          v-bind="medicalZone"
          @click="openMedical"
          @keydown.enter.prevent="openMedical"
          @keydown.space.prevent="openMedical"
        >
          <input :ref="setMedicalInput" v-bind="medicalInputProps" hidden />
          <template v-if="form.medical_card">
            <img v-if="!fileTypes.medical_card" :src="form.medical_card" class="upload-preview" alt="Medical card preview" />
            <div v-else class="pdf-preview"><div class="pdf-icon">&#128196;</div><div class="upload-label">PDF uploaded</div></div>
          </template>
          <template v-else>
            <div class="upload-placeholder">&#128247; / &#128196;</div>
            <div class="upload-label">Medical Card</div>
            <div class="upload-formats">Image or PDF</div>
          </template>
        </div>
      </div>
      <template v-for="(msg, field) in uploadMessages" :key="field">
        <div v-if="msg" class="upload-warning">
          <span class="warning-dot">&#9888;</span> {{ uploadLabel(field) }}: {{ msg }}
        </div>
      </template>
    </div>

    <div class="field">
      <label class="field-label">Position Applying For <span class="req">*</span></label>
      <div class="radio-group">
        <label class="radio-item" v-for="opt in positions" :key="opt"><input type="radio" v-model="form.position" :value="opt" /><span>{{ opt }}</span></label>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useFileDrop } from '../../composables/useFileDrop'
import { compressImage, isDecodedImage, readFileAsDataURL } from '../../lib/imageUtils'

const props = defineProps({ form: { type: Object, required: true } })
const emit = defineEmits(['open-map'])
const positions = ['Company Driver', 'Owner Operator', 'Other']
const hazmatOpts = ['Yes', 'No']
const addressInput = ref(null)
const geolocating = ref(false)
const fileTypes = reactive({ cdl_front: false, cdl_back: false, medical_card: false })
// Inline, non-blocking warnings for low-resolution uploads.
// Populated by handleFiles() and rendered under the upload grid via uploadMessages.
const lowResWarnings = reactive({ cdl_front: '', cdl_back: '', medical_card: '' })
const UPLOAD_LABELS = { cdl_front: 'CDL Front', cdl_back: 'CDL Back', medical_card: 'Medical Card' }
function uploadLabel(field) { return UPLOAD_LABELS[field] || field }

function parseAddressComponents(components) {
  const out = { city: '', state: '', zip: '' }
  if (!Array.isArray(components)) return out
  for (const comp of components) {
    const types = comp.types || []
    if (!out.city && types.includes('locality')) out.city = comp.long_name || ''
    else if (!out.city && types.includes('sublocality')) out.city = comp.long_name || ''
    if (!out.state && types.includes('administrative_area_level_1')) out.state = comp.short_name || ''
    if (!out.zip && types.includes('postal_code')) out.zip = comp.long_name || ''
  }
  return out
}

async function useCurrentLocation() {
  if (!navigator.geolocation) return
  geolocating.value = true
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const res = await fetch(`/api/geocode?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`)
        if (res.ok) {
          const data = await res.json()
          const r = data.results?.[0]
          if (r?.formatted_address) props.form.address = r.formatted_address
          if (r?.address_components) {
            const c = parseAddressComponents(r.address_components)
            if (c.city) props.form.city = c.city
            if (c.state) props.form.state = c.state
            if (c.zip) props.form.zip = c.zip
          }
        }
      } catch { /* skip */ }
      geolocating.value = false
    },
    () => { geolocating.value = false },
    { timeout: 8000, enableHighAccuracy: false }
  )
}

// Minimum accepted resolution for CDL / Medical Card photos.
// Below this the document is unreadable when rendered at full size in the PDF.
const MIN_W = 800
const MIN_H = 500
// Cap final image at this dimension to keep the base64 payload reasonable
// (we still keep the native aspect ratio — no stretching).
const MAX_DIMENSION = 2400

// ⚠️ THIS LIST IS THE ONLY TYPE GATE ON A DROPPED FILE. The `accept` attribute
// filters the OS file dialog and nothing else; a drag-and-drop never goes near
// it. The two extension tokens carry the blank-MIME cases this form actually
// receives — an iPhone HEIC (every non-Safari browser leaves file.type empty)
// and a Windows PDF — which a MIME-only rule would refuse outright.
const UPLOAD_ACCEPT = 'image/*,.heic,.heif,.pdf'
// All three files ride in ONE application payload against a 50 MB server body
// limit. Images are downscaled before they are stored, but a PDF is kept raw
// and base64 inflates it ~1.37x, so the cap is really a PDF cap: 10 MB clears
// every phone photo and scanned licence we see and still leaves the worst case
// (three 10 MB PDFs) inside the limit.
const UPLOAD_MAX_MB = 10

// ───────────────────────────────────────────────────────────────────────────
// THREE separate instances, one per card — deliberately not one shared one.
// Each card needs its OWN `dragActive`, or dragging a file over CDL Front
// highlights all three. Three instances also means three retains of the
// refcounted stray-drop guard in useFileDrop and still exactly ONE window
// listener pair; that guard is what stops a drop that misses a card by ten
// pixels from navigating the browser to the file and taking a half-filled job
// application with it. This form has no draft persistence, so that loss is
// total — do NOT add window-level drag listeners here.
function uploadDrop(field) {
  return useFileDrop({
    accept: UPLOAD_ACCEPT,
    maxSizeMb: UPLOAD_MAX_MB,
    onFiles: (files) => handleFiles(files, field),
  })
}

const {
  dropzoneProps: cdlFrontZone,
  inputProps: cdlFrontInputProps,
  setInputEl: setCdlFrontInput,
  openPicker: openCdlFront,
  dragActive: cdlFrontOver,
  error: cdlFrontError,
  supportsDrag,
} = uploadDrop('cdl_front')

const {
  dropzoneProps: cdlBackZone,
  inputProps: cdlBackInputProps,
  setInputEl: setCdlBackInput,
  openPicker: openCdlBack,
  dragActive: cdlBackOver,
  error: cdlBackError,
} = uploadDrop('cdl_back')

const {
  dropzoneProps: medicalZone,
  inputProps: medicalInputProps,
  setInputEl: setMedicalInput,
  openPicker: openMedical,
  dragActive: medicalOver,
  error: medicalError,
} = uploadDrop('medical_card')

// One message slot per field, reusing the warning row that already exists.
// A type/size rejection outranks a low-res hint because the rejection means
// nothing was attached at all. Both are cleared by the next file on that field:
// useFileDrop clears its own error at the top of every batch, handleFiles
// clears the low-res hint.
const uploadMessages = computed(() => ({
  cdl_front: cdlFrontError.value || lowResWarnings.cdl_front,
  cdl_back: cdlBackError.value || lowResWarnings.cdl_back,
  medical_card: medicalError.value || lowResWarnings.medical_card,
}))

// A PDF from Windows routinely arrives with file.type === '', and since a drop
// bypasses `accept` entirely a MIME-only test would call it an image and feed
// it to <img :src>, i.e. a permanently broken thumbnail on a required field.
function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
}

// Receives File[] from its card's useFileDrop instance — a drop and a click
// both land here. useFileDrop already clears the <input> value before calling
// us, so re-picking the same file after an error still fires (that is why the
// old `event.target.value = ''` in the error path below is gone rather than
// lost).
function handleFiles(files, field) {
  const file = files[0]
  if (!file) return
  fileTypes[field] = isPdf(file)
  lowResWarnings[field] = '' // clear any previous warning
  if (fileTypes[field]) {
    // A PDF is stored as-is — there is nothing to downscale and nothing to
    // measure a resolution against. readFileAsDataURL resolves to '' rather than
    // rejecting, so guard: assigning '' would leave a required field looking
    // filled on a form the applicant cannot get back to.
    readFileAsDataURL(file).then((dataUrl) => {
      if (dataUrl) props.form[field] = dataUrl
      else lowResWarnings[field] = 'Could not read that file. Please try a different file.'
    })
    return
  }
  const img = new Image()
  img.onload = () => {
    const nativeW = img.naturalWidth
    const nativeH = img.naturalHeight
    // Low-res images are accepted but flagged inline (no blocking alert).
    if (nativeW < MIN_W || nativeH < MIN_H) {
      lowResWarnings[field] = `This image is ${nativeW}\u00D7${nativeH}px. For best readability in the printed PDF, try a photo at least ${MIN_W}\u00D7${MIN_H}px if you have one.`
    }
    // Only scale DOWN for large files — never up. Preserves aspect ratio.
    let width = nativeW
    let height = nativeH
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height)
      width = Math.round(width * scale)
      height = Math.round(height * scale)
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').drawImage(img, 0, 0, width, height)
    props.form[field] = canvas.toDataURL('image/jpeg', 0.92)
  }
  img.onerror = async () => {
    // Chrome/Firefox/Edge/Android cannot decode HEIC in an <img>, and an iPhone
    // photo is the single commonest thing a driver hands this form — so the
    // file the accept list above now welcomes would otherwise dead-end right
    // here on "could not read that image". compressImage's HEIC branch (lazy
    // heic2any, downloaded only when a HEIC actually needs it) is the one path
    // that turns it into a JPEG this form can preview and submit.
    // Resolution is unmeasurable on this path, so the low-res hint is skipped
    // rather than guessed — it was always a hint, never a gate.
    const dataUrl = await compressImage(file, MAX_DIMENSION, { quality: 0.92 })
    // compressImage falls back to the RAW bytes for anything it cannot decode,
    // so only a genuinely decoded image may be shown as a preview.
    if (isDecodedImage(dataUrl)) {
      props.form[field] = dataUrl
      return
    }
    lowResWarnings[field] = 'Could not read that image. Please try a different file.'
  }
  img.src = URL.createObjectURL(file)
}

onMounted(async () => {
  if (window.google && window.google.maps && window.google.maps.places) {
    initAutocomplete()
    return
  }
  const existing = document.querySelector('script[src*="maps.googleapis.com/maps/api"]')
  if (existing) {
    const check = setInterval(() => {
      if (window.google?.maps?.places) { clearInterval(check); initAutocomplete() }
    }, 200)
    return
  }
  try {
    const res = await fetch('/api/config/maps-key')
    const { key } = await res.json()
    if (!key) return
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=__initApplyAutocomplete`
    script.async = true
    window.__initApplyAutocomplete = () => initAutocomplete()
    document.head.appendChild(script)
  } catch { /* no maps key available */ }
})

function initAutocomplete() {
  if (!addressInput.value) return
  const autocomplete = new window.google.maps.places.Autocomplete(addressInput.value, {
    types: ['address'],
    componentRestrictions: { country: 'us' },
    fields: ['address_components', 'formatted_address', 'geometry'],
  })
  autocomplete.addListener('place_changed', () => {
    const place = autocomplete.getPlace()
    if (place && place.formatted_address) {
      props.form.address = place.formatted_address
      const c = parseAddressComponents(place.address_components)
      if (c.city) props.form.city = c.city
      if (c.state) props.form.state = c.state
      if (c.zip) props.form.zip = c.zip
    }
  })
}
</script>

<style scoped>
.grid-cols-3 { grid-template-columns: 1fr 1fr 1fr; }
.field-hint { font-size: 0.72rem; color: #9ca3af; margin: 0.35rem 0 0; }
.opt { font-weight: 400; color: #9ca3af; font-size: 0.72rem; margin-left: 0.25rem; }
.upload-section { margin-bottom: 1.1rem; }
.upload-hint { font-size: 0.78rem; color: #9ca3af; margin: 0.25rem 0 0.25rem; }
.upload-tip { font-size: 0.72rem; color: #64748b; margin: 0 0 0.75rem; line-height: 1.4; font-style: italic; }
.upload-warning {
  font-size: 0.75rem; color: #b45309;
  background: #fffbeb; border: 1px solid #fde68a;
  border-radius: 6px; padding: 0.5rem 0.65rem; margin-top: 0.5rem;
  display: flex; align-items: flex-start; gap: 0.4rem; line-height: 1.4;
}
.warning-dot { flex-shrink: 0; font-size: 0.88rem; }
.upload-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.75rem; }
.upload-card {
  border: 2px dashed #e2e4ea;
  border-radius: 10px;
  padding: 1rem;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #f9fafb;
  overflow: hidden;
}
.upload-card:hover { border-color: hsl(199, 89%, 48%); background: #f0f9ff; }
.upload-card:focus-visible {
  outline: 2px solid hsl(199, 89%, 48%);
  outline-offset: 2px;
}
/* Same "dashed becomes solid" treatment FileDropZone uses for a live drag, so
   the two surfaces read identically to anyone who has used either. */
.upload-card.is-over {
  border-color: hsl(199, 89%, 48%);
  border-style: solid;
  background: #f0f9ff;
}
.upload-placeholder { font-size: 1.75rem; margin-bottom: 0.35rem; }
.upload-label { font-size: 0.75rem; font-weight: 600; color: #6b7280; }
.upload-formats { font-size: 0.65rem; color: #9ca3af; margin-top: 0.15rem; }
.upload-preview {
  width: 100%;
  height: 100px;
  object-fit: cover;
  border-radius: 6px;
}
.pdf-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}
.pdf-icon {
  font-size: 2rem;
}
.address-row { display: flex; gap: 0.5rem; }
.address-input-wrap { flex: 1; position: relative; }
.address-input-wrap input { width: 100%; padding: 0.7rem 0.85rem; padding-right: 38px; border: 1.5px solid #e2e4ea; border-radius: 10px; background: #f9fafb; font-size: 0.88rem; font-family: inherit; color: #111827; transition: border-color 0.15s, box-shadow 0.15s; }
.address-input-wrap input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); background: #fff; outline: none; }
.address-input-wrap input::placeholder { color: #c4c8d0; }
.addr-action-btn {
  position: absolute; right: 7px; top: 50%; transform: translateY(-50%);
  width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 6px; background: transparent;
  color: #94a3b8; cursor: pointer; transition: all 0.15s;
}
.addr-action-btn:hover { background: #f1f5f9; color: #475569; }
.addr-action-btn:disabled { cursor: wait; opacity: 0.4; }
.map-btn {
  flex-shrink: 0; width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  border: 1.5px solid #e2e4ea; border-radius: 10px; background: #fff;
  color: #94a3b8; cursor: pointer; transition: all 0.15s;
}
.map-btn:hover { border-color: #3b82f6; color: #3b82f6; }
.spinner {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid #94a3b8; border-top-color: transparent;
  border-radius: 50%; animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) {
  .upload-grid { grid-template-columns: 1fr; }
  .grid-cols-3 { grid-template-columns: 1fr; }
}
</style>
