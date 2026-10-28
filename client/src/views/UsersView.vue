<template>
  <div class="users-page admin-page">
    <div class="page-header">
      <h2>User Management</h2>
    </div>

    <!-- KPI Summary -->
    <div class="kpi-grid" style="margin-bottom:1.25rem;">
      <Card v-for="card in kpiCards" :key="card.label" class="kpi-card" :class="card.theme">
        <CardContent class="flex items-center gap-4" style="padding:1rem 1.25rem;">
          <div :class="['kpi-icon', card.iconTheme]" v-html="card.icon"></div>
          <div class="kpi-info">
            <div class="kpi-label">{{ card.label }}</div>
            <div class="kpi-value">{{ card.value }}</div>
            <div class="kpi-sub">{{ card.sub }}</div>
          </div>
        </CardContent>
      </Card>
    </div>

    <details class="form-accordion">
      <summary class="form-toggle">+ Add User</summary>
      <AddUserForm :driver-names="store.availableDriverNames" :create-user="createUser" :staff-must-change-password="store.newStaffMustChangePassword" />
    </details>

    <template v-if="store.isLoading">
      <SkeletonLoader :rows="4" :cols="5" />
    </template>
    <template v-else>
      <PaginationBar :page="page" :page-size="pageSize" :total="store.users.length" :total-pages="totalPages" @go="goTo" @size="setSize" />
      <UserTable :users="paginatedItems" :driver-names="store.driverNames" :save-user="saveUser" @delete="handleDeleteUser" @rate="handleRateUser" />
    </template>
  </div>
</template>

<script setup>
import { onMounted, computed, watch } from 'vue'
import { useUsersStore } from '../stores/users'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import AddUserForm from '../components/users/AddUserForm.vue'
import UserTable from '../components/users/UserTable.vue'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'
import PaginationBar from '../components/shared/PaginationBar.vue'
import { usePagination } from '../composables/usePagination'
import { Card, CardContent } from '@/components/ui/card'

const store = useUsersStore()
const authStore = useAuthStore()
const { show: toast } = useToast()
useSocketRefresh('users:changed', () => store.loadUsers())

const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(computed(() => store.users), 25)
watch(totalPages, (tp) => { if (page.value > tp) goTo(tp) })

const kpiCards = computed(() => {
  const users = store.users
  const drivers = users.filter(u => u.Role === 'Driver').length
  const investors = users.filter(u => u.Role === 'Investor').length
  const admins = users.filter(u => u.Role === 'Super Admin' || u.Role === 'Dispatcher').length
  return [
    { label: 'Total Users',  value: users.length, sub: 'All accounts',          icon: '&#128101;', theme: 'kpi-blue',    iconTheme: 'kpi-icon-blue' },
    { label: 'Drivers',      value: drivers,      sub: 'Driver accounts',       icon: '&#128663;', theme: 'kpi-emerald', iconTheme: 'kpi-icon-emerald' },
    { label: 'Investors',    value: investors,    sub: 'Owner accounts',        icon: '&#128188;', theme: 'kpi-amber',   iconTheme: 'kpi-icon-amber' },
    { label: 'Admin / Ops',  value: admins,       sub: 'Super Admin + Dispatcher', icon: '&#9881;', theme: 'kpi-violet',  iconTheme: 'kpi-icon-violet' },
  ]
})

// Add User waits on this: a refusal rejects, and the form shows the server's
// message and keeps what was typed. Once the server has created the account, a
// failed list reload is a toast, not a failed create (a retry would only find
// the username taken).
async function createUser(data) {
  await store.addUser(data)
  toast('User created')
  store.loadUsers().catch((err) => toast(err.message || 'Failed to reload users', 'error'))
}

// The Edit User dialog waits on this (UserTable's saveUser): a refusal rejects,
// and the dialog shows the server's message inline and stays open. Once the
// server has accepted the edit, a failed list reload is a toast, not a failed save.
async function saveUser({ id, data }) {
  await store.updateUser(id, data)
  toast('User updated')
  store.loadUsers().catch((err) => toast(err.message || 'Failed to reload users', 'error'))
}

async function handleRateUser(id, rating) {
  try {
    await store.rateUser(id, rating)
    toast('Rating updated')
  } catch {
    toast('Failed to rate driver', 'error')
  }
}

async function handleDeleteUser(id) {
  try {
    await store.deleteUser(id)
    toast('User deleted')
  } catch (err) {
    // Surface the server's own words. A delete blocked by the month-end lock
    // returns 409 PERIOD_FINALIZED with the exact rows and periods at stake;
    // collapsing that to "Failed to delete user" is how an admin retries, gives
    // up, and never learns a closed month was the reason.
    toast(err?.message || 'Failed to delete user', 'error')
  }
}

onMounted(() => {
  store.loadUsers()
  store.loadDriverNames()
})
</script>

<style scoped>
.users-page {
  overflow-y: auto;
  padding-bottom: 2rem;
}
</style>

