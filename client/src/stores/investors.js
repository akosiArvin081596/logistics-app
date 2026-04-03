import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useInvestorsStore = defineStore('investors', {
  state: () => ({
    investors: [],
    investorUsers: [],
    isLoading: false,
  }),

  actions: {
    async load() {
      this.isLoading = true
      try {
        const data = await api.get('/api/investors')
        this.investors = data.investors || []
      } finally {
        this.isLoading = false
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

    async add(data) {
      await api.post('/api/investors', data)
      await this.load()
    },

    async update(id, data) {
      await api.put(`/api/investors/${id}`, data)
      await this.load()
    },

    async remove(id) {
      await api.del(`/api/investors/${id}`)
      await this.load()
    },
  },
})
