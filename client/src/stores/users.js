import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useUsersStore = defineStore('users', {
  state: () => ({
    users: [],
    driverNames: [],
    isLoading: false,
  }),

  getters: {
    availableDriverNames(state) {
      const taken = new Set(
        state.users
          .filter(u => u.DriverName)
          .map(u => u.DriverName.toLowerCase())
      )
      return state.driverNames.filter(n => !taken.has(n.toLowerCase()))
    },
  },

  actions: {
    async loadUsers() {
      this.isLoading = true
      try {
        const data = await api.get('/api/users')
        this.users = data.users || []
      } catch (err) {
        throw err
      } finally {
        this.isLoading = false
      }
    },

    async loadDriverNames() {
      try {
        const json = await api.get(
          `/api/data?sheet=${encodeURIComponent('Carrier Database')}&page=1&limit=200`
        )
        const headers = json.headers || []
        const driverCol = headers.find((h) => /driver/i.test(h)) || headers[0]
        if (driverCol) {
          const names = (json.data || [])
            .map((row) => (row[driverCol] || '').trim())
            .filter(Boolean)
          this.driverNames = [...new Set(names)].sort()
        }
      } catch {
        console.error('Failed to load driver names')
      }
    },

    async addUser(data) {
      const result = await api.post('/api/users', {
        username: data.username,
        password: data.password,
        role: data.role,
        driverName: data.driverName,
        email: data.email,
        fullName: data.fullName,
        companyName: data.companyName,
      })
      await this.loadUsers()
      return result
    },

    async updateUser(id, data) {
      await api.put(`/api/users/${id}`, data)
      await this.loadUsers()
    },

    async rateUser(id, rating) {
      await api.put(`/api/users/${id}/rating`, { rating })
      const user = this.users.find(u => u.id === id)
      if (user) user.Rating = rating
    },

    async deleteUser(id) {
      await api.del(`/api/users/${id}`)
      await this.loadUsers()
    },
  },
})
