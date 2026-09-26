import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

// Bumped by resetList(). A load that started under an older value was asking
// for a list the page has since dropped, so its answer is ignored rather than
// put on screen over the fresh one.
let listGen = 0

export const useTrucksStore = defineStore('trucks', {
  state: () => ({
    trucks: [],
    driverNames: [],
    investorUsers: [],
    // True while GET /api/trucks is in flight, the first load and every reload.
    isLoading: false,
    // False until the first loadTrucks() since the page opened has settled,
    // whether it succeeded or failed. The page shows its skeleton only until
    // then: a reload must leave the table mounted, because unmounting it also
    // closed an open Edit dialog and dropped everything typed into it.
    hasLoaded: false,
  }),

  getters: {
    availableDriverNames(state) {
      const taken = new Set(
        state.trucks
          .filter(t => t.AssignedDriver)
          .map(t => t.AssignedDriver.toLowerCase())
      )
      return state.driverNames.filter(n => !taken.has(n.toLowerCase()))
    },
  },

  actions: {
    // Called as the Trucks page opens. The store outlives the page (and a
    // sign-in does not reload the tab), so the list it holds may date from
    // before the latest sign-in. The page starts from an empty list behind its
    // skeleton instead, and listGen drops any load still in flight from before.
    resetList() {
      listGen++
      this.trucks = []
      this.isLoading = false
      this.hasLoaded = false
    },

    async loadTrucks() {
      const gen = listGen
      this.isLoading = true
      try {
        const data = await api.get('/api/trucks')
        if (gen === listGen) this.trucks = data.trucks || []
      } finally {
        if (gen === listGen) {
          this.isLoading = false
          this.hasLoaded = true
        }
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

    async loadInvestorUsers() {
      try {
        const data = await api.get('/api/users/investors')
        this.investorUsers = data.investors || []
      } catch {
        console.error('Failed to load investor users')
      }
    },

    // Each write rejects only when the server refused the write itself. The
    // Add form and the Edit dialog keep what was typed on a rejection, and
    // clear or close on a resolve.
    async addTruck(data) {
      const result = await api.post('/api/trucks', data)
      await this.reloadAfterWrite()
      return result
    },

    async updateTruck(id, data) {
      await api.put(`/api/trucks/${id}`, data)
      await this.reloadAfterWrite()
    },

    async deleteTruck(id) {
      await api.del(`/api/trucks/${id}`)
      await this.reloadAfterWrite()
    },

    // The re-read after a write the server has already accepted. Its failure is
    // not the write's failure, so it never reaches the caller as one: a saved
    // truck would be reported as refused, with its Edit dialog left open. It is
    // logged instead. The server announces every truck write on trucks:changed,
    // so the page reloads again moments later on its own.
    async reloadAfterWrite() {
      try {
        await this.loadTrucks()
      } catch (err) {
        console.error('Truck list refresh after a save failed:', err)
      }
    },
  },
})
