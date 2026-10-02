import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

// The report builds the whole ledger on a cold cache (seconds on a big range),
// so it gets more than useApi()'s 20 s default.
const REPORT_TIMEOUT_MS = 60000

// Financials page state. Every figure is the server's
// (GET /api/financials/report); the page only displays it.
export const useFinancialsStore = defineStore('financials', {
  state: () => ({
    // GET /api/financials/report for `reportSearch` (lib/financialsView.js)
    report: null,
    reportSearch: '',
    isLoading: false,
    lastError: '',
    lastErrorCode: '',
    // GET / PUT /api/financials/settings
    settings: null,
    settingsDefaults: null,
    settingsLines: [],
    settingsLoading: false,
    settingsError: '',
    settingsSaving: false,
    // Month drill-down (GET /api/financials?month=YYYY-MM), for MonthDetailModal
    monthDetail: null,
    monthLoading: false,
    monthError: '',
  }),

  actions: {
    // Load the report for a query string. A newer call supersedes an older
    // one: the older request is aborted and its answer, if any, dropped.
    async loadReport(search) {
      const reqId = (this._reportReqId = (this._reportReqId || 0) + 1)
      if (this._reportAbort) this._reportAbort.abort()
      const controller = new AbortController()
      this._reportAbort = controller
      this.isLoading = true
      this.lastError = ''
      this.lastErrorCode = ''
      try {
        const data = await api.get(`/api/financials/report?${search}`, {
          timeout: REPORT_TIMEOUT_MS,
          signal: controller.signal,
        })
        if (reqId !== this._reportReqId) return
        this.report = data
        this.reportSearch = search
      } catch (err) {
        if (reqId !== this._reportReqId) return
        this.lastError = err?.message || 'Failed to load the financials report'
        this.lastErrorCode = err?.code || ''
      } finally {
        if (reqId === this._reportReqId) {
          this.isLoading = false
          this._reportAbort = null
        }
      }
    },

    // Re-run the last requested report (socket refresh, after a settings save).
    reload() {
      if (this._lastSearch) return this.loadReport(this._lastSearch)
    },

    // The page asks through here so reload() knows what to repeat.
    request(search) {
      this._lastSearch = search
      return this.loadReport(search)
    },

    async loadSettings() {
      this.settingsLoading = true
      this.settingsError = ''
      try {
        const data = await api.get('/api/financials/settings')
        this.settings = data.settings || null
        this.settingsDefaults = data.defaults || null
        this.settingsLines = Array.isArray(data.lines) ? data.lines : []
      } catch (err) {
        this.settingsError = err?.message || 'Failed to load the cost settings'
      } finally {
        this.settingsLoading = false
      }
    },

    // PUT the settings. Resolves to the server's { settings, changed }; throws
    // the API error (400 INVALID_SETTINGS carries a readable message) so the
    // dialog can show it beside the form.
    async saveSettings(body) {
      this.settingsSaving = true
      try {
        const data = await api.put('/api/financials/settings', body)
        this.settings = data.settings || this.settings
        return data
      } finally {
        this.settingsSaving = false
      }
    },

    // Fetch the drill-down for one month. A request token drops stale
    // responses when months are clicked rapidly.
    async loadMonth(month) {
      const reqId = (this._monthReqId = (this._monthReqId || 0) + 1)
      this.monthLoading = true
      this.monthError = ''
      this.monthDetail = null
      try {
        const data = await api.get(`/api/financials?month=${encodeURIComponent(month)}`, { timeout: REPORT_TIMEOUT_MS })
        if (reqId !== this._monthReqId) return // a newer request superseded this one
        this.monthDetail = data.monthDetail || null
        if (!this.monthDetail) this.monthError = 'No detail returned for this month'
      } catch (err) {
        if (reqId !== this._monthReqId) return
        this.monthError = err?.message || 'Failed to load month detail'
      } finally {
        if (reqId === this._monthReqId) this.monthLoading = false
      }
    },

    clearMonth() {
      this._monthReqId = (this._monthReqId || 0) + 1
      this.monthDetail = null
      this.monthError = ''
      this.monthLoading = false
    },
  },
})
