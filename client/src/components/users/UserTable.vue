<template>
  <div class="card">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--blue);"></div>
      Team Members
    </div>

    <EmptyState v-if="users.length === 0">No users yet.</EmptyState>

    <!-- .table-wrapper (shared.css) is overflow-x:auto. Without it this table
         is CLIPPED on phones, not scrollable, because .admin-page sets
         overflow-x:hidden — and "Last Sign-In" makes it a 9-column table. -->
    <div v-else class="table-wrapper">
    <table class="user-table">
      <thead>
        <tr>
          <th>User</th>
          <th>Username</th>
          <th>Role</th>
          <th>Full Name</th>
          <th>Details</th>
          <th>Email</th>
          <th>Created</th>
          <th>Last Sign-In</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in users" :key="user.id">
          <td>
            <span :class="['user-avatar', avatarClass(user.Role)]">{{ initials(user.FullName || user.Username) }}</span>
            {{ user.FullName || user.Username || '' }}
          </td>
          <td class="mono" style="font-size:0.8rem;color:var(--text-dim);">{{ user.Username || '' }}</td>
          <td>
            <span :class="['role-badge', roleClass(user.Role)]">{{ user.Role || '' }}</span>
            <span v-if="user.OnboardingStatus && user.OnboardingStatus !== 'fully_onboarded'" class="onboarding-badge">Onboarding</span>
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
          <td class="created-at">
            {{ formatDate(user.CreatedAt) }}
          </td>
          <td :class="['created-at', { 'never-signed-in': !user.LastLoginAt }]" :title="lastLoginTitle(user.LastLoginAt)">
            {{ formatLastLogin(user.LastLoginAt) }}
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
    </div>

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
// Shared Houston-zoned instant formatter — already pins output to
// America/Chicago with a zone label and guards against bare wall-clock input,
// so this column does not hand-roll a fourth copy of that option bag.
import { fmtTimestamp } from '@/utils/datetime'

defineProps({
  users: { type: Array, default: () => [] },
  driverNames: { type: Array, default: () => [] },
})

const emit = defineEmits(['delete', 'update', 'rate'])

const showConfirm = ref(false)
const pendingUser = ref(null)

const showEdit = ref(false)
const editForm = reactive({ id: null, username: '', role: '', driverName: '', email: '', password: '', fullName: '' })

function openEdit(user) {
  editForm.id = user.id
  editForm.username = user.Username
  editForm.role = user.Role
  editForm.driverName = user.DriverName || ''
  editForm.email = user.Email || ''
  editForm.fullName = user.FullName || ''
  editForm.password = ''
  showEdit.value = true
}

function handleSaveEdit() {
  const data = {
    role: editForm.role,
    driverName: editForm.driverName,
    email: editForm.email,
    fullName: editForm.fullName,
  }
  if (editForm.password) data.password = editForm.password
  emit('update', { id: editForm.id, data })
  showEdit.value = false
}

function userDetail(user) {
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

// `user.CreatedAt` is a true instant \u2014 /api/users emits it as ISO-Z
// (strftime('%Y-%m-%dT%H:%M:%SZ', u.created_at)). Houston rule: render in
// America/Chicago with a visible zone label so the "Created" column shows the
// Houston calendar day rather than the viewer's.
function formatDate(dateStr) {
  if (!dateStr) return '\u2014'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    timeZone: 'America/Chicago', timeZoneName: 'short',
  })
}

// "Last Sign-In". Hybrid on purpose, matching AdminToolsView's formatRmTs and
// DriverPayOverridesView's formatTs: relative while the answer is "recently",
// absolute once "11d ago" stops being easier to read than the date. The house
// default on admin screens is absolute (see the note in NotificationsView), so
// the relative window is kept short.
//
// The question this column answers is "is this account still in use?", so an
// empty value is a real answer, not missing data — it renders "Never" rather
// than the em dash the other columns use for a blank field.
//
// ⚠️ Computed at render, so an "8m ago" left open on screen goes stale. That is
// fine here: the page refetches on the users:changed socket event, and no
// decision rests on the minute. Do NOT add a ticking `now` ref for this.
function formatLastLogin(v) {
  if (!v) return 'Never'
  const t = new Date(v).getTime()
  if (!Number.isFinite(t)) return 'Never'

  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 0) return fmtTimestamp(v)   // clock skew — don't print "-3m ago"
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return fmtTimestamp(v)
}

// The exact instant is always one hover away, even while the cell shows "3h ago".
function lastLoginTitle(v) {
  return v ? fmtTimestamp(v) : 'Has not signed in since sign-in tracking was added'
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

.onboarding-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.5rem;
  border-radius: 12px;
  font-size: 0.62rem;
  font-weight: 600;
  background: #fef3c7;
  color: #92400e;
  margin-left: 0.3rem;
  white-space: nowrap;
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
  white-space: nowrap;
}

/* "Never" is a real answer (this account has not signed in), not missing data —
   but it should read as quieter than a genuine timestamp, not louder. */
.never-signed-in {
  font-style: italic;
  opacity: 0.65;
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
