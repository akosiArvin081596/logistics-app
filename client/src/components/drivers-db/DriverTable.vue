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
          <th>Carrier</th>
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
          <td>{{ d[h.carrier] || '\u2014' }}</td>
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
      <div v-if="viewDrv" class="confirm-overlay" @click.self="viewDrv = null">
        <div class="confirm-box" style="max-width:600px;max-height:85vh;overflow-y:auto;">
          <h3 style="margin-bottom:1rem;">{{ viewDrv[h.driver] }}</h3>
          <div class="view-grid">
            <div v-for="col in headers" :key="col" class="view-row">
              <span class="view-label">{{ col }}</span>
              <span>{{ viewDrv[col] || '\u2014' }}</span>
            </div>
          </div>
          <div style="margin-top:1rem;text-align:right;">
            <button class="btn btn-secondary" @click="viewDrv = null">Close</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEdit" class="confirm-overlay" @click.self="showEdit = false">
        <div class="confirm-dialog edit-dialog">
          <h3>Edit Driver &mdash; {{ editForm.driver }}</h3>

          <div class="edit-row">
            <div class="edit-field">
              <label>Driver Name</label>
              <input v-model="editForm.driver" type="text" />
            </div>
            <div class="edit-field">
              <label>Carrier Name</label>
              <select v-model="editForm.carrierName">
                <option value="">-- Select --</option>
                <option v-for="name in carrierNames" :key="name" :value="name">{{ name }}</option>
              </select>
            </div>
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
import { ref, reactive, computed } from 'vue'
import EmptyState from '../shared/EmptyState.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'
import StarRating from '../shared/StarRating.vue'

const props = defineProps({
  drivers: { type: Array, default: () => [] },
  headers: { type: Array, default: () => [] },
  carrierNames: { type: Array, default: () => [] },
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

const emit = defineEmits(['delete', 'update'])

const viewDrv = ref(null)
const showConfirm = ref(false)
const pendingDrv = ref(null)
const showEdit = ref(false)
const editRowIndex = ref(null)

const h = computed(() => {
  const hd = props.headers
  const find = (re) => hd.find(c => re.test(c)) || ''
  return {
    driver: find(/^driver$/i),
    carrier: find(/carrier/i),
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

const editForm = reactive({
  driver: '', carrierName: '', state: '', city: '', zip: '', address: '',
  trucks: '', hazmat: 'NO', phone: '', cell: '', email: '',
  dot: '', mc: '', rating: 'Not Rated',
})

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
  editForm.carrierName = d[h.value.carrier] || ''
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
  showEdit.value = true
}

function handleSaveEdit() {
  emit('update', {
    rowIndex: editRowIndex.value,
    values: [
      editForm.driver, editForm.carrierName, editForm.state, editForm.city,
      editForm.zip, editForm.address, editForm.trucks, editForm.hazmat,
      editForm.phone, editForm.cell, editForm.email,
      editForm.dot, editForm.mc, editForm.rating,
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
.view-grid { display: flex; flex-direction: column; gap: 0.4rem; }
.view-row { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #f1f5f9; font-size: 0.85rem; }
.view-label { font-weight: 600; color: var(--text-dim); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
</style>
