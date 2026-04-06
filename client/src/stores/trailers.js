import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useTrailersStore = defineStore('trailers', {
  state: () => ({
    trailers: [],
    trucks: [],
    loading: false,
    error: null,
  }),
  getters: {
    availableTrucks: (s) => {
      const assignedTruckIds = new Set(s.trailers.filter(t => t.truck_id).map(t => t.truck_id))
      return s.trucks.filter(t => !assignedTruckIds.has(t.id))
    },
  },
  actions: {
    async load() {
      this.loading = true
      this.error = null
      try {
        const [trailers, trucks] = await Promise.all([
          api.get('/api/trailers'),
          api.get('/api/trucks'),
        ])
        this.trailers = trailers
        this.trucks = trucks
      } catch (err) {
        this.error = err.message
      } finally {
        this.loading = false
      }
    },
    async create(data) {
      const res = await api.post('/api/trailers', data)
      await this.load()
      return res
    },
    async update(id, data) {
      const res = await api.put(`/api/trailers/${id}`, data)
      await this.load()
      return res
    },
    async remove(id) {
      await api.delete(`/api/trailers/${id}`)
      await this.load()
    },
  },
})
