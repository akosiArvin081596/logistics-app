<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1><img src="/logo.avif" alt="LogisX" class="sidebar-logo" /></h1>
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
        <span v-if="item.to === '/notifications' && notifStore.unreadCount > 0" class="nav-badge">{{ notifStore.unreadCount }}</span>
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
import { useDispatchNotificationsStore } from '../../stores/dispatchNotifications'

const router = useRouter()
const auth = useAuthStore()
const { isConnected, connect } = useSocket()
const notifStore = useDispatchNotificationsStore()

onMounted(() => {
  connect()
  if (auth.user?.role === 'Super Admin' || auth.user?.role === 'Dispatcher') {
    notifStore.fetch()
  }
})

const navConfig = {
  'Super Admin': [
    { to: '/dashboard', icon: '&#9635;', label: 'Dashboard' },
    { to: '/tracking', icon: '&#128205;', label: 'Tracking' },
    { to: '/notifications', icon: '&#128276;', label: 'Notifications' },
    { to: '/expenses', icon: '&#128176;', label: 'Expenses' },
    { to: '/messages', icon: '&#128172;', label: 'Messages' },
    { to: '/driver', icon: '&#128666;', label: 'Driver App' },
    { to: '/investor', icon: '&#128200;', label: 'Investor View' },
    { to: '/users', icon: '&#9881;', label: 'User Management' },
    { to: '/admin/tools', icon: '&#128295;', label: 'Data Tools' },
    { to: '/data', icon: '&#9776;', label: 'Data Manager' },
  ],
  Dispatcher: [
    { to: '/dashboard', icon: '&#9635;', label: 'Dashboard' },
    { to: '/tracking', icon: '&#128205;', label: 'Tracking' },
    { to: '/notifications', icon: '&#128276;', label: 'Notifications' },
    { to: '/expenses', icon: '&#128176;', label: 'Expenses' },
    { to: '/messages', icon: '&#128172;', label: 'Messages' },
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

<style scoped>
.nav-badge {
  margin-left: auto;
  background: var(--danger, #ef4444);
  color: #fff;
  font-size: 0.65rem;
  font-weight: 700;
  padding: 0.1rem 0.4rem;
  border-radius: 10px;
  font-family: 'JetBrains Mono', monospace;
  min-width: 18px;
  text-align: center;
}
</style>
