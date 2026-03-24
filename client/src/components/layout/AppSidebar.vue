<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1><span class="icon">&#11044;</span> LogisX</h1>
      <p class="subtitle">Logistics Management</p>
    </div>
    <div class="sidebar-section">
      <router-link
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        active-class="active"
      >
        <span class="nav-icon" v-html="item.icon"></span>
        {{ item.label }}
      </router-link>
      <div id="sidebarExtra"></div>
    </div>
    <div class="sidebar-footer">
      <a href="#" class="nav-item" style="color:var(--danger);margin-bottom:0.5rem;" @click.prevent="handleLogout">
        <span class="nav-icon">&#10140;</span> Logout
      </a>
      <div class="status-dot">
        <span :class="['dot', isConnected ? 'ok' : 'error']"></span>
        {{ isConnected ? 'Connected' : 'Disconnected' }}
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { useSocket } from '../../composables/useSocket'

const router = useRouter()
const auth = useAuthStore()
const { isConnected, connect } = useSocket()

onMounted(() => connect())

const navConfig = {
  Admin: [
    { to: '/dashboard', icon: '&#9635;', label: 'Dashboard' },
    { to: '/driver', icon: '&#128666;', label: 'Driver App' },
    { to: '/investor', icon: '&#128200;', label: 'Investor View' },
    { to: '/users', icon: '&#9881;', label: 'User Management' },
    { to: '/data', icon: '&#9776;', label: 'Data Manager' },
  ],
  Dispatcher: [
    { to: '/dashboard', icon: '&#9635;', label: 'Dashboard' },
    { to: '/data', icon: '&#9776;', label: 'Data Manager' },
  ],
  Investor: [
    { to: '/investor', icon: '&#128200;', label: 'Financial Overview' },
  ],
  Driver: [],
}

const navItems = computed(() => navConfig[auth.user?.role] || [])

async function handleLogout() {
  await auth.logout()
  router.push('/login')
}
</script>
