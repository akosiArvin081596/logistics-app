<template>
  <div class="users-page admin-page">
    <div class="page-header">
      <h2>User Management</h2>
    </div>

    <AddUserForm :driver-names="store.driverNames" @submit="handleAddUser" />

    <template v-if="store.isLoading">
      <SkeletonLoader :rows="4" :cols="5" />
    </template>
    <template v-else>
      <UserTable :users="store.users" :driver-names="store.driverNames" @delete="handleDeleteUser" @update="handleUpdateUser" />
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

async function handleUpdateUser({ id, data }) {
  try {
    await store.updateUser(id, data)
    toast('User updated')
  } catch (err) {
    toast(err.message || 'Failed to update user', 'error')
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

