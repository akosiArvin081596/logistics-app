import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useDriversDbStore = defineStore('driversDb', {
  state: () => ({
    headers: [],
    drivers: [],
    isLoading: false,
    // The server's daily-rate rule ({ from } while it is on, else null), for
    // the Daily Rate field's help text.
    dailyRateRule: null,
  }),

  actions: {
    // A quiet load leaves isLoading alone: the page swaps the table for its
    // skeleton on isLoading, and that unmounts an open Edit dialog or drawer.
    async load({ quiet = false } = {}) {
      if (!quiet) this.isLoading = true
      try {
        const data = await api.get('/api/drivers-directory')
        this.headers = data.headers || []
        this.drivers = data.data || []
        this.dailyRateRule = data.dailyRateRule || null
      } finally {
        if (!quiet) this.isLoading = false
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

    // The server's answer comes back: it may tell staff about notes to CHR's
    // contact for the time off the delete cancelled.
    async remove(id) {
      const reply = await api.del(`/api/drivers-directory/${id}`)
      await this.load()
      return reply
    },
  },
})
