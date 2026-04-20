import { defineStore } from 'pinia'

// App-shell state shared between AppSidebar (the drawer) and App.vue (the
// hamburger button). Desktop users never trigger these actions — they're
// no-ops when `useViewport().isMobile` is false because the UI that calls
// them isn't rendered.
export const useAppShellStore = defineStore('appShell', {
  state: () => ({
    sidebarOpen: false,
  }),
  actions: {
    toggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen
    },
    openSidebar() {
      this.sidebarOpen = true
    },
    closeSidebar() {
      this.sidebarOpen = false
    },
  },
})
