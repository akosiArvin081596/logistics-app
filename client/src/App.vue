<template>
  <AppSidebar v-if="showSidebar" />
  <!-- Hamburger: only renders on mobile, for authenticated admin routes.
       Sits above .main content but below the open drawer (drawer z=60,
       backdrop z=40, this button z=50). -->
  <button
    v-if="showSidebar && isMobile"
    class="mobile-menu-btn"
    :class="{ hidden: appShell.sidebarOpen }"
    aria-label="Open menu"
    @click="appShell.toggleSidebar()"
  >
    <span></span><span></span><span></span>
  </button>
  <main :class="['main', { 'no-sidebar': !showSidebar, 'main--mobile': isMobile && showSidebar }]">
    <router-view />
  </main>
  <AppToast />
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { useViewport } from './composables/useViewport'
import { useAppShellStore } from './stores/appShell'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppToast from './components/layout/AppToast.vue'

const route = useRoute()
const auth = useAuthStore()
const { isMobile } = useViewport()
const appShell = useAppShellStore()

const showSidebar = computed(() => {
  if (!auth.isAuthenticated) return false
  if (route.meta.noSidebar) return false
  return true
})
</script>

<style>
.main.no-sidebar {
  margin-left: 0;
  width: 100%;
  padding: 0;
  height: 100vh;
}
/* Mobile: sidebar overlays instead of pushing, so main takes the full
   width. Desktop behaviour in shared.css is untouched. */
.main.main--mobile {
  margin-left: 0;
  width: 100%;
}

/* Hamburger button. Three bars, clean look, fixed top-left. Fades out
   when the drawer is open so users don't get a stacked-buttons feel —
   the drawer header has its own close X. */
.mobile-menu-btn {
  position: fixed;
  top: 0.6rem;
  left: 0.6rem;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  border: 1px solid var(--border, #e5e7eb);
  background: var(--surface, #fff);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  z-index: 50;
  padding: 0;
  transition: opacity 0.15s, transform 0.15s;
}
.mobile-menu-btn:hover {
  transform: translateY(-1px);
}
.mobile-menu-btn.hidden {
  opacity: 0;
  pointer-events: none;
}
.mobile-menu-btn span {
  display: block;
  width: 20px;
  height: 2px;
  background: var(--text, #0f172a);
  border-radius: 2px;
}
</style>
