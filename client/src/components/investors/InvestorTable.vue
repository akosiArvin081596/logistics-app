<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--blue);"></div>
      Investor Directory
    </div>

    <EmptyState v-if="investors.length === 0">No investors yet.</EmptyState>

    <table v-else class="inv-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Company</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Location</th>
          <th>Split</th>
          <th>Trucks</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="inv in investors" :key="inv.id" class="clickable-row" @click="viewInv = inv">
          <td class="name-cell">{{ inv.fullName }}</td>
          <td>{{ inv.companyName || '\u2014' }}</td>
          <td>{{ inv.email || '\u2014' }}</td>
          <td>{{ inv.phone || '\u2014' }}</td>
          <td>{{ locationStr(inv) }}</td>
          <td class="mono">{{ inv.splitPct }}%</td>
          <td class="mono">{{ inv.truckCount }}</td>
          <td>
            <span :class="['status-badge', inv.status === 'Active' ? 'status-active' : 'status-inactive']">{{ inv.status }}</span>
          </td>
          <td style="text-align:right;" @click.stop>
            <div class="action-btns">
              <button class="btn-edit" @click="openEdit(inv)">Edit</button>
              <button class="btn-remove" @click="confirmDelete(inv)">Remove</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- View Detail Modal -->
    <Teleport to="body">
      <div v-if="viewInv" class="confirm-overlay" @click.self="viewInv = null">
        <div class="confirm-box" style="max-width:600px;max-height:85vh;overflow-y:auto;">
          <h3 style="margin-bottom:1rem;">{{ viewInv.fullName }}</h3>
          <div class="view-grid">
            <div class="view-row"><span class="view-label">Company</span><span>{{ viewInv.companyName || '\u2014' }}</span></div>
            <div class="view-row"><span class="view-label">Email</span><span>{{ viewInv.email || '\u2014' }}</span></div>
            <div class="view-row"><span class="view-label">Phone</span><span>{{ viewInv.phone || '\u2014' }}</span></div>
            <div class="view-row"><span class="view-label">Address</span><span>{{ fullAddress(viewInv) }}</span></div>
            <div class="view-row"><span class="view-label">Tax ID / EIN</span><span>{{ viewInv.taxId || '\u2014' }}</span></div>
            <div class="view-row"><span class="view-label">Split %</span><span>{{ viewInv.splitPct }}%</span></div>
            <div class="view-row"><span class="view-label">Linked Account</span><span>{{ viewInv.username || '\u2014' }}</span></div>
            <div class="view-row"><span class="view-label">Status</span><span :class="['status-badge', viewInv.status === 'Active' ? 'status-active' : 'status-inactive']">{{ viewInv.status }}</span></div>
            <div class="view-row"><span class="view-label">Trucks</span><span>{{ viewInv.truckCount }}</span></div>
            <div v-if="viewInv.notes" class="view-row"><span class="view-label">Notes</span><span>{{ viewInv.notes }}</span></div>
          </div>
          <div style="margin-top:1rem;text-align:right;">
            <button class="btn btn-secondary" @click="viewInv = null">Close</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEdit" class="confirm-overlay" @click.self="showEdit = false">
        <div class="confirm-dialog edit-dialog">
          <h3>Edit Investor &mdash; {{ editForm.fullName }}</h3>

          <div class="edit-row">
            <div class="edit-field">
              <label>Full Name</label>
              <input v-model="editForm.fullName" type="text" />
            </div>
            <div class="edit-field">
              <label>Company Name</label>
              <input v-model="editForm.companyName" type="text" />
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Email</label>
              <input v-model="editForm.email" type="email" />
            </div>
            <div class="edit-field">
              <label>Phone</label>
              <input v-model="editForm.phone" type="tel" />
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
              <label>Tax ID / EIN</label>
              <input v-model="editForm.taxId" type="text" />
            </div>
            <div class="edit-field">
              <label>Split %</label>
              <input v-model.number="editForm.splitPct" type="number" min="0" max="100" />
            </div>
            <div class="edit-field">
              <label>Status</label>
              <select v-model="editForm.status">
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
          </div>

          <div class="edit-field">
            <label>Linked User Account</label>
            <select v-model="editForm.userId">
              <option :value="null">-- None --</option>
              <option v-for="u in investorUsers" :key="u.id" :value="u.id">{{ u.username }}</option>
            </select>
          </div>

          <div class="edit-field">
            <label>Notes</label>
            <textarea v-model="editForm.notes" rows="2"></textarea>
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
      title="Delete Investor"
      :message="`Delete investor '${pendingInv?.fullName || ''}'? This action cannot be undone.`"
      confirm-text="Delete"
      :danger="true"
      @confirm="handleConfirmDelete"
      @cancel="showConfirm = false"
    />
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import EmptyState from '../shared/EmptyState.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'

const props = defineProps({
  investors: { type: Array, default: () => [] },
  investorUsers: { type: Array, default: () => [] },
})

const emit = defineEmits(['delete', 'update'])

const viewInv = ref(null)
const showConfirm = ref(false)
const pendingInv = ref(null)
const showEdit = ref(false)
const editForm = reactive({
  id: null, fullName: '', companyName: '', email: '', phone: '',
  address: '', city: '', state: '', zip: '',
  taxId: '', splitPct: 50, status: 'Active', userId: null, notes: '',
})

function locationStr(inv) {
  const parts = [inv.city, inv.state].filter(Boolean)
  return parts.length ? parts.join(', ') : '\u2014'
}

function fullAddress(inv) {
  const parts = [inv.address, inv.city, inv.state, inv.zip].filter(Boolean)
  return parts.length ? parts.join(', ') : '\u2014'
}

function openEdit(inv) {
  editForm.id = inv.id
  editForm.fullName = inv.fullName
  editForm.companyName = inv.companyName
  editForm.email = inv.email
  editForm.phone = inv.phone
  editForm.address = inv.address
  editForm.city = inv.city
  editForm.state = inv.state
  editForm.zip = inv.zip
  editForm.taxId = inv.taxId
  editForm.splitPct = inv.splitPct
  editForm.status = inv.status
  editForm.userId = inv.userId
  editForm.notes = inv.notes
  showEdit.value = true
}

function handleSaveEdit() {
  emit('update', { id: editForm.id, data: { ...editForm } })
  showEdit.value = false
}

function confirmDelete(inv) {
  pendingInv.value = inv
  showConfirm.value = true
}

function handleConfirmDelete() {
  if (pendingInv.value) emit('delete', pendingInv.value.id)
  showConfirm.value = false
  pendingInv.value = null
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

.inv-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.82rem; margin-top: 0.5rem;
}
.inv-table th {
  text-align: left; padding: 0.6rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.inv-table td {
  padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.inv-table tbody tr { transition: background 0.1s; }
.inv-table tbody tr:hover { background: var(--bg); }
.inv-table tbody tr:last-child td { border-bottom: none; }

.name-cell { font-weight: 600; }
.mono { font-family: 'JetBrains Mono', monospace; }

.status-badge {
  display: inline-flex; align-items: center;
  padding: 0.2rem 0.6rem; border-radius: 12px;
  font-size: 0.68rem; font-weight: 600;
  font-family: 'JetBrains Mono', monospace; letter-spacing: 0.02em;
}
.status-active { background: var(--accent-dim); color: var(--accent); }
.status-inactive { background: var(--bg); color: var(--text-dim); }

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
.edit-field input:focus,
.edit-field textarea:focus {
  outline: none; border-color: var(--blue);
}

.clickable-row { cursor: pointer; }
.clickable-row:hover td { background: var(--accent-dim, #f0f9ff); }
.view-grid { display: flex; flex-direction: column; gap: 0.4rem; }
.view-row { display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #f1f5f9; font-size: 0.85rem; }
.view-label { font-weight: 600; color: var(--text-dim); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
</style>
