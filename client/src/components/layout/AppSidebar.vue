<template>
  <!-- Mobile-only dim backdrop. Sits between the content and the sidebar so
       tapping it closes the drawer without navigating. -->
  <div
    v-if="isMobile && appShell.sidebarOpen"
    class="sidebar-backdrop"
    @click="appShell.closeSidebar()"
  ></div>
  <aside :class="['sidebar', { collapsed, 'sidebar--mobile': isMobile, 'sidebar--open': isMobile && appShell.sidebarOpen }]">
    <div class="sidebar-header">
      <div class="header-top">
        <h1><img src="/logo.png" alt="LogisX" class="sidebar-logo" /></h1>
        <button v-if="!isMobile" class="collapse-btn" @click="toggle" :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'">
          <span class="collapse-icon" :class="{ flipped: collapsed }">&#9664;</span>
        </button>
        <button v-else class="collapse-btn" @click="appShell.closeSidebar()" aria-label="Close menu">
          <span class="collapse-icon">&#10005;</span>
        </button>
      </div>
      <p v-show="!collapsed || isMobile" class="subtitle">Logistics Management</p>
    </div>
    <div class="sidebar-section">
      <template v-for="item in navItems" :key="item.to || item.label">
        <div v-if="item.divider" v-show="!collapsed || isMobile" class="nav-divider">{{ item.label }}</div>
        <router-link
          v-else
          :to="item.to"
          class="nav-item"
          active-class="active"
          :title="(collapsed && !isMobile) ? item.label : ''"
          @click="onNavClick"
        >
          <span class="nav-icon" v-html="item.icon"></span>
          <span v-show="!collapsed || isMobile" class="nav-label">{{ item.label }}</span>
          <span v-if="(!collapsed || isMobile) && item.to === '/notifications' && notifStore.unreadCount > 0" class="nav-badge">{{ notifStore.unreadCount }}</span>
          <span v-if="collapsed && !isMobile && item.to === '/notifications' && notifStore.unreadCount > 0" class="nav-badge-dot"></span>
        </router-link>
      </template>
      <div id="sidebarExtra"></div>
    </div>
    <div class="sidebar-footer">
      <a href="#" class="nav-item" style="color:var(--danger);margin-bottom:0.5rem;" @click.prevent="handleLogout" :title="(collapsed && !isMobile) ? 'Logout' : ''">
        <span class="nav-icon">&#10140;</span> <span v-show="!collapsed || isMobile">Logout</span>
      </a>
      <div v-show="!collapsed || isMobile" class="status-dot">
        <span :class="['dot', isConnected ? 'ok' : 'error']"></span>
        {{ isConnected ? 'Connected' : 'Disconnected' }}
      </div>
      <div v-show="collapsed && !isMobile" class="status-dot" style="justify-content:center;">
        <span :class="['dot', isConnected ? 'ok' : 'error']"></span>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { useSocket } from '../../composables/useSocket'
import { useDispatchNotificationsStore } from '../../stores/dispatchNotifications'
import { useViewport } from '../../composables/useViewport'
import { useAppShellStore } from '../../stores/appShell'

const router = useRouter()
const auth = useAuthStore()
const { isConnected, connect } = useSocket()
const notifStore = useDispatchNotificationsStore()
const { isMobile } = useViewport()
const appShell = useAppShellStore()

const STORAGE_KEY = 'sidebar-collapsed'
const collapsed = ref(localStorage.getItem(STORAGE_KEY) === '1')

function toggle() {
  collapsed.value = !collapsed.value
  localStorage.setItem(STORAGE_KEY, collapsed.value ? '1' : '0')
}

watch(collapsed, (val) => {
  document.documentElement.style.setProperty('--sidebar-w', val ? '64px' : '240px')
}, { immediate: true })

// Tapping a nav item on mobile should close the drawer. (The desktop collapse
// state is unaffected; on desktop isMobile is false and this no-ops.)
function onNavClick() {
  if (isMobile.value) appShell.closeSidebar()
}

// Belt-and-suspenders: also close the drawer on any route change so a
// programmatic navigation (e.g. handleLogout) leaves the shell in a clean
// state.
let removeAfterEach = null

// Close drawer on Escape for keyboard users.
function onKeydown(e) {
  if (e.key === 'Escape' && isMobile.value && appShell.sidebarOpen) {
    appShell.closeSidebar()
  }
}

onMounted(() => {
  connect()
  if (auth.user?.role === 'Super Admin' || auth.user?.role === 'Dispatcher') {
    notifStore.fetch()
  }
  removeAfterEach = router.afterEach(() => {
    if (isMobile.value) appShell.closeSidebar()
  })
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  if (removeAfterEach) removeAfterEach()
  window.removeEventListener('keydown', onKeydown)
})

const navConfig = {
  'Super Admin': [
    { to: '/dashboard', icon: '&#9635;', label: 'Dashboard' },
    { to: '/jobs/new', icon: '&#10010;', label: 'New Job' },
    { to: '/tracking', icon: '&#128205;', label: 'Tracking' },
    { to: '/notifications', icon: '&#128276;', label: 'Notifications' },
    { to: '/expenses', icon: '&#128176;', label: 'Expenses' },
    { to: '/invoices', icon: '&#128178;', label: 'Invoices' },
    { to: '/messages', icon: '&#128172;', label: 'Messages' },
    { divider: true, label: 'Administration' },
    { to: '/users', icon: '&#9881;', label: 'User Management' },
    { to: '/investors', icon: '&#128188;', label: 'Investor Database' },
    { to: '/drivers', icon: '&#128100;', label: 'Driver Database' },
    { to: '/trucks', icon: '&#128203;', label: 'Truck Database' },
    { to: '/trailers', icon: '&#128718;', label: 'Trailer Database' },
    { divider: true, label: 'Applications' },
    { to: '/applications', icon: '&#128221;', label: 'Driver Applications' },
    { to: '/investor-applications', icon: '&#128188;', label: 'Investor Applications' },
    { divider: true, label: 'System' },
    { to: '/admin/financials', icon: '&#128200;', label: 'Financials' },
    { to: '/admin/tools', icon: '&#128295;', label: 'Data Tools' },
    { to: '/data', icon: '&#9776;', label: 'Data Manager' },
  ],
  Dispatcher: [
    { to: '/dashboard', icon: '&#9635;', label: 'Dashboard' },
    { to: '/tracking', icon: '&#128205;', label: 'Tracking' },
    { to: '/notifications', icon: '&#128276;', label: 'Notifications' },
    { to: '/expenses', icon: '&#128176;', label: 'Expenses' },
    { to: '/messages', icon: '&#128172;', label: 'Messages' },
    { to: '/trucks', icon: '&#128203;', label: 'Truck Database' },
  ],
  Investor: [
    { to: '/investor', icon: '&#128200;', label: 'Financial Overview' },
    { to: '/trucks', icon: '&#128203;', label: 'My Trucks' },
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
.nav-divider {
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-dim, #8b8fa3);
  padding: 0.8rem 0.75rem 0.3rem;
  margin-top: 0.2rem;
}

/* Header layout */
.header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Collapse toggle button */
.collapse-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: transparent;
  border: 1px solid var(--border, #e5e7eb);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
}
.collapse-btn:hover {
  background: var(--surface-hover, rgba(0,0,0,0.04));
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
  padding: 0.75rem 0.5rem;
}
.sidebar.collapsed .header-top {
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
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

/* ---- Mobile drawer mode (viewport ≤ 767 px) ---------------------------
 * `.sidebar--mobile` is applied via Vue when useViewport reports isMobile.
 * Width goes back to full 240 px regardless of the desktop `.collapsed`
 * state — on mobile the sidebar IS the drawer, not a chrome strip.
 * It sits off-screen at rest and slides in when `sidebar--open` is added.
 * The desktop `--sidebar-w` CSS variable is intentionally ignored by the
 * main content when isMobile is true (see App.vue).                       */
.sidebar.sidebar--mobile {
  width: 260px;
  transform: translateX(-100%);
  transition: transform 0.22s ease;
  z-index: 60; /* above backdrop (40) and hamburger (50) */
  box-shadow: 6px 0 24px rgba(15, 23, 42, 0.18);
}
.sidebar.sidebar--mobile.sidebar--open {
  transform: translateX(0);
}
/* When the mobile class is present, the desktop "collapsed" behaviour
   should not constrain width — drawer is always full-width. */
.sidebar.sidebar--mobile.collapsed {
  width: 260px;
}
.sidebar.sidebar--mobile.collapsed .sidebar-header {
  padding: 1.25rem 1.25rem 1rem;
}
.sidebar.sidebar--mobile.collapsed .header-top {
  flex-direction: row;
  align-items: center;
  gap: 0;
}
.sidebar.sidebar--mobile.collapsed .sidebar-logo {
  height: 32px;
}
.sidebar.sidebar--mobile.collapsed .sidebar-section {
  padding: 0.75rem;
}
.sidebar.sidebar--mobile.collapsed .nav-item {
  justify-content: flex-start;
  padding: 0.45rem 0.75rem;
}
.sidebar.sidebar--mobile.collapsed .nav-icon {
  margin-right: 0;
  font-size: 0.85rem;
}
.sidebar.sidebar--mobile.collapsed .sidebar-footer {
  padding: 0.75rem 1rem;
  text-align: left;
}
.sidebar.sidebar--mobile.collapsed .sidebar-footer .nav-item {
  justify-content: flex-start;
}

/* Dimmed backdrop behind the mobile drawer */
.sidebar-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.42);
  z-index: 40;
  animation: backdrop-fade-in 0.18s ease;
}
@keyframes backdrop-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
