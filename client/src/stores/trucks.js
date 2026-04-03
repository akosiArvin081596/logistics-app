import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useTrucksStore = defineStore('trucks', {
  state: () => ({
    trucks: [],
    driverNames: [],
    investorUsers: [],
    isLoading: false,
  }),

  getters: {
    availableDriverNames(state) {
      return state.driverNames
    },
  },

  actions: {
    async loadTrucks() {
      this.isLoading = true
      try {
        const data = await api.get('/api/trucks')
        this.trucks = data.trucks || []
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

    async loadInvestorUsers() {
      try {
        const data = await api.get('/api/users/investors')
        this.investorUsers = data.investors || []
      } catch {
        console.error('Failed to load investor users')
      }
    },

    async addTruck(data) {
      const result = await api.post('/api/trucks', data)
      await this.loadTrucks()
      return result
    },

    async updateTruck(id, data) {
      await api.put(`/api/trucks/${id}`, data)
      await this.loadTrucks()
    },

    async deleteTruck(id) {
      await api.del(`/api/trucks/${id}`)
      await this.loadTrucks()
    },
  },
})
