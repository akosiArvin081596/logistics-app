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
          <th>Linked Driver</th>
          <th>Email</th>
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
          <td :style="{ color: user.DriverName ? 'var(--text)' : 'var(--text-dim)' }">
            {{ user.DriverName || '\u2014' }}
          </td>
          <td :style="{ color: user.Email ? 'var(--text)' : 'var(--text-dim)' }">
            {{ user.Email || '\u2014' }}
          </td>
          <td class="created-at">
            {{ formatDate(user.created_at) }}
          </td>
          <td style="text-align: right;">
            <button class="btn-remove" @click="confirmDelete(user)">Remove</button>
          </td>
        </tr>
      </tbody>
    </table>

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
import { ref } from 'vue'
import EmptyState from '../shared/EmptyState.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'

defineProps({
  users: { type: Array, default: () => [] },
})

const emit = defineEmits(['delete'])

const showConfirm = ref(false)
const pendingUser = ref(null)

function initials(name) {
  return (name || '?')
    .split(/[\s._-]+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

const roleClassMap = {
  Admin: 'role-admin',
  Dispatcher: 'role-dispatcher',
  Driver: 'role-driver',
  Investor: 'role-investor',
}

const avatarClassMap = {
  Admin: 'av-admin',
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

.user-avatar.av-admin {
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

.role-admin {
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
</style>
