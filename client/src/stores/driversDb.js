import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

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
        const data = await api.get('/api/drivers-directory')
        this.headers = data.headers || []
        this.drivers = data.data || []
      } finally {
        this.isLoading = false
      }
    },

    async add(values) {
      await api.post('/api/drivers-directory', { values, headers: this.headers })
      await this.load()
    },

    async update(id, values) {
      await api.put(`/api/drivers-directory/${id}`, { values, headers: this.headers })
      await this.load()
    },

    async remove(id) {
      await api.del(`/api/drivers-directory/${id}`)
      await this.load()
    },
  },
})
