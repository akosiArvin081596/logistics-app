<template>
  <div class="users-page">
    <div class="page-header">
      <h2>User Management</h2>
    </div>

    <AddUserForm :driver-names="store.driverNames" @submit="handleAddUser" />

    <template v-if="store.isLoading">
      <SkeletonLoader :rows="4" :cols="5" />
    </template>
    <template v-else>
      <UserTable :users="store.users" @delete="handleDeleteUser" />
    </template>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useUsersStore } from '../stores/users'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import AddUserForm from '../components/users/AddUserForm.vue'
import UserTable from '../components/users/UserTable.vue'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'

const store = useUsersStore()
const authStore = useAuthStore()
const { show: toast } = useToast()

async function handleAddUser(userData) {
  try {
    await store.addUser(userData)
    toast('User created')
  } catch (err) {
    toast(err.message || 'Failed to create user', 'error')
  }
}

async function handleDeleteUser(id) {
  try {
    await store.deleteUser(id)
    toast('User deleted')
  } catch {
    toast('Failed to delete user', 'error')
  }
}

onMounted(() => {
  store.loadUsers()
  store.loadDriverNames()
})
</script>

<style scoped>
.users-page {
  max-width: 900px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.page-header h2 {
  font-size: 1.35rem;
}
</style>
