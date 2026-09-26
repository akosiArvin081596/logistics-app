import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi.js'
import { replyLost } from '../lib/saveOutcome.js'

const api = useApi()

// Orders the loads of one list. Every load takes the next ticket, and only an
// answer newer than the one on screen is put there: a live update, a save and a
// Routemate link can each start a load, the answers can come back in any order,
// and an older list must never replace a newer one. forget() retires every
// ticket issued so far, so a load started before the page was opened again is
// ignored as well.
function loadOrder() {
  let issued = 0
  let shown = 0
  return {
    next: () => ++issued,
    // True, and `ticket` is now the answer on screen, when nothing newer is.
    claim(ticket) {
      if (ticket <= shown) return false
      shown = ticket
      return true
    },
    // The last load started, with nothing newer on screen: the only one whose
    // failure is worth showing. An older load's failure is not — a newer load
    // is still running, or has already put its list up.
    isLatest: (ticket) => ticket === issued && ticket > shown,
    forget() {
      shown = issued
    },
  }
}

const truckLoads = loadOrder()
const driverLoads = loadOrder()
const investorLoads = loadOrder()
// The truck-list loads started since the page last opened that the server has
// not answered yet. "Refreshing…" shows while there is any: one load coming back
// says nothing about another still running.
const running = new Set()

// A write, settled by the server's answer to the write alone. The list is
// re-read afterwards without being waited for: a reload can take seconds on a
// cold cache, and "Saving…" should end when the save does. A failed re-read is
// not a failed write either — a saved truck must never be reported as refused,
// with its Edit dialog left open — so it shows as loadError and is logged,
// never thrown. (The server also announces every truck write on
// trucks:changed, so the page reloads again moments later on its own.)
//
// A write whose answer never came (replyLost(): a timeout, a dropped
// connection, a gateway error page) may still have been made — the server can
// finish after the client stops waiting — so the list is re-read then too, to
// show whichever happened. The write still rejects.
async function writeThenRefresh(store, send) {
  let result
  try {
    result = await send()
  } catch (err) {
    if (replyLost(err)) store.refreshList()
    throw err
  }
  store.refreshList()
  return result
}

export const useTrucksStore = defineStore('trucks', {
  state: () => ({
    trucks: [],
    driverNames: [],
    investorUsers: [],
    // True while any truck-list load started since the page opened is waiting
    // for the server: the first load and every reload.
    isLoading: false,
    // False until a truck-list load since the page opened has succeeded. Until
    // then the page shows its skeleton, or loadError with a Retry: never "No
    // trucks yet" and a row of zeros for a list it never got. From then on a
    // reload leaves the table mounted, because unmounting it also closed an
    // open Edit dialog and dropped everything typed into it.
    hasLoaded: false,
    // Why the latest truck-list load failed, until a load succeeds; '' otherwise.
    loadError: '',
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
    // Called as the Trucks page opens, before its first render. The page starts
    // from an empty list each time it opens, and ignores a list load that
    // finishes after the page was opened again.
    resetList() {
      truckLoads.forget()
      driverLoads.forget()
      investorLoads.forget()
      running.clear()
      this.trucks = []
      this.driverNames = []
      this.investorUsers = []
      this.isLoading = false
      this.hasLoaded = false
      this.loadError = ''
    },

    // Rejects when the list could not be read, and keeps the reason in
    // loadError. A caller with nowhere to show the rejection uses refreshList().
    async loadTrucks() {
      const ticket = truckLoads.next()
      running.add(ticket)
      this.isLoading = true
      try {
        const data = await api.get('/api/trucks')
        if (truckLoads.claim(ticket)) {
          this.trucks = data.trucks || []
          this.hasLoaded = true
          this.loadError = ''
        }
      } catch (err) {
        if (truckLoads.isLatest(ticket)) this.loadError = err?.message || 'The truck list could not be loaded.'
        throw err
      } finally {
        if (running.delete(ticket)) this.isLoading = running.size > 0
      }
    },

    // loadTrucks() for the page opening, a live update, Retry and the re-read
    // after a write. A failure stays in loadError, which the page shows with a
    // Retry, and is logged; this never rejects.
    async refreshList() {
      try {
        await this.loadTrucks()
      } catch (err) {
        console.error('Truck list load failed:', err)
      }
    },

    async loadDriverNames() {
      const ticket = driverLoads.next()
      try {
        const json = await api.get('/api/drivers-directory')
        if (!driverLoads.claim(ticket)) return
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
      const ticket = investorLoads.next()
      try {
        const data = await api.get('/api/users/investors')
        if (investorLoads.claim(ticket)) this.investorUsers = data.investors || []
      } catch {
        console.error('Failed to load investor users')
      }
    },

    // Each write resolves once the server has accepted it and rejects with the
    // server's refusal (an Error carrying its message); see writeThenRefresh.
    // The Add form and the Edit dialog keep what was typed on a rejection, and
    // clear or close on a resolve.
    async addTruck(data) {
      return writeThenRefresh(this, () => api.post('/api/trucks', data))
    },

    async updateTruck(id, data) {
      await writeThenRefresh(this, () => api.put(`/api/trucks/${id}`, data))
    },

    async deleteTruck(id) {
      await writeThenRefresh(this, () => api.del(`/api/trucks/${id}`))
    },
  },
})
