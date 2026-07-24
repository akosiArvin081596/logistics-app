import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

export const useInvestorStore = defineStore('investor', {
  state: () => ({
    data: null,
    isLoading: true,
    // Set when a Super Admin is previewing a specific investor's portal via
    // /investor-portals/:userId. All API calls thread this through as
    // `?as_user_id=N` so the backend scopes data to that investor instead of
    // the session user. null = normal session-scoped behavior.
    previewUserId: null,

    // ---- Payout ledger (GET /api/investor/payouts) ----
    // The SINGLE source of truth for "what is owed / paid / still accruing".
    // Both PayoutsSection and the LoadReportsSection banner read this slice, so
    // they can never disagree — they used to, because the banner derived its own
    // "still owed" from netToDate − paid and swept the still-open current month
    // into "owed" while the ledger reported it as in-progress.
    payouts: [],
    currentMonth: null,
    payoutTotals: { totalOwed: 0, totalProcessing: 0, totalPaid: 0 },
    payoutsLoading: true,
    // A Super Admin viewing /investor WITHOUT previewing anyone gets a 400 here
    // (payouts are per-owner; there is no whole-fleet payout). Callers must
    // degrade to earnings-only rather than rendering misleading zeros.
    payoutsFailed: false,
    payoutsNotFound: false,
    // In-flight loadPayouts() promise, so concurrent callers share one request.
    _payoutsInFlight: null,
    // Bumped on every reset. A response whose token is stale (the admin already
    // switched to a different investor) is discarded instead of overwriting the
    // new investor's ledger with the previous one's numbers.
    _payoutsToken: 0,
  }),

  getters: {
    production: (s) => s.data?.production || null,
    asset: (s) => s.data?.asset || null,
    taxShield: (s) => s.data?.taxShield || null,
    recessionProof: (s) => s.data?.recessionProof || null,
    config: (s) => s.data?.config || null,
    myLoads: (s) => s.data?.myLoads || { pending: [], active: [] },
    isPreview: (s) => s.previewUserId != null,
    previewQuery: (s) => (s.previewUserId != null ? `as_user_id=${s.previewUserId}` : ''),
    // What is accruing in the still-open month — reported separately from owed
    // because it is not payable until the period closes.
    accruingThisMonth: (s) => s.currentMonth?.amountInProgress || 0,
  },

  actions: {
    async load() {
      this.isLoading = true
      try {
        const qs = this.previewUserId != null ? `?as_user_id=${this.previewUserId}` : ''
        const data = await api.get(`/api/investor${qs}`)
        this.data = data
      } catch (err) {
        throw err
      } finally {
        this.isLoading = false
      }
    },

    // Fetch the payout ledger once for the whole portal. Threads previewUserId
    // as ?as_user_id= exactly like load() does; callers that own their own
    // scoping (PayoutsSection renders standalone on /my-payouts) pass it
    // explicitly. Never throws: a failure degrades the surfaces that read this
    // slice instead of breaking the dashboard.
    //
    // Concurrent callers share one request — InvestorView and PayoutsSection
    // both ask on mount, and firing the reconcile twice is wasted work.
    async loadPayouts(overrideUserId) {
      const scopeId = overrideUserId !== undefined ? overrideUserId : this.previewUserId
      if (this._payoutsInFlight) return this._payoutsInFlight
      this.payoutsLoading = true
      this._payoutsInFlight = this._fetchPayouts(scopeId, this._payoutsToken).finally(() => {
        this._payoutsInFlight = null
      })
      return this._payoutsInFlight
    },

    async _fetchPayouts(scopeId, token) {
      try {
        const qs = scopeId != null ? `?as_user_id=${scopeId}` : ''
        const data = await api.get(`/api/investor/payouts${qs}`)
        if (token !== this._payoutsToken) return // superseded — drop the result
        this.payouts = data.payouts || []
        this.currentMonth = data.currentMonth || null
        this.payoutTotals = data.totals || { totalOwed: 0, totalProcessing: 0, totalPaid: 0 }
        this.payoutsFailed = false
        this.payoutsNotFound = false
      } catch (err) {
        if (token !== this._payoutsToken) return
        this.payouts = []
        this.currentMonth = null
        this.payoutTotals = { totalOwed: 0, totalProcessing: 0, totalPaid: 0 }
        this.payoutsFailed = true
        this.payoutsNotFound = err.status === 404
      } finally {
        if (token === this._payoutsToken) this.payoutsLoading = false
      }
    },

    async updateConfig(config) {
      const data = await api.put('/api/investor/config', config)
      if (this.data) {
        this.data.config = data.config || config
      }
    },

    // Enter preview mode for a given investor user_id. Reset data so the UI
    // doesn't flash stale numbers from the previously-previewed investor
    // while the new fetch is in flight (singleton store gotcha).
    setPreview(userId) {
      const id = parseInt(userId, 10)
      this.previewUserId = Number.isFinite(id) && id > 0 ? id : null
      this.data = null
      this.isLoading = true
      this.resetPayouts()
    },

    clearPreview() {
      this.previewUserId = null
      this.data = null
      this.isLoading = true
      this.resetPayouts()
    },

    // Same stale-flash guard as `data`: clear the ledger when the previewed
    // investor changes so one investor's payouts never render under another's name.
    resetPayouts() {
      this.payouts = []
      this.currentMonth = null
      this.payoutTotals = { totalOwed: 0, totalProcessing: 0, totalPaid: 0 }
      this.payoutsLoading = true
      this.payoutsFailed = false
      this.payoutsNotFound = false
      this._payoutsInFlight = null
      this._payoutsToken += 1
    },
  },
})
