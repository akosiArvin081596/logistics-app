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
          <th>Investor Name</th>
          <th>Carrier Name</th>
          <th>Linked Account</th>
          <th>Trucks</th>
          <th>Status</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="inv in investors" :key="inv.id">
          <td class="name-cell">{{ inv.fullName }}</td>
          <td>{{ inv.carrierName || '\u2014' }}</td>
          <td>{{ inv.username || '\u2014' }}</td>
          <td class="mono">{{ inv.truckCount }}</td>
          <td>
            <span :class="['status-badge', inv.status === 'Active' ? 'status-active' : 'status-inactive']">{{ inv.status }}</span>
          </td>
          <td class="notes-cell">{{ inv.notes || '\u2014' }}</td>
          <td style="text-align:right;">
            <div class="action-btns">
              <button class="btn-edit" @click="openEdit(inv)">Edit</button>
              <button class="btn-remove" @click="confirmDelete(inv)">Remove</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEdit" class="confirm-overlay" @click.self="showEdit = false">
        <div class="confirm-dialog">
          <h3>Edit Investor &mdash; {{ editForm.fullName }}</h3>

          <div class="edit-row">
            <div class="edit-field">
              <label>Investor Name</label>
              <input v-model="editForm.fullName" type="text" />
            </div>
            <div class="edit-field">
              <label>Carrier Name</label>
              <select v-model="editForm.carrierName">
                <option value="">-- Select carrier --</option>
                <option v-for="name in carrierNames" :key="name" :value="name">{{ name }}</option>
              </select>
            </div>
          </div>

          <div class="edit-row">
            <div class="edit-field">
              <label>Linked User Account</label>
              <select v-model="editForm.userId">
                <option :value="null">-- None --</option>
                <option v-for="u in investorUsers" :key="u.id" :value="u.id">{{ u.username }}</option>
              </select>
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

defineProps({
  investors: { type: Array, default: () => [] },
  investorUsers: { type: Array, default: () => [] },
  carrierNames: { type: Array, default: () => [] },
})

const emit = defineEmits(['delete', 'update'])

const showConfirm = ref(false)
const pendingInv = ref(null)
const showEdit = ref(false)
const editForm = reactive({
  id: null, fullName: '', carrierName: '', status: 'Active', userId: null, notes: '',
})

function openEdit(inv) {
  editForm.id = inv.id
  editForm.fullName = inv.fullName
  editForm.carrierName = inv.carrierName
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
.notes-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-size: 0.78rem; }

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
</style>
