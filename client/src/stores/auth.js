import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    isAuthenticated: false,
    isLoading: true,
  }),

  getters: {
    isAdmin: (s) => s.user?.role === 'Admin',
    isDispatcher: (s) => s.user?.role === 'Dispatcher',
    isDriver: (s) => s.user?.role === 'Driver',
    isInvestor: (s) => s.user?.role === 'Investor',
    roleHome: (s) => {
      const map = {
        Admin: '/dashboard',
        Dispatcher: '/dashboard',
        Driver: '/driver',
        Investor: '/investor',
      }
      return map[s.user?.role] || '/login'
    },
  },

  actions: {
    async checkSession() {
      try {
        const data = await api.get('/api/auth/session')
        if (data.authenticated) {
          this.user = data.user
          this.isAuthenticated = true
        } else {
          this.user = null
          this.isAuthenticated = false
        }
      } catch {
        this.user = null
        this.isAuthenticated = false
      } finally {
        this.isLoading = false
      }
    },

    async login(username, password) {
      const data = await api.post('/api/auth/login', { username, password })
      this.user = data.user
      this.isAuthenticated = true
      return data.user
    },

    async setup(username, password, email) {
      const data = await api.post('/api/auth/setup', { username, password, email })
      this.user = data.user || { username, role: 'Admin' }
      this.isAuthenticated = true
      return this.user
    },

    async logout() {
      try {
        await api.post('/api/auth/logout')
      } catch {
        // ignore
      }
      this.user = null
      this.isAuthenticated = false
    },

    async checkSetupNeeded() {
      const data = await api.get('/api/auth/setup-check')
      return data.needsSetup
    },
  },
})
