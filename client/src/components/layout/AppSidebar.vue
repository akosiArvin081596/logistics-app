<template>
  <aside :class="['sidebar', { collapsed }]">
    <div class="sidebar-header">
      <h1><img src="/logo.avif" alt="LogisX" class="sidebar-logo" /></h1>
      <p v-show="!collapsed" class="subtitle">Logistics Management</p>
    </div>
    <div class="sidebar-section">
      <router-link
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        active-class="active"
        :title="collapsed ? item.label : ''"
      >
        <span class="nav-icon" v-html="item.icon"></span>
        <span v-show="!collapsed" class="nav-label">{{ item.label }}</span>
        <span v-if="!collapsed && item.to === '/notifications' && notifStore.unreadCount > 0" class="nav-badge">{{ notifStore.unreadCount }}</span>
        <span v-if="collapsed && item.to === '/notifications' && notifStore.unreadCount > 0" class="nav-badge-dot"></span>
      </router-link>
      <div id="sidebarExtra"></div>
    </div>
    <div class="sidebar-footer">
      <a href="#" class="nav-item" style="color:var(--danger);margin-bottom:0.5rem;" @click.prevent="handleLogout" :title="collapsed ? 'Logout' : ''">
        <span class="nav-icon">&#10140;</span> <span v-show="!collapsed">Logout</span>
      </a>
      <div v-show="!collapsed" class="status-dot">
        <span :class="['dot', isConnected ? 'ok' : 'error']"></span>
        {{ isConnected ? 'Connected' : 'Disconnected' }}
      </div>
      <div v-show="collapsed" class="status-dot" style="justify-content:center;">
        <span :class="['dot', isConnected ? 'ok' : 'error']"></span>
      </div>
    </div>
    <button class="collapse-btn" @click="toggle" :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'">
      <span class="collapse-icon" :class="{ flipped: collapsed }">&#9664;</span>
    </button>
  </aside>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { useSocket } from '../../composables/useSocket'
import { useDispatchNotificationsStore } from '../../stores/dispatchNotifications'

const router = useRouter()
const auth = useAuthStore()
const { isConnected, connect } = useSocket()
const notifStore = useDispatchNotificationsStore()

const STORAGE_KEY = 'sidebar-collapsed'
const collapsed = ref(localStorage.getItem(STORAGE_KEY) === '1')

function toggle() {
  collapsed.value = !collapsed.value
  localStorage.setItem(STORAGE_KEY, collapsed.value ? '1' : '0')
}

watch(collapsed, (val) => {
  document.documentElement.style.setProperty('--sidebar-w', val ? '64px' : '240px')
}, { immediate: true })

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
.nav-badge-dot {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger, #ef4444);
}

.nav-label {
  white-space: nowrap;
  overflow: hidden;
}

/* Collapse toggle button */
.collapse-btn {
  position: absolute;
  top: 20px;
  right: -14px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e5e7eb);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 51;
  box-shadow: 0 2px 6px rgba(0,0,0,0.08);
  transition: background 0.15s;
  padding: 0;
}
.collapse-btn:hover {
  background: var(--bg, #f5f6fa);
}
.collapse-icon {
  font-size: 0.6rem;
  color: var(--text-dim, #8b8fa3);
  transition: transform 0.25s ease;
  display: inline-block;
  line-height: 1;
}
.collapse-icon.flipped {
  transform: rotate(180deg);
}

/* Collapsed state overrides */
.sidebar.collapsed {
  width: 64px;
}
.sidebar.collapsed .sidebar-header {
  padding: 1rem 0.5rem 0.75rem;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.sidebar.collapsed .sidebar-header h1 {
  justify-content: center;
}
.sidebar.collapsed .sidebar-logo {
  height: 24px;
}
.sidebar.collapsed .sidebar-section {
  padding: 0.5rem;
}
.sidebar.collapsed .nav-item {
  justify-content: center;
  padding: 0.55rem;
  position: relative;
}
.sidebar.collapsed .nav-icon {
  margin-right: 0;
  font-size: 1.1rem;
}
.sidebar.collapsed .sidebar-footer {
  padding: 0.5rem;
  text-align: center;
}
.sidebar.collapsed .sidebar-footer .nav-item {
  justify-content: center;
}

/* Smooth transition */
.sidebar {
  transition: width 0.25s ease;
  overflow: hidden;
}
</style>
