import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useUsersStore = defineStore('users', {
  state: () => ({
    users: [],
    driverNames: [],
    isLoading: false,
    // Whether a new Super Admin or Dispatcher changes the password at first
    // sign-in (GET /api/users, NAMED_LOGINS_ENABLED on the server).
    newStaffMustChangePassword: false,
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
        this.newStaffMustChangePassword = data.newStaffMustChangePassword === true
      } catch (err) {
        throw err
      } finally {
        this.isLoading = false
      }
    },

    async loadDriverNames() {
      try {
        const json = await api.get('/api/drivers-directory')
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

    // The create alone: resolves once the server accepted it, rejects with its
    // refusal. The caller reloads the list (UsersView.vue createUser), so a
    // reload that fails after a create is never reported as a failed create.
    async addUser(data) {
      return api.post('/api/users', {
        username: data.username,
        password: data.password,
        role: data.role,
        driverName: data.driverName,
        email: data.email,
        fullName: data.fullName,
      })
    },

    // The save alone: resolves once the server accepted the edit, rejects with
    // its refusal. The caller reloads the list, so a reload that fails after a
    // successful save is never reported as a failed save.
    async updateUser(id, data) {
      await api.put(`/api/users/${id}`, data)
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
