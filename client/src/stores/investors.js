import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useInvestorsStore = defineStore('investors', {
  state: () => ({
    investors: [],
    investorUsers: [],
    carrierNames: [],
    isLoading: false,
  }),

  actions: {
    async loadCarrierNames() {
      try {
        const json = await api.get(`/api/data?sheet=${encodeURIComponent('Carrier Database')}&page=1&limit=200`)
        const headers = json.headers || []
        const col = headers.find(h => /carrier.?name/i.test(h))
        if (col) {
          const names = (json.data || []).map(r => (r[col] || '').trim()).filter(Boolean)
          this.carrierNames = [...new Set(names)].sort()
        }
      } catch {
        console.error('Failed to load carrier names')
      }
    },

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
