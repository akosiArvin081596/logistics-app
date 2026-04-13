<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--blue);"></div>
      Fleet Inventory
    </div>

    <EmptyState v-if="trucks.length === 0">No trucks yet.</EmptyState>

    <table v-else class="truck-table">
      <thead>
        <tr>
          <th>Unit #</th>
          <th>Make / Model</th>
          <th>Year</th>
          <th>VIN</th>
          <th>Plate</th>
          <th>Status</th>
          <th>Driver</th>
          <th>Loads</th>
          <th v-if="showOwner">Owner</th>
          <th v-if="canEdit"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="truck in trucks" :key="truck.id" class="clickable-row" @click="viewTruck = truck">
          <td class="unit-number">{{ truck.UnitNumber }}</td>
          <td>{{ [truck.Make, truck.Model].filter(Boolean).join(' ') || '\u2014' }}</td>
          <td>{{ truck.Year || '\u2014' }}</td>
          <td class="vin-cell">{{ truck.VIN || '\u2014' }}</td>
          <td>{{ truck.LicensePlate || '\u2014' }}</td>
          <td>
            <span :class="['status-badge', statusClass(truck.Status)]">{{ truck.Status }}</span>
          </td>
          <td :style="{ color: truck.AssignedDriver ? 'var(--text)' : 'var(--text-dim)' }">
            {{ truck.AssignedDriver || '\u2014' }}
          </td>
          <td class="mono">{{ truck.LoadCount ?? 0 }}</td>
          <td v-if="showOwner" :style="{ color: truck.OwnerId ? 'var(--text)' : 'var(--text-dim)' }">
            {{ ownerName(truck.OwnerId) }}
          </td>
          <td v-if="canEdit" style="text-align: right;">
            <div class="action-btns">
              <button class="btn-edit" @click.stop="openEdit(truck)">Edit</button>
              <button class="btn-remove" @click.stop="confirmDelete(truck)">Remove</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEdit" class="confirm-overlay" @click.self="showEdit = false">
        <div class="confirm-dialog edit-dialog">
          <h3>Edit Truck &mdash; {{ editForm.unitNumber }}</h3>

          <div class="edit-field">
            <label>Unit Number</label>
            <input v-model="editForm.unitNumber" type="text" />
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Make</label>
              <select v-model="editForm.make">
                <option value="">-- Select --</option>
                <option v-for="m in truckMakes" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
            <div class="edit-field">
              <label>Model</label>
              <select v-model="editForm.model" :disabled="!editForm.make">
                <option value="">{{ editForm.make ? '-- Select model --' : '-- Select make first --' }}</option>
                <option v-for="m in editModelOptions" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Year</label>
              <input v-model="editForm.year" type="number" />
            </div>
            <div class="edit-field">
              <label>License Plate</label>
              <input v-model="editForm.licensePlate" type="text" />
            </div>
          </div>

          <div class="edit-field">
            <label>VIN</label>
            <input v-model="editForm.vin" type="text" />
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Status</label>
              <select v-model="editForm.status">
                <option>Active</option>
                <option>Inactive</option>
                <option>Maintenance</option>
                <option>OOS</option>
              </select>
            </div>
            <div class="edit-field">
              <label>Assigned Driver</label>
              <select v-model="editForm.assignedDriver">
                <option value="">None</option>
                <option v-for="name in driverNames" :key="name" :value="name">{{ name }}</option>
              </select>
            </div>
          </div>

          <div v-if="showOwner" class="edit-field">
            <label>Owner (Investor)</label>
            <select v-model="editForm.ownerId">
              <option :value="0">Unassigned</option>
              <option v-for="inv in investorUsers" :key="inv.id" :value="inv.id">{{ inv.username }}</option>
            </select>
          </div>

          <div class="edit-field">
            <label>Notes</label>
            <textarea v-model="editForm.notes" rows="2"></textarea>
          </div>

          <div class="edit-field">
            <label>Truck Photo</label>
            <input type="file" accept="image/*" @change="onEditPhoto" style="font-size:0.8rem;" />
            <img v-if="editForm.photo" :src="editForm.photo" style="max-height:80px;border-radius:6px;margin-top:0.4rem;" />
          </div>

          <details style="margin-bottom:0.75rem;" open>
            <summary style="font-size:0.72rem;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.04em;cursor:pointer;margin-bottom:0.5rem;">Business Configuration</summary>
            <div class="edit-row">
              <div class="edit-field">
                <label>Purchase Price ($)</label>
                <input v-model.number="editForm.purchasePrice" type="number" min="0" />
              </div>
              <div class="edit-field">
                <label>Title Status</label>
                <select v-model="editForm.titleStatus" style="width:100%;padding:0.4rem 0.5rem;border:1px solid var(--border);border-radius:6px;font-size:0.82rem;">
                  <option value="Clean">Clean</option>
                  <option value="Lien">Lien</option>
                </select>
              </div>
            </div>
            <div class="edit-row">
              <div class="edit-field">
                <label>Maintenance Fund ($/mo)</label>
                <input v-model.number="editForm.maintenanceFundMonthly" type="number" min="0" />
              </div>
              <div class="edit-field">
                <label>Driver Pay ($/day)</label>
                <input v-model.number="editForm.driverPayDaily" type="number" min="0" />
              </div>
            </div>
            <div class="edit-row">
              <div class="edit-field">
                <label>Insurance ($/mo)</label>
                <input v-model.number="editForm.insuranceMonthly" type="number" min="0" />
              </div>
              <div class="edit-field">
                <label>ELD ($/mo)</label>
                <input v-model.number="editForm.eldMonthly" type="number" min="0" />
              </div>
            </div>
            <div class="edit-row">
              <div class="edit-field">
                <label>HVUT ($/yr)</label>
                <input v-model.number="editForm.hvutAnnual" type="number" min="0" />
              </div>
              <div class="edit-field">
                <label>IRP ($/yr)</label>
                <input v-model.number="editForm.irpAnnual" type="number" min="0" />
              </div>
            </div>
            <div class="edit-field">
              <label>Admin Fee (%)</label>
              <input v-model.number="editForm.adminFeePct" type="number" min="0" max="100" />
            </div>
          </details>

          <div class="confirm-actions">
            <button class="btn btn-secondary" @click="showEdit = false">Cancel</button>
            <button class="btn btn-primary" @click="handleSaveEdit">Save</button>
          </div>
        </div>
      </div>
    </Teleport>

    <ConfirmModal
      :open="showConfirm"
      title="Delete Truck"
      :message="`Delete truck '${pendingTruck?.UnitNumber || ''}'? This action cannot be undone.`"
      confirm-text="Delete"
      :danger="true"
      @confirm="handleConfirmDelete"
      @cancel="showConfirm = false"
    />

    <!-- View Truck Detail Modal -->
    <Teleport to="body">
    <div v-if="viewTruck" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:9999" @click.self="viewTruck = null">
      <div style="background:#fff;border-radius:12px;padding:1.5rem;max-width:700px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 25px 50px rgba(0,0,0,0.2)">
        <h3 style="margin-bottom:1rem;">{{ viewTruck.UnitNumber }} — {{ [viewTruck.Make, viewTruck.Model].filter(Boolean).join(' ') }}</h3>
        <div class="view-grid">
          <div class="view-row"><span class="view-label">Year</span><span>{{ viewTruck.Year || '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">VIN</span><span>{{ viewTruck.VIN || '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">License Plate</span><span>{{ viewTruck.LicensePlate || '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Status</span><span :class="['status-badge', statusClass(viewTruck.Status)]">{{ viewTruck.Status }}</span></div>
          <div class="view-row"><span class="view-label">Assigned Driver</span><span>{{ viewTruck.AssignedDriver || '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Completed Loads</span><span>{{ viewTruck.LoadCount ?? 0 }}</span></div>
          <div v-if="showOwner" class="view-row"><span class="view-label">Owner</span><span>{{ ownerName(viewTruck.OwnerId) }}</span></div>
          <div class="view-row"><span class="view-label">Purchase Price</span><span>{{ viewTruck.PurchasePrice ? '$' + Number(viewTruck.PurchasePrice).toLocaleString() : '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Title Status</span><span>{{ viewTruck.TitleStatus || '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Maintenance Fund</span><span>{{ viewTruck.MaintenanceFundMonthly ? '$' + viewTruck.MaintenanceFundMonthly + '/mo' : '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Insurance</span><span>{{ viewTruck.InsuranceMonthly ? '$' + viewTruck.InsuranceMonthly + '/mo' : '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">ELD</span><span>{{ viewTruck.EldMonthly ? '$' + viewTruck.EldMonthly + '/mo' : '\u2014' }}</span></div>
          <div class="view-row"><span class="view-label">Driver Pay</span><span>{{ viewTruck.DriverPayDaily ? '$' + viewTruck.DriverPayDaily + '/day' : '\u2014' }}</span></div>
        </div>
        <!-- Driver Files — files belonging to the driver assigned to this truck -->
        <div v-if="viewTruck.AssignedDriver" class="driver-files-section">
          <div class="driver-files-title">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            Driver Files — {{ viewTruck.AssignedDriver }}
          </div>
          <div v-if="driverFilesLoading" class="driver-files-empty">Loading...</div>
          <div v-else-if="driverFilesError" class="driver-files-error">
            <span class="warning-dot">&#9888;</span> {{ driverFilesError }}
          </div>
          <template v-else>
            <!-- Images group (JPG / PNG uploads like CDL / Medical photos) -->
            <div v-if="driverFilesByType.image.length" class="driver-files-subsection">
              <div class="driver-files-sublabel">
                <svg class="type-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                Images ({{ driverFilesByType.image.length }})
              </div>
              <div class="driver-files-grid">
                <a v-for="(f, i) in driverFilesByType.image" :key="'img'+i" :href="f.url" :download="f.downloadName" target="_blank" rel="noopener" class="driver-file-card">
                  <div class="driver-file-thumb" :style="{ backgroundImage: `url(${f.url})` }"></div>
                  <div class="driver-file-label">{{ f.label }}</div>
                  <div class="driver-file-type">{{ f.meta }}</div>
                </a>
              </div>
            </div>

            <!-- PDF Documents group -->
            <div v-if="driverFilesByType.pdf.length" class="driver-files-subsection">
              <div class="driver-files-sublabel">
                <svg class="type-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                PDF Documents ({{ driverFilesByType.pdf.length }})
              </div>
              <div class="driver-files-grid">
                <a v-for="(f, i) in driverFilesByType.pdf" :key="'pdf'+i" :href="f.url" :download="f.downloadName" target="_blank" rel="noopener" class="driver-file-card">
                  <div class="driver-file-thumb pdf">
                    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                  </div>
                  <div class="driver-file-label">{{ f.label }}</div>
                  <div class="driver-file-type" :class="f.metaClass">{{ f.meta }}</div>
                </a>
              </div>
            </div>

            <div v-if="!driverFilesByType.image.length && !driverFilesByType.pdf.length" class="driver-files-empty">
              No driver files uploaded yet.
            </div>
          </template>
        </div>

        <div style="margin-top:1.25rem;border-top:1px solid #e5e7eb;padding-top:1rem;">
          <LegalDocumentPortal :truck-id="viewTruck.id" :unit-number="viewTruck.UnitNumber" />
        </div>
        <div style="margin-top:1rem;text-align:right;">
          <button class="btn btn-secondary" @click="viewTruck = null">Close</button>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import EmptyState from '../shared/EmptyState.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'
import LegalDocumentPortal from '../investor/LegalDocumentPortal.vue'
import { useApi } from '../../composables/useApi'

const api = useApi()

const truckMakes = [
  'Freightliner', 'Kenworth', 'Peterbilt', 'Volvo', 'International',
  'Mack', 'Western Star', 'Hino', 'Isuzu', 'Ford', 'Chevrolet',
  'RAM', 'GMC', 'Tesla', 'Nikola', 'Other',
]

const truckModels = {
  Freightliner: ['Cascadia', 'Columbia', 'Coronado', 'M2 106', 'M2 112', '114SD', '122SD'],
  Kenworth: ['T680', 'T880', 'W900', 'W990', 'T270', 'T370', 'T440', 'T470'],
  Peterbilt: ['579', '389', '567', '520', '337', '348', '365', '367'],
  Volvo: ['VNL 760', 'VNL 860', 'VNL 300', 'VNR 300', 'VNR 400', 'VNR 600', 'VHD 300', 'VHD 400'],
  International: ['LT', 'RH', 'HV', 'HX', 'MV', 'CV'],
  Mack: ['Anthem', 'Pinnacle', 'Granite', 'LR', 'MD', 'TerraPro'],
  'Western Star': ['4900', '5700XE', '4700', '49X', '47X'],
  Hino: ['L6', 'L7', 'XL7', 'XL8', '268', '338'],
  Isuzu: ['NRR', 'NQR', 'NPR', 'NPR-HD', 'FTR', 'FVR'],
  Ford: ['F-650', 'F-750', 'F-59'],
  Chevrolet: ['Silverado 4500HD', 'Silverado 5500HD', 'Silverado 6500HD'],
  RAM: ['3500', '4500', '5500'],
  GMC: ['Sierra 3500HD', 'Sierra 4500HD', 'Sierra 5500HD'],
  Tesla: ['Semi'],
  Nikola: ['Tre BEV', 'Tre FCEV', 'Two'],
}

const props = defineProps({
  trucks: { type: Array, default: () => [] },
  driverNames: { type: Array, default: () => [] },
  investorUsers: { type: Array, default: () => [] },
  showOwner: { type: Boolean, default: false },
  canEdit: { type: Boolean, default: false },
})

const emit = defineEmits(['delete', 'update'])

const showConfirm = ref(false)
const pendingTruck = ref(null)
const viewTruck = ref(null)

// Driver files section — fetched when the truck modal opens (keyed by truck.id
// so the watcher only refires when a different truck is selected, never on
// field edits within the same truck).
const driverFiles = ref({ driverName: '', files: [], onboardingDocs: [], drugTest: null })
const driverFilesLoading = ref(false)
const driverFilesError = ref('')
watch(() => viewTruck.value?.id, async (truckId) => {
  driverFiles.value = { driverName: '', files: [], onboardingDocs: [], drugTest: null }
  driverFilesError.value = ''
  if (!truckId) return
  driverFilesLoading.value = true
  try {
    driverFiles.value = await api.get(`/api/trucks/${truckId}/driver-files`)
  } catch (err) {
    driverFilesError.value = err?.message || 'Failed to load driver files.'
    console.error('Driver files load failed:', err)
  } finally {
    driverFilesLoading.value = false
  }
})

// Flatten application uploads + signed onboarding docs + drug test into
// two groups keyed by underlying file type so the modal shows them under
// "Images" and "PDF Documents" rather than by business domain.
const driverFilesByType = computed(() => {
  const image = []
  const pdf = []
  const unit = viewTruck.value?.UnitNumber || 'truck'
  const slug = (s) => (s || '').replace(/\s+/g, '-')
  // Application uploads (CDL front/back, medical card)
  for (const f of driverFiles.value.files || []) {
    if (!f.data) continue
    const entry = {
      label: f.label,
      url: f.data,
      downloadName: `${unit}-${slug(f.label)}.${f.type === 'pdf' ? 'pdf' : 'jpg'}`,
      meta: 'Application upload — click to view',
      metaClass: '',
    }
    if (f.type === 'image') image.push(entry)
    else if (f.type === 'pdf') pdf.push(entry)
  }
  // Signed onboarding docs (always PDFs)
  for (const doc of (driverFiles.value.onboardingDocs || [])) {
    if (!doc.signed || !doc.signed_pdf_url) continue
    pdf.push({
      label: doc.doc_name,
      url: doc.signed_pdf_url,
      downloadName: `${unit}-${slug(doc.doc_name)}.pdf`,
      meta: doc.signed_at ? `Signed ${new Date(doc.signed_at).toLocaleDateString()}` : 'Signed',
      metaClass: '',
    })
  }
  // Drug test
  const dt = driverFiles.value.drugTest
  if (dt && dt.file_url) {
    pdf.push({
      label: 'Drug Test Result',
      url: dt.file_url,
      downloadName: `${unit}-drug-test.pdf`,
      meta: (dt.result || '').toUpperCase(),
      metaClass: dt.result === 'pass' ? 'dt-pass' : 'dt-fail',
    })
  }
  return { image, pdf }
})

const editModelOptions = computed(() => truckModels[editForm.make] || [])

const showEdit = ref(false)
const editForm = reactive({
  id: null, unitNumber: '', make: '', model: '', year: 0,
  vin: '', licensePlate: '', status: 'Active', assignedDriver: '', ownerId: 0, notes: '',
  photo: '', insuranceMonthly: 0, eldMonthly: 0, hvutAnnual: 0, irpAnnual: 0, adminFeePct: 50, driverPayDaily: 0,
  purchasePrice: 0, titleStatus: 'Clean', maintenanceFundMonthly: 0,
})

function openEdit(truck) {
  editForm.id = truck.id
  editForm.unitNumber = truck.UnitNumber
  editForm.make = truck.Make || ''
  editForm.model = truck.Model || ''
  editForm.year = truck.Year || ''
  editForm.vin = truck.VIN || ''
  editForm.licensePlate = truck.LicensePlate || ''
  editForm.status = truck.Status
  editForm.assignedDriver = truck.AssignedDriver || ''
  editForm.ownerId = truck.OwnerId || 0
  editForm.notes = truck.Notes || ''
  editForm.photo = truck.Photo || ''
  editForm.insuranceMonthly = truck.InsuranceMonthly || 0
  editForm.eldMonthly = truck.EldMonthly || 0
  editForm.hvutAnnual = truck.HvutAnnual || 0
  editForm.irpAnnual = truck.IrpAnnual || 0
  editForm.adminFeePct = truck.AdminFeePct ?? 50
  editForm.driverPayDaily = truck.DriverPayDaily || 0
  editForm.purchasePrice = truck.PurchasePrice || 0
  editForm.titleStatus = truck.TitleStatus || 'Clean'
  editForm.maintenanceFundMonthly = truck.MaintenanceFundMonthly || 0
  showEdit.value = true
}

function onEditPhoto(e) {
  const file = e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = ev => { editForm.photo = ev.target.result }
  reader.readAsDataURL(file)
}

function handleSaveEdit() {
  emit('update', {
    id: editForm.id,
    data: {
      unitNumber: editForm.unitNumber,
      make: editForm.make,
      model: editForm.model,
      year: editForm.year,
      vin: editForm.vin,
      licensePlate: editForm.licensePlate,
      status: editForm.status,
      assignedDriver: editForm.assignedDriver,
      ownerId: editForm.ownerId,
      notes: editForm.notes,
      photo: editForm.photo,
      insuranceMonthly: editForm.insuranceMonthly,
      eldMonthly: editForm.eldMonthly,
      hvutAnnual: editForm.hvutAnnual,
      irpAnnual: editForm.irpAnnual,
      adminFeePct: editForm.adminFeePct,
      driverPayDaily: editForm.driverPayDaily,
      purchasePrice: editForm.purchasePrice,
      titleStatus: editForm.titleStatus,
      maintenanceFundMonthly: editForm.maintenanceFundMonthly,
    },
  })
  showEdit.value = false
}

function ownerName(ownerId) {
  if (!ownerId) return '\u2014'
  const inv = props.investorUsers.find(i => i.id === ownerId)
  return inv ? (inv.CompanyName || inv.username) : `#${ownerId}`
}

function statusClass(status) {
  if (status === 'Active') return 'status-active'
  if (status === 'Inactive') return 'status-inactive'
  if (status === 'OOS') return 'status-oos'
  return 'status-maintenance'
}

function confirmDelete(truck) {
  pendingTruck.value = truck
  showConfirm.value = true
}

function handleConfirmDelete() {
  if (pendingTruck.value) emit('delete', pendingTruck.value.id)
  showConfirm.value = false
  pendingTruck.value = null
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

.truck-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.82rem; margin-top: 0.5rem;
}
.truck-table th {
  text-align: left; padding: 0.6rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.truck-table td {
  padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.truck-table tbody tr { transition: background 0.1s; }
.truck-table tbody tr:hover { background: var(--bg); }
.truck-table tbody tr:last-child td { border-bottom: none; }

.unit-number {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}
.vin-cell {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--text-dim);
}

.status-badge {
  display: inline-flex; align-items: center;
  padding: 0.2rem 0.6rem; border-radius: 12px;
  font-size: 0.68rem; font-weight: 600;
  font-family: 'JetBrains Mono', monospace; letter-spacing: 0.02em;
}
.status-active { background: var(--accent-dim); color: var(--accent); }
.status-inactive { background: var(--bg); color: var(--text-dim); }
.status-maintenance { background: var(--amber-dim); color: var(--amber); }
.status-oos { background: var(--danger-dim); color: var(--danger); }

.action-btns { display: flex; gap: 0.35rem; justify-content: flex-end; }

.btn-edit, .btn-remove {
  padding: 0.3rem 0.65rem; font-size: 0.7rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--surface);
  cursor: pointer; font-family: inherit; font-weight: 500;
  color: var(--text-dim); transition: all 0.15s;
}
.btn-edit:hover { background: var(--blue-dim); color: var(--blue); border-color: var(--blue-dim); }
.btn-remove:hover { background: var(--danger-dim); color: var(--danger); border-color: var(--danger-dim); }

/* Edit modal */
.confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}
.confirm-dialog {
  background: var(--surface); border-radius: var(--radius);
  padding: 1.5rem; max-width: 500px; width: 90%;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  max-height: 90vh; overflow-y: auto;
}
.confirm-dialog h3 { font-size: 1rem; margin-bottom: 1rem; }
.confirm-actions {
  display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem;
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
.edit-field input:focus,
.edit-field textarea:focus {
  outline: none; border-color: var(--blue);
}
.clickable-row { cursor: pointer; }
.clickable-row:hover td { background: var(--accent-dim, #f0f9ff); }
.view-grid { display: flex; flex-direction: column; gap: 0.4rem; }
.view-row { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #f1f5f9; font-size: 0.85rem; }
.view-label { font-weight: 600; color: var(--text-dim); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }

/* Driver Files section in the truck detail modal */
.driver-files-section { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; }
.driver-files-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.82rem; font-weight: 700; color: #0f172a;
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.75rem;
}
.driver-files-title svg { color: #3b82f6; }
.driver-files-sublabel {
  font-size: 0.68rem; font-weight: 700; color: #64748b;
  text-transform: uppercase; letter-spacing: 0.05em;
  margin: 0.85rem 0 0.5rem;
  display: flex; align-items: center; gap: 0.4rem;
}
.driver-files-sublabel .type-icon { color: #3b82f6; }
.driver-files-subsection { margin-top: 0.5rem; }
.driver-files-empty { font-size: 0.82rem; color: #94a3b8; font-style: italic; padding: 0.75rem 0; }
.driver-files-error {
  font-size: 0.82rem; color: #b45309;
  background: #fffbeb; border: 1px solid #fde68a;
  border-radius: 6px; padding: 0.6rem 0.75rem; margin: 0.4rem 0;
  display: flex; align-items: center; gap: 0.5rem;
}
.driver-files-error .warning-dot { font-size: 1rem; }
.driver-files-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 0.65rem;
}
.driver-file-card {
  display: block; text-decoration: none; color: inherit;
  background: #fafbfd; border: 1px solid #e2e8f0; border-radius: 8px;
  padding: 0.6rem; transition: all 0.15s;
}
.driver-file-card:hover {
  border-color: #3b82f6; background: #f0f9ff;
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.08);
}
.driver-file-thumb {
  width: 100%; height: 100px; border-radius: 6px;
  background-color: #e2e8f0; background-size: cover; background-position: center;
  display: flex; align-items: center; justify-content: center;
  color: #64748b; margin-bottom: 0.5rem;
}
.driver-file-thumb.pdf { background-color: #fef2f2; color: #dc2626; }
.driver-file-thumb svg { display: block; }
.driver-file-label { font-size: 0.78rem; font-weight: 600; color: #0f172a; margin-bottom: 0.15rem; }
.driver-file-type { font-size: 0.68rem; color: #94a3b8; font-family: 'JetBrains Mono', monospace; }
.driver-file-type.dt-pass { color: #16a34a; font-weight: 700; }
.driver-file-type.dt-fail { color: #dc2626; font-weight: 700; }
</style>
