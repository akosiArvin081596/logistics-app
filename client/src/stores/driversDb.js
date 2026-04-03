import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()
const SHEET = 'Carrier Database'

export const useDriversDbStore = defineStore('driversDb', {
  state: () => ({
    headers: [],
    drivers: [],
    isLoading: false,
  }),

  actions: {
    async load() {
      this.isLoading = true
      try {
        const data = await api.get(`/api/data?sheet=${encodeURIComponent(SHEET)}&page=1&limit=200`)
        this.headers = data.headers || []
        this.drivers = data.data || []
      } finally {
        this.isLoading = false
      }
    },

    async add(values) {
      await api.post(`/api/data?sheet=${encodeURIComponent(SHEET)}`, { values })
      await this.load()
    },

    async update(rowIndex, values) {
      await api.put(`/api/data/${rowIndex}?sheet=${encodeURIComponent(SHEET)}`, { values })
      await this.load()
    },

    async remove(rowIndex) {
      await api.del(`/api/data/${rowIndex}?sheet=${encodeURIComponent(SHEET)}`)
      await this.load()
    },
  },
})
