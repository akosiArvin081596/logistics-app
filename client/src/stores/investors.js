import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

// Every list read takes the next number, and only the newest one's answer is
// kept: a live update, a save and an avatar upload can each start a read, and
// the answers can come back in any order.
let latestLoad = 0

export const useInvestorsStore = defineStore('investors', {
  state: () => ({
    investors: [],
    investorUsers: [],
    // True only while the list is read for the first time. A later reload
    // leaves the table mounted: unmounting it also closed an open detail modal.
    isLoading: false,
    hasLoaded: false,
    // Why the latest read failed, until one succeeds; '' otherwise.
    loadError: '',
  }),

  actions: {
    async load() {
      const ticket = ++latestLoad
      if (!this.hasLoaded) this.isLoading = true
      try {
        const data = await api.get('/api/investors')
        if (ticket === latestLoad) {
          this.investors = data.investors || []
          this.hasLoaded = true
          this.loadError = ''
        }
      } catch (err) {
        if (ticket === latestLoad) this.loadError = err?.message || 'The investor list could not be loaded.'
        throw err
      } finally {
        if (ticket === latestLoad) this.isLoading = false
      }
    },

    // load() for the page opening and a live update. A failure stays in
    // loadError, which the page shows; this never rejects.
    async refresh() {
      try {
        await this.load()
      } catch {
        // loadError already holds the reason.
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

    // A write is settled by the server's answer to the write alone: a reload that
    // fails afterwards shows in loadError and never reports the write as refused.
    async add(data) {
      await api.post('/api/investors', data)
      await this.refresh()
    },

    async update(id, data) {
      await api.put(`/api/investors/${id}`, data)
      await this.refresh()
    },

    async remove(id) {
      await api.del(`/api/investors/${id}`)
      await this.refresh()
    },
  },
})
