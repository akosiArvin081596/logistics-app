<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--blue);"></div>
      Team Members
    </div>

    <EmptyState v-if="users.length === 0">No users yet.</EmptyState>

    <table v-else class="user-table">
      <thead>
        <tr>
          <th>User</th>
          <th>Role</th>
          <th>Full Name</th>
          <th>Details</th>
          <th>Email</th>
          <th>Rating</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in users" :key="user.id">
          <td>
            <span :class="['user-avatar', avatarClass(user.Role)]">{{ initials(user.Username) }}</span>
            {{ user.Username || '' }}
          </td>
          <td>
            <span :class="['role-badge', roleClass(user.Role)]">{{ user.Role || '' }}</span>
          </td>
          <td :style="{ color: user.FullName ? 'var(--text)' : 'var(--text-dim)' }">
            {{ user.FullName || '\u2014' }}
          </td>
          <td :style="{ color: userDetail(user) !== '\u2014' ? 'var(--text)' : 'var(--text-dim)' }">
            {{ userDetail(user) }}
          </td>
          <td :style="{ color: user.Email ? 'var(--text)' : 'var(--text-dim)' }">
            {{ user.Email || '\u2014' }}
          </td>
          <td>
            <div v-if="user.Role === 'Driver'" class="star-rating">
              <span v-for="s in 5" :key="s" class="star" :class="{ filled: s <= (user.Rating || 0), clickable: true }" @click="$emit('rate', user.id, s)">&#9733;</span>
            </div>
            <span v-else style="color:var(--text-dim);">&mdash;</span>
          </td>
          <td class="created-at">
            {{ formatDate(user.CreatedAt) }}
          </td>
          <td style="text-align: right;">
            <div class="action-btns">
              <button class="btn-edit" @click="openEdit(user)">Edit</button>
              <button class="btn-remove" @click="confirmDelete(user)">Remove</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEdit" class="confirm-overlay" @click.self="showEdit = false">
        <div class="confirm-dialog edit-dialog">
          <h3>Edit User &mdash; {{ editForm.username }}</h3>

          <div class="edit-field">
            <label>Role</label>
            <select v-model="editForm.role">
              <option>Super Admin</option>
              <option>Dispatcher</option>
              <option>Driver</option>
              <option>Investor</option>
            </select>
          </div>

          <div class="edit-field">
            <label>Linked Driver</label>
            <select v-model="editForm.driverName">
              <option value="">None</option>
              <option v-for="name in driverNames" :key="name" :value="name">{{ name }}</option>
            </select>
          </div>

          <div class="edit-field">
            <label>Full Name</label>
            <input v-model="editForm.fullName" type="text" placeholder="e.g. John Smith" />
          </div>

          <div class="edit-field">
            <label>Company Name (Carrier)</label>
            <select v-model="editForm.companyName">
              <option value="">-- Select carrier --</option>
              <option v-for="name in carrierNames" :key="name" :value="name">{{ name }}</option>
            </select>
          </div>

          <div class="edit-field">
            <label>Email</label>
            <input v-model="editForm.email" type="email" placeholder="Email" />
          </div>

          <div class="edit-field">
            <label>New Password <span class="hint">(leave blank to keep current)</span></label>
            <input v-model="editForm.password" type="password" placeholder="New password" autocomplete="new-password" />
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
      title="Delete User"
      :message="`Delete user '${pendingUser?.Username || ''}'? This action cannot be undone.`"
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
  users: { type: Array, default: () => [] },
  driverNames: { type: Array, default: () => [] },
  carrierNames: { type: Array, default: () => [] },
})

const emit = defineEmits(['delete', 'update', 'rate'])

const showConfirm = ref(false)
const pendingUser = ref(null)

const showEdit = ref(false)
const editForm = reactive({ id: null, username: '', role: '', driverName: '', email: '', password: '', fullName: '', companyName: '' })

function openEdit(user) {
  editForm.id = user.id
  editForm.username = user.Username
  editForm.role = user.Role
  editForm.driverName = user.DriverName || ''
  editForm.email = user.Email || ''
  editForm.fullName = user.FullName || ''
  editForm.companyName = user.CompanyName || ''
  editForm.password = ''
  showEdit.value = true
}

function handleSaveEdit() {
  const data = {
    role: editForm.role,
    driverName: editForm.driverName,
    email: editForm.email,
    fullName: editForm.fullName,
    companyName: editForm.companyName,
  }
  if (editForm.password) data.password = editForm.password
  emit('update', { id: editForm.id, data })
  showEdit.value = false
}

function userDetail(user) {
  if (user.Role === 'Investor' && user.CompanyName) return user.CompanyName
  if (user.Role === 'Driver' && user.DriverName) return user.DriverName
  return '\u2014'
}

function initials(name) {
  return (name || '?')
    .split(/[\s._-]+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

const roleClassMap = {
  'Super Admin': 'role-super-admin',
  Dispatcher: 'role-dispatcher',
  Driver: 'role-driver',
  Investor: 'role-investor',
}

const avatarClassMap = {
  'Super Admin': 'av-super-admin',
  Dispatcher: 'av-dispatcher',
  Driver: 'av-driver',
  Investor: 'av-investor',
}

function roleClass(role) {
  return roleClassMap[role] || ''
}

function avatarClass(role) {
  return avatarClassMap[role] || 'av-driver'
}

function formatDate(dateStr) {
  if (!dateStr) return '\u2014'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function confirmDelete(user) {
  pendingUser.value = user
  showConfirm.value = true
}

function handleConfirmDelete() {
  if (pendingUser.value) {
    emit('delete', pendingUser.value.id)
  }
  showConfirm.value = false
  pendingUser.value = null
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
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 700;
  font-size: 0.88rem;
  margin-bottom: 1rem;
}

.section-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.user-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.82rem;
  margin-top: 0.5rem;
}

.user-table th {
  text-align: left;
  padding: 0.6rem 0.5rem;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 2px solid var(--border);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.user-table td {
  padding: 0.65rem 0.5rem;
  border-bottom: 1px solid var(--bg);
  vertical-align: middle;
}

.user-table tbody tr {
  transition: background 0.1s;
}

.user-table tbody tr:hover {
  background: var(--bg);
}

.user-table tbody tr:last-child td {
  border-bottom: none;
}

.user-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 700;
  margin-right: 0.5rem;
  vertical-align: middle;
}

.user-avatar.av-super-admin {
  background: var(--danger-dim);
  color: var(--danger);
}

.user-avatar.av-dispatcher {
  background: var(--blue-dim);
  color: var(--blue);
}

.user-avatar.av-driver {
  background: var(--accent-dim);
  color: var(--accent);
}

.user-avatar.av-investor {
  background: var(--amber-dim);
  color: var(--amber);
}

.role-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.6rem;
  border-radius: 12px;
  font-size: 0.68rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.02em;
}

.role-super-admin {
  background: var(--danger-dim);
  color: var(--danger);
}

.role-dispatcher {
  background: var(--blue-dim);
  color: var(--blue);
}

.role-driver {
  background: var(--accent-dim);
  color: var(--accent);
}

.role-investor {
  background: var(--amber-dim);
  color: var(--amber);
}

.created-at {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--text-dim);
}

.btn-remove {
  padding: 0.3rem 0.65rem;
  font-size: 0.7rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  font-family: inherit;
  font-weight: 500;
  color: var(--text-dim);
  transition: all 0.15s;
}

.btn-remove:hover {
  background: var(--danger-dim);
  color: var(--danger);
  border-color: var(--danger-dim);
}

.action-btns {
  display: flex;
  gap: 0.35rem;
  justify-content: flex-end;
}

.btn-edit {
  padding: 0.3rem 0.65rem;
  font-size: 0.7rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  font-family: inherit;
  font-weight: 500;
  color: var(--text-dim);
  transition: all 0.15s;
}

.btn-edit:hover {
  background: var(--blue-dim);
  color: var(--blue);
  border-color: var(--blue-dim);
}

/* Edit modal */
.confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}

.confirm-dialog {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 1.5rem;
  max-width: 420px;
  width: 90%;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
}

.confirm-dialog h3 {
  font-size: 1rem;
  margin-bottom: 1rem;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.25rem;
}

.edit-field {
  margin-bottom: 0.75rem;
}

.edit-field label {
  display: block;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.3rem;
}

.edit-field .hint {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  font-size: 0.68rem;
}

.edit-field select,
.edit-field input {
  width: 100%;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.82rem;
  background: var(--bg);
  color: var(--text);
}

.edit-field select:focus,
.edit-field input:focus {
  outline: none;
  border-color: var(--blue);
}
.star-rating { display: flex; gap: 1px; }
.star { font-size: 1.1rem; color: #d1d5db; transition: color 0.1s; }
.star.filled { color: #f59e0b; }
.star.clickable { cursor: pointer; }
.star.clickable:hover { color: #fbbf24; }
</style>
