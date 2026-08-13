<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--blue);"></div>
      Driver Directory
    </div>

    <EmptyState v-if="drivers.length === 0">No drivers yet.</EmptyState>

    <table v-else class="drv-table">
      <thead>
        <tr>
          <th>Driver</th>
          <th>Status</th>
          <th>Location</th>
          <th>Phone</th>
          <th>Email</th>
          <th>DOT</th>
          <th>MC</th>
          <th>Trucks</th>
          <th>Hazmat</th>
          <th>Rating</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in drivers" :key="d._rowIndex" class="clickable-row" @click="viewDrv = d">
          <td class="name-cell">{{ d[h.driver] || '\u2014' }}</td>
          <td>
            <span class="status-badge" :class="statusClass(d)">{{ (d.Status || 'active').toUpperCase() }}</span>
          </td>
          <td>{{ locStr(d) }}</td>
          <td>{{ d[h.phone] || '\u2014' }}</td>
          <td>{{ d[h.email] || '\u2014' }}</td>
          <td class="mono">{{ d[h.dot] || '\u2014' }}</td>
          <td class="mono">{{ d[h.mc] || '\u2014' }}</td>
          <td class="mono">{{ getAssignedTruck(d) }}</td>
          <td>{{ d[h.hazmat] || '\u2014' }}</td>
          <td>
            <template v-if="getDriverAvg(d)">
              <StarRating :model-value="Math.round(getDriverAvg(d).average)" readonly />
              <span style="font-size:0.7rem;color:#6b7280;margin-left:4px;">{{ getDriverAvg(d).average }} ({{ getDriverAvg(d).count }})</span>
            </template>
            <template v-else>{{ d[h.rating] || '\u2014' }}</template>
          </td>
          <td style="text-align:right;" @click.stop>
            <div class="action-btns">
              <button class="btn-edit" @click="openEdit(d)">Edit</button>
              <button class="btn-remove" @click="confirmDelete(d)">Remove</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- View Detail -->
    <Teleport to="body">
      <div v-if="viewDrv" class="confirm-overlay" @click.self="closeView">
        <div class="confirm-box" style="max-width:640px;max-height:85vh;overflow-y:auto;">
          <div class="view-header">
            <!-- v-bind="dropzoneProps" goes on the WRAPPER, never on the inner
                 input: the wrapper always preventDefault()s, so a drop that
                 lands on the avatar can never fall through to the document and
                 navigate the SPA away to render the file. -->
            <label
              class="view-avatar-wrap"
              :class="{ 'view-avatar-uploading': picUploading, 'view-avatar-drop': dragActive }"
              :title="avatarTitle"
              v-bind="dropzoneProps"
            >
              <img v-if="viewDrv.ProfilePictureUrl" :src="viewDrv.ProfilePictureUrl" class="view-avatar-img" alt="Profile picture" />
              <div v-else class="view-avatar-initials"><AvatarPlaceholder /></div>
              <div class="view-avatar-overlay">
                <svg v-if="!picUploading" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                <div v-else class="view-spinner"></div>
              </div>
              <!-- The label already opens the picker natively (the input is a
                   descendant) — no @click="openPicker", which opens it twice. -->
              <input v-bind="inputProps" class="view-avatar-input" />
            </label>
            <h3 style="margin:0;">{{ viewDrv[h.driver] }}</h3>
          </div>
          <!-- This modal has no toast, so without this a refused or failed
               upload is invisible — the silent fail this component used to
               carry. One slot: error wins over notice when both are set. -->
          <p
            v-if="picError || picNotice"
            class="pic-msg"
            :class="picError ? 'pic-msg-error' : 'pic-msg-note'"
            :role="picError ? 'alert' : 'status'"
          >
            <span>{{ picError || picNotice }}</span>
            <button type="button" class="pic-msg-dismiss" @click="clearMessages">Dismiss</button>
          </p>
          <div class="view-grid">
            <div v-for="col in viewHeaders" :key="col" class="view-row">
              <span class="view-label">{{ col }}</span>
              <span>{{ viewDrv[col] || '\u2014' }}</span>
            </div>
            <div v-if="docsData.ssn" class="view-row">
              <span class="view-label">SSN</span>
              <span class="ssn-value">
                {{ ssnDisplay }}<span v-if="ssnRevealError" class="ssn-reveal-error"> — {{ ssnRevealError }}</span>
                <button type="button" class="ssn-toggle" @click="toggleSsn" :title="showSsn ? 'Hide' : 'Show full SSN (recorded in the audit trail)'">
                  <svg v-if="!showSsn" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                </button>
              </span>
            </div>
          </div>

          <!-- Original Application Details — everything the driver submitted -->
          <div v-if="docsData.application" class="docs-section">
            <div class="docs-title">Application Details</div>
            <div class="app-grid">
              <div v-if="docsData.application.dob" class="app-item"><span class="app-label">Date of Birth</span><span>{{ docsData.application.dob }}</span></div>
              <div v-if="docsData.application.drivers_license" class="app-item"><span class="app-label">Driver's License #</span><span>{{ docsData.application.drivers_license }}</span></div>
              <div v-if="docsData.application.position" class="app-item"><span class="app-label">Position Applied For</span><span>{{ docsData.application.position }}</span></div>
              <div v-if="docsData.application.experience" class="app-item"><span class="app-label">Experience Level</span><span>{{ docsData.application.experience }}</span></div>
              <div v-if="docsData.application.has_cdl" class="app-item"><span class="app-label">Has CDL</span><span>{{ docsData.application.has_cdl }}</span></div>
              <div v-if="docsData.application.work_authorized" class="app-item"><span class="app-label">Work Authorized</span><span>{{ docsData.application.work_authorized }}</span></div>
              <div v-if="docsData.application.felony_convicted" class="app-item"><span class="app-label">Felony Convicted</span><span>{{ docsData.application.felony_convicted }}</span></div>
              <div v-if="docsData.application.felony_explanation" class="app-item full"><span class="app-label">Felony Explanation</span><span>{{ docsData.application.felony_explanation }}</span></div>
              <div v-if="docsData.application.accident_history" class="app-item"><span class="app-label">Accident History</span><span>{{ docsData.application.accident_history }}</span></div>
              <div v-if="docsData.application.accident_description" class="app-item full"><span class="app-label">Accident Description</span><span>{{ docsData.application.accident_description }}</span></div>
              <div v-if="docsData.application.traffic_citations" class="app-item full"><span class="app-label">Traffic Citations</span><span>{{ docsData.application.traffic_citations }}</span></div>
              <div v-if="docsData.application.certifications" class="app-item full"><span class="app-label">Certifications / Endorsements</span><span>{{ docsData.application.certifications }}</span></div>
              <div v-if="docsData.application.availability" class="app-item"><span class="app-label">Availability</span><span>{{ docsData.application.availability }}</span></div>
              <div v-if="docsData.application.skills" class="app-item full"><span class="app-label">Skills</span><span>{{ docsData.application.skills }}</span></div>
              <div v-if="docsData.application.reference_info" class="app-item full"><span class="app-label">References</span><span class="prewrap">{{ docsData.application.reference_info }}</span></div>
              <div v-if="docsData.application.additional_info" class="app-item full"><span class="app-label">Additional Info</span><span class="prewrap">{{ docsData.application.additional_info }}</span></div>
              <div v-if="docsData.application.signature" class="app-item"><span class="app-label">Signature</span><span>{{ docsData.application.signature }}</span></div>
              <div v-if="docsData.application.signature_date" class="app-item"><span class="app-label">Signed On</span><span>{{ docsData.application.signature_date }}</span></div>
            </div>
          </div>

          <!-- Signed Onboarding Documents -->
          <div class="docs-section">
            <div class="docs-title">Signed Onboarding Documents</div>
            <div v-if="docsLoading" class="docs-empty">Loading...</div>
            <template v-else-if="docsData.linked === false">
              <div class="docs-empty">No onboarding record linked to this driver.</div>
            </template>
            <template v-else-if="docsData.documents && docsData.documents.length">
              <div v-for="doc in docsData.documents" :key="doc.doc_key" class="doc-row">
                <div class="doc-info">
                  <div class="doc-name">{{ doc.doc_name }}</div>
                  <div v-if="doc.signed" class="doc-meta">
                    Signed by <b>{{ doc.signature_text }}</b>
                    <span v-if="doc.signed_at"> · {{ fmtTimestamp(doc.signed_at) }}</span>
                  </div>
                  <div v-else class="doc-meta doc-pending">Not signed</div>
                </div>
                <a v-if="doc.signed && doc.signed_pdf_url" :href="doc.signed_pdf_url" target="_blank" class="doc-link">View PDF</a>
                <span v-else class="doc-pending-badge">Pending</span>
              </div>
            </template>
            <div v-else class="docs-empty">No signed documents.</div>
          </div>

          <!-- Drug Test -->
          <div class="docs-section">
            <div class="docs-title">Pre-Employment Drug Test</div>
            <div v-if="docsLoading" class="docs-empty">Loading...</div>
            <template v-else-if="docsData.drugTest">
              <div class="doc-row">
                <div class="doc-info">
                  <div class="doc-name">Drug Test Result</div>
                  <div class="doc-meta">
                    <span :class="docsData.drugTest.result === 'pass' ? 'dt-pass' : 'dt-fail'">
                      {{ docsData.drugTest.result.toUpperCase() }}
                    </span>
                    <span v-if="docsData.drugTest.uploaded_at"> · Uploaded {{ fmtTimestamp(docsData.drugTest.uploaded_at) }}</span>
                  </div>
                </div>
                <a v-if="docsData.drugTest.file_url" :href="docsData.drugTest.file_url" target="_blank" class="doc-link">View File</a>
              </div>
            </template>
            <div v-else-if="docsData.linked !== false" class="docs-empty">No drug test uploaded yet.</div>
          </div>

          <!-- Shared Documents — Super Admin uploads files the driver sees in their Kit tab -->
          <LegalDocumentPortal v-if="viewDrv._rowIndex" :driver-id="viewDrv._rowIndex" />

          <div style="margin-top:1rem;text-align:right;">
            <button class="btn btn-secondary" @click="closeView">Close</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEdit" class="confirm-overlay" @click.self="showEdit = false">
        <div class="confirm-dialog edit-dialog">
          <h3>Edit Driver &mdash; {{ editForm.driver }}</h3>

          <div class="edit-field">
            <label>Driver Name</label>
            <input v-model="editForm.driver" type="text" />
          </div>

          <div class="edit-field">
            <label>Address</label>
            <input v-model="editForm.address" type="text" />
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>City</label>
              <input v-model="editForm.city" type="text" />
            </div>
            <div class="edit-field">
              <label>State</label>
              <input v-model="editForm.state" type="text" maxlength="2" style="text-transform:uppercase;" />
            </div>
            <div class="edit-field">
              <label>ZIP</label>
              <input v-model="editForm.zip" type="text" />
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Phone Number</label>
              <input v-model="editForm.phone" type="tel" />
            </div>
            <div class="edit-field">
              <label>Cell Number</label>
              <input v-model="editForm.cell" type="tel" />
            </div>
            <div class="edit-field">
              <label>Email</label>
              <input v-model="editForm.email" type="email" />
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Trucks</label>
              <input v-model="editForm.trucks" type="text" />
            </div>
            <div class="edit-field">
              <label>Hazmat</label>
              <select v-model="editForm.hazmat">
                <option value="NO">NO</option>
                <option value="YES">YES</option>
              </select>
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>DOT #</label>
              <input v-model="editForm.dot" type="text" />
            </div>
            <div class="edit-field">
              <label>MC #</label>
              <input v-model="editForm.mc" type="text" />
            </div>
            <div class="edit-field">
              <label>Rating</label>
              <select v-model="editForm.rating">
                <option value="Not Rated">Not Rated</option>
                <option value="A+">A+</option>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
                <option value="N/A">N/A</option>
              </select>
            </div>
          </div>

          <div class="edit-field">
            <label>Status</label>
            <select v-model="editForm.status">
              <option value="pending">Pending (awaiting drug test)</option>
              <option value="active">Active (can be dispatched)</option>
              <option value="inactive">Inactive (hidden from dispatch)</option>
            </select>
            <p class="status-help">Drivers become Active automatically after passing their drug test. Use this toggle to override.</p>
          </div>

          <fieldset class="pay-section">
            <legend>Pay Structure</legend>
            <div class="pay-options">
              <label class="pay-radio">
                <input type="radio" v-model="editForm.payType" value="fixed" />
                <span>Fixed Daily Rate (per day &times; active days)</span>
              </label>
              <label class="pay-radio">
                <input type="radio" v-model="editForm.payType" value="percentage" />
                <span>Percentage of Net Load Revenue (owner-operator)</span>
              </label>
            </div>
            <div v-if="editForm.payType === 'fixed'" class="edit-field" style="margin-top:0.5rem;">
              <label>Daily Rate ($/day)</label>
              <input v-model.number="editForm.payDaily" type="number" min="0" step="1" placeholder="e.g. 250" />
              <p class="status-help">Driver earns this &times; active days. Leave blank/0 to use the assigned truck's rate (default $250).</p>
            </div>
            <div v-if="editForm.payType === 'percentage'" class="edit-field" style="margin-top:0.5rem;">
              <label>Owner-Operator Share (%)</label>
              <input v-model.number="editForm.payPercentage" type="number" min="0" max="100" step="0.1" placeholder="e.g. 30" />
              <p class="status-help">Driver gets {{ Number(editForm.payPercentage) || 0 }}% of (weekly load revenue &minus; fuel &amp; maintenance expenses). LogisX keeps the rest.</p>
            </div>
          </fieldset>

          <div class="confirm-actions">
            <button class="btn btn-secondary" @click="showEdit = false">Cancel</button>
            <button class="btn btn-primary" @click="handleSaveEdit">Save</button>
          </div>
        </div>
      </div>
    </Teleport>

    <ConfirmModal
      :open="showConfirm"
      title="Delete Driver"
      :message="`Delete driver '${pendingDrv?.[h.driver] || ''}'? This action cannot be undone.`"
      confirm-text="Delete"
      :danger="true"
      @confirm="handleConfirmDelete"
      @cancel="showConfirm = false"
    />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { useFileDrop } from '../../composables/useFileDrop'
import { AVATAR_MAX_EDGE, compressImage, isDecodedImage } from '../../lib/imageUtils'
import { fmtTimestamp } from '../../utils/datetime'
import EmptyState from '../shared/EmptyState.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'
import StarRating from '../shared/StarRating.vue'
import AvatarPlaceholder from '../shared/AvatarPlaceholder.vue'
import LegalDocumentPortal from '../investor/LegalDocumentPortal.vue'

const api = useApi()

const props = defineProps({
  drivers: { type: Array, default: () => [] },
  headers: { type: Array, default: () => [] },
  driverRatings: { type: Object, default: () => ({}) },
  truckAssignments: { type: Array, default: () => [] },
})

function getAssignedTruck(driver) {
  const driverCol = props.headers.find(h => /driver/i.test(h)) || props.headers[0]
  const name = (driver[driverCol] || '').trim().toLowerCase()
  if (!name) return '\u2014'
  const assignment = props.truckAssignments.find(a => (a.driver_name || '').toLowerCase() === name)
  if (!assignment) return '\u2014'
  return `${assignment.unit_number} (${assignment.year || ''} ${assignment.make || ''} ${assignment.model || ''})`.trim()
}

const emit = defineEmits(['delete', 'update', 'picture-updated'])

const viewDrv = ref(null)
const docsLoading = ref(false)
// NOTE: `application` is deliberately NOT stored here. The template has an
// "Application Details" block keyed on `docsData.application`, but nothing has
// ever assigned it, so that block has always been dead. Populating it now would
// silently switch on a panel of DOB / licence / felony history — more PII on
// screen, in a change whose whole purpose is less. Only the id is kept, which
// is all the reveal call needs.
const docsData = reactive({ documents: [], drugTest: null, linked: true, ssn: null, applicationId: null })
const showSsn = ref(false)
// The API now returns the SSN already masked, so revealing means asking for it
// explicitly — GET /api/applications/:id/sensitive, which writes an audit row.
// Held separately from docsData.ssn so the masked value is never overwritten and
// re-masking stays correct after the reveal is toggled back off.
const ssnFull = ref('')
const ssnRevealError = ref('')
const showConfirm = ref(false)
const pendingDrv = ref(null)
const showEdit = ref(false)
const editRowIndex = ref(null)
const picUploading = ref(false)

// Drag-and-drop + the only real type/size gate on this surface: `accept` on the
// input filters the OS dialog and NOTHING else, so a dropped file is checked
// here or nowhere.
const {
  dropzoneProps,
  inputProps,
  dragActive,
  supportsDrag,
  error: picError,
  notice: picNotice,
  clearMessages,
} = useFileDrop({
  accept: 'image/*',
  maxSizeMb: 10,
  busy: picUploading,
  onFiles: (files) => onPicFiles(files),
})

const avatarTitle = computed(() =>
  supportsDrag.value
    ? 'Click, or drop an image here, to change the profile picture'
    : 'Tap to change the profile picture',
)

// Takes File[] from useFileDrop (picker and drop both land here already
// validated), not a DOM change event.
async function onPicFiles(files) {
  const file = files?.[0]
  if (!file) return
  if (!viewDrv.value?._rowIndex) return
  picUploading.value = true
  try {
    const base64 = await compressImage(file, AVATAR_MAX_EDGE, { background: '#ffffff', quality: 0.9 })
    // compressImage hands back the RAW bytes when it can't decode the file, so
    // this is what keeps the payload the JPEG data URL this endpoint has always
    // been sent.
    if (!isDecodedImage(base64)) {
      picError.value = "That image couldn't be read — try a different file."
      return
    }
    const res = await api.post(`/api/drivers-directory/${viewDrv.value._rowIndex}/profile-picture`, {
      fileData: base64,
      fileName: file.name,
    })
    // Update the current view and the row in props.drivers so both refresh
    viewDrv.value.ProfilePictureUrl = res.url
    emit('picture-updated')
  } catch (err) {
    // Was a silent fail. This modal still has no toast, so the message goes to
    // the shared slot under the avatar rather than nowhere. useApi already
    // produces human copy (413, 403, timeout), so keep it — but lead with
    // "Upload failed" so the slot it shares with validation errors is unambiguous.
    picError.value = err?.message ? `Upload failed — ${err.message}` : 'Upload failed — try again.'
  } finally {
    picUploading.value = false
    // No `event.target.value = ''` here any more — useFileDrop clears the input
    // BEFORE handling, so re-picking the same file after a failure still fires.
  }
}

// Stays correct whether the server sent a masked value or (with
// PII_MASK_ENABLED=false) a raw one: it reduces to digits first, so masking an
// already-masked value is a no-op rather than eating the last four.
const maskedSsn = computed(() => {
  const s = (docsData.ssn || '').replace(/\D/g, '')
  if (!s) return ''
  return s.length >= 4 ? `***-**-${s.slice(-4)}` : '***-**-****'
})

// Show the real digits only once they have actually been fetched; otherwise the
// eye toggle would "reveal" the mask and look broken.
const ssnDisplay = computed(() => (showSsn.value && ssnFull.value ? ssnFull.value : maskedSsn.value))

async function toggleSsn() {
  if (showSsn.value) { showSsn.value = false; return }
  ssnRevealError.value = ''
  if (!ssnFull.value) {
    const appId = docsData.applicationId
    if (!appId) { ssnRevealError.value = 'Unavailable'; return }
    try {
      const res = await api.get(`/api/applications/${appId}/sensitive`)
      ssnFull.value = res.ssn || ''
      if (!ssnFull.value) { ssnRevealError.value = 'Unavailable'; return }
    } catch {
      // 429 from the reveal limiter lands here too — surface something rather
      // than silently leaving the eye toggled off, which reads as a dead button.
      ssnRevealError.value = 'Unavailable'
      return
    }
  }
  showSsn.value = true
}

// Fetch signed docs + drug test + SSN when the detail modal opens
watch(viewDrv, async (d) => {
  docsData.documents = []
  docsData.drugTest = null
  docsData.linked = true
  docsData.ssn = null
  docsData.applicationId = null
  showSsn.value = false
  ssnFull.value = ''
  ssnRevealError.value = ''
  // The modal is reused for every row, so a message left over from the last
  // driver would otherwise reappear against the next one.
  clearMessages()
  if (!d || !d._rowIndex) return
  docsLoading.value = true
  try {
    const res = await api.get(`/api/drivers-directory/${d._rowIndex}/documents`)
    docsData.documents = res.documents || []
    docsData.drugTest = res.drugTest || null
    docsData.linked = res.linked !== false
    docsData.ssn = res.ssn || null
    docsData.applicationId = res.application?.id || null
  } catch { /* ignore */ }
  finally { docsLoading.value = false }
})

function closeView() {
  viewDrv.value = null
  showSsn.value = false
}

const h = computed(() => {
  const hd = props.headers
  const find = (re) => hd.find(c => re.test(c)) || ''
  return {
    driver: find(/^driver$/i),
    state: find(/^state$/i),
    city: find(/^city$/i),
    zip: find(/^zip$/i),
    address: find(/^address$/i),
    trucks: find(/^trucks$/i),
    hazmat: find(/hazmat/i),
    phone: find(/phone/i),
    cell: find(/cell/i),
    email: find(/email/i),
    dot: find(/dot/i),
    mc: find(/^mc$/i),
    rating: find(/rating/i),
  }
})

const viewHeaders = computed(() => props.headers.filter(c => !/carrier/i.test(c)))

const editForm = reactive({
  driver: '', state: '', city: '', zip: '', address: '',
  trucks: '', hazmat: 'NO', phone: '', cell: '', email: '',
  dot: '', mc: '', rating: 'Not Rated', status: 'active',
  payType: 'fixed', payPercentage: 0, payDaily: 0,
})

function statusClass(d) {
  const s = (d.Status || 'active').toLowerCase()
  if (s === 'active') return 'status-active'
  if (s === 'pending') return 'status-pending'
  return 'status-inactive'
}

function getDriverAvg(d) {
  const name = (d[h.value.driver] || '').trim().toLowerCase()
  if (!name) return null
  const r = props.driverRatings[name]
  return r && r.count > 0 ? r : null
}

function locStr(d) {
  const parts = [d[h.value.city], d[h.value.state]].filter(Boolean)
  return parts.length ? parts.join(', ') : '\u2014'
}

function openEdit(d) {
  editRowIndex.value = d._rowIndex
  editForm.driver = d[h.value.driver] || ''
  editForm.state = d[h.value.state] || ''
  editForm.city = d[h.value.city] || ''
  editForm.zip = d[h.value.zip] || ''
  editForm.address = d[h.value.address] || ''
  editForm.trucks = d[h.value.trucks] || ''
  editForm.hazmat = d[h.value.hazmat] || 'NO'
  editForm.phone = d[h.value.phone] || ''
  editForm.cell = d[h.value.cell] || ''
  editForm.email = d[h.value.email] || ''
  editForm.dot = d[h.value.dot] || ''
  editForm.mc = d[h.value.mc] || ''
  editForm.rating = d[h.value.rating] || 'Not Rated'
  editForm.status = d.Status || 'active'
  editForm.payType = d.PayType || 'fixed'
  editForm.payPercentage = Number(d.PayPercentage) || 0
  editForm.payDaily = Number(d.PayDaily) || 0
  showEdit.value = true
}

function handleSaveEdit() {
  emit('update', {
    rowIndex: editRowIndex.value,
    values: [
      editForm.driver,
      '', // Carrier Name — server preserves existing on edit (UI no longer sets it)
      editForm.state, editForm.city,
      editForm.zip, editForm.address, editForm.trucks, editForm.hazmat,
      editForm.phone, editForm.cell, editForm.email,
      editForm.dot, editForm.mc, editForm.rating, editForm.status,
      editForm.payType,
      editForm.payType === 'percentage' ? (Number(editForm.payPercentage) || 0) : 0,
      editForm.payType === 'fixed' ? (Number(editForm.payDaily) || 0) : 0,
    ],
  })
  showEdit.value = false
}

function confirmDelete(d) {
  pendingDrv.value = d
  showConfirm.value = true
}

function handleConfirmDelete() {
  if (pendingDrv.value) emit('delete', pendingDrv.value._rowIndex)
  showConfirm.value = false
  pendingDrv.value = null
}
</script>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.admin-section-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-weight: 700; font-size: 0.88rem; margin-bottom: 1rem;
}
.section-dot { width: 8px; height: 8px; border-radius: 50%; }

.drv-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.82rem; margin-top: 0.5rem;
}
.drv-table th {
  text-align: left; padding: 0.6rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.drv-table td {
  padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.drv-table tbody tr { transition: background 0.1s; }
.drv-table tbody tr:hover { background: var(--bg); }
.drv-table tbody tr:last-child td { border-bottom: none; }

.name-cell { font-weight: 600; }
.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; }

.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.status-badge.status-active { background: #dcfce7; color: #166534; }
.status-badge.status-pending { background: #fef3c7; color: #92400e; }
.status-badge.status-inactive { background: #f1f5f9; color: #64748b; }

.status-help {
  font-size: 0.68rem;
  color: #9ca3af;
  margin: 0.3rem 0 0;
  line-height: 1.4;
}

.pay-section {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.65rem 0.8rem 0.5rem;
  margin: 0.6rem 0 0.25rem;
}
.pay-section legend {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 0.4rem;
}
.pay-options {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.pay-radio {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  cursor: pointer;
}
.pay-radio input[type="radio"] { margin: 0; }

.action-btns { display: flex; gap: 0.35rem; justify-content: flex-end; }
.btn-edit, .btn-remove {
  padding: 0.3rem 0.65rem; font-size: 0.7rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface);
  cursor: pointer; font-family: inherit; font-weight: 500;
  color: var(--text-dim); transition: all 0.15s;
}
.btn-edit:hover { background: var(--blue-dim); color: var(--blue); border-color: var(--blue-dim); }
.btn-remove:hover { background: var(--danger-dim); color: var(--danger); border-color: var(--danger-dim); }

.confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}
.confirm-dialog {
  background: var(--surface); border-radius: var(--radius);
  padding: 1.5rem; max-width: 550px; width: 90%;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  max-height: 90vh; overflow-y: auto;
}
.confirm-dialog h3 { font-size: 1rem; margin-bottom: 1rem; }
.confirm-actions {
  display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem;
}
.confirm-box {
  background: var(--surface); border-radius: var(--radius);
  padding: 1.5rem; width: 90%;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
}

.edit-row { display: flex; gap: 1rem; }
.edit-row .edit-field { flex: 1; }
.edit-field { margin-bottom: 0.75rem; }
.edit-field label {
  display: block; font-size: 0.72rem; font-weight: 600;
  color: var(--text-dim); text-transform: uppercase;
  letter-spacing: 0.04em; margin-bottom: 0.3rem;
}
.edit-field select,
.edit-field input,
.edit-field textarea {
  width: 100%; padding: 0.5rem 0.65rem; border: 1px solid var(--border);
  border-radius: 6px; font-family: inherit; font-size: 0.82rem;
  background: var(--bg); color: var(--text); resize: vertical;
}
.edit-field select:focus,
.edit-field input:focus {
  outline: none; border-color: var(--blue);
}

.clickable-row { cursor: pointer; }
.clickable-row:hover td { background: var(--accent-dim, #f0f9ff); }
.view-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}
.view-avatar-wrap {
  position: relative;
  width: 64px;
  height: 64px;
  flex-shrink: 0;
  cursor: pointer;
  border-radius: 50%;
  overflow: hidden;
  transition: box-shadow 0.15s;
}
.view-avatar-wrap .view-avatar-overlay { opacity: 0; }
.view-avatar-wrap:hover .view-avatar-overlay,
.view-avatar-wrap.view-avatar-uploading .view-avatar-overlay,
.view-avatar-wrap.view-avatar-drop .view-avatar-overlay { opacity: 1; }
/* :hover is unreliable mid-drag, so dragActive drives the highlight. The ring is
   a box-shadow on the wrapper itself, which its own overflow:hidden doesn't clip. */
.view-avatar-wrap.view-avatar-drop {
  box-shadow: 0 0 0 3px var(--accent, #0ea5e9);
}
@media (prefers-reduced-motion: reduce) {
  .view-avatar-wrap { transition: none; }
}

/* Upload feedback for a modal with no toast. Small on purpose — it sits under
   the avatar row and above the detail grid. */
.pic-msg {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  margin: -0.5rem 0 0.85rem;
  padding: 0.45rem 0.6rem;
  font-size: 0.72rem;
  line-height: 1.4;
  border-radius: 6px;
}
.pic-msg-error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }
.pic-msg-note { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
.pic-msg-dismiss {
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
.view-avatar-img {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
.view-avatar-initials {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--accent-dim, #e0f2fe);
  color: var(--accent, #0ea5e9);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 1.3rem;
}
.view-avatar-overlay {
  position: absolute;
  inset: 0;
  background: rgba(15, 23, 42, 0.55);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s;
  border-radius: 50%;
}
.view-avatar-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
}
.view-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: view-spin 0.7s linear infinite;
}
@keyframes view-spin { to { transform: rotate(360deg); } }
.view-grid { display: flex; flex-direction: column; gap: 0.4rem; }
.view-row { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #f1f5f9; font-size: 0.85rem; }
.view-label { font-weight: 600; color: var(--text-dim); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
.ssn-value {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  letter-spacing: 0.03em;
}
.ssn-toggle {
  background: transparent;
  border: none;
  padding: 0.2rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.12s, color 0.12s;
}
.ssn-toggle:hover { background: #f1f5f9; color: #475569; }
/* Reveal failure (no linked application, or the 20/15min reveal limiter). Shown
   BESIDE the mask, never instead of it — the last four digits are the useful
   part for support and there is no reason to take them away too. */
.ssn-reveal-error { color: #b45309; font-size: 12px; }

.docs-section { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid #e8edf2; }
.docs-title { font-size: 0.72rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.6rem; }
.app-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 1rem; }
.app-item { display: flex; flex-direction: column; gap: 0.1rem; font-size: 0.82rem; }
.app-item.full { grid-column: 1 / -1; }
.app-label { font-size: 0.68rem; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.prewrap { white-space: pre-wrap; }
.docs-empty { font-size: 0.78rem; color: #9ca3af; padding: 0.5rem 0; }
.doc-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.55rem 0.75rem; background: #fafbfd; border: 1px solid #f1f5f9;
  border-radius: 8px; margin-bottom: 0.35rem;
}
.doc-info { flex: 1; min-width: 0; }
.doc-name { font-size: 0.82rem; font-weight: 600; color: #0f172a; }
.doc-meta { font-size: 0.72rem; color: #64748b; margin-top: 0.15rem; }
.doc-meta.doc-pending { color: #d97706; }
.doc-link {
  font-size: 0.72rem; font-weight: 600; color: #0ea5e9; text-decoration: none;
  padding: 0.35rem 0.7rem; border: 1px solid #bae6fd; border-radius: 6px;
  background: #f0f9ff; flex-shrink: 0;
}
.doc-link:hover { background: #e0f2fe; }
.doc-pending-badge {
  font-size: 0.68rem; font-weight: 700; color: #92400e; background: #fef3c7;
  padding: 0.25rem 0.6rem; border-radius: 999px; text-transform: uppercase;
}
.dt-pass { color: #16a34a; font-weight: 700; }
.dt-fail { color: #dc2626; font-weight: 700; }
</style>
