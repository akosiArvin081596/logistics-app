import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import { recomputeErrorMessage, settingsErrorFrom } from '../lib/kpiView.js'

const api = useApi()
const { show: toast } = useToast()

// Every read takes the next number, and only the newest one's answer is kept: a
// live update, an approval, a settings save and a recompute can each start a
// read, and the answers can come back in any order.
let latestLoad = 0

// The admin KPI page (GET /api/admin/kpis). The server sends every figure with
// its display string; this store keeps the answer as sent and never works a
// figure out (lib/kpiView.js says why).
export const useKpisStore = defineStore('kpis', {
  state: () => ({
    // The §4 answer as the server sent it; null until the first read lands.
    report: null,
    // True only while the page is read for the first time. A later reload keeps
    // the cards mounted, so an open confirm dialog survives a live update.
    isLoading: false,
    hasLoaded: false,
    // Why the latest read failed, until one succeeds; '' otherwise.
    loadError: '',
    // Metric key -> true while that metric's approval is being saved.
    approvalSaving: {},
    settingsSaving: false,
    recomputeStarting: false,
  }),

  getters: {
    metrics: (state) => (Array.isArray(state.report?.metrics) ? state.report.metrics : []),
    job: (state) => state.report?.job || null,
    settings: (state) => state.report?.settings || null,
  },

  actions: {
    async load() {
      const ticket = ++latestLoad
      if (!this.hasLoaded) this.isLoading = true
      try {
        const data = await api.get('/api/admin/kpis')
        if (ticket === latestLoad) {
          this.report = data
          this.hasLoaded = true
          this.loadError = ''
        }
      } catch (err) {
        if (ticket === latestLoad) this.loadError = err?.message || 'The KPIs could not be loaded.'
        throw err
      } finally {
        if (ticket === latestLoad) this.isLoading = false
      }
    },

    // load() for the page opening, a live update and after every write. A failure
    // stays in loadError, which the page shows; this never rejects.
    async refresh() {
      try {
        await this.load()
      } catch {
        // loadError already holds the reason.
      }
    },

    // PUT /api/admin/kpis/approvals/:key. Resolves true when the server stored it.
    // A refusal (409 DEFINITION_CHANGED, 404, 400) is said in the server's own
    // sentence, and the reload that follows shows the metric as it now stands.
    async setApproval(key, approved, definitionVersion) {
      if (this.approvalSaving[key]) return false
      this.approvalSaving[key] = true
      let saved = false
      try {
        const data = await api.put(`/api/admin/kpis/approvals/${encodeURIComponent(key)}`, { approved, definitionVersion })
        const metric = this.metrics.find((m) => m.key === key)
        if (metric && data?.approval) metric.approval = data.approval
        toast(approved ? 'Approved for public use' : 'Approval withdrawn')
        saved = true
      } catch (err) {
        toast(err?.message || 'The approval could not be saved.', 'error')
      } finally {
        delete this.approvalSaving[key]
      }
      await this.refresh()
      return saved
    },

    // PUT /api/admin/kpis/settings with only the changed fields. Resolves
    // { ok: true, changed } or { ok: false, field, message }: the settings panel
    // shows the server's 400 sentence on the field it names.
    async saveSettings(partial) {
      this.settingsSaving = true
      try {
        const data = await api.put('/api/admin/kpis/settings', partial)
        if (this.report && data?.settings) this.report.settings = data.settings
        const changed = Array.isArray(data?.changed) ? data.changed : []
        toast(changed.length ? 'KPI settings saved' : 'Nothing to change')
        // A changed setting resets the approvals that used it; the reload shows that.
        await this.refresh()
        return { ok: true, changed }
      } catch (err) {
        const refusal = settingsErrorFrom(err)
        toast(refusal.message, 'error')
        return { ok: false, ...refusal }
      } finally {
        this.settingsSaving = false
      }
    },

    // POST /api/admin/kpis/recompute: 202 starts a run in the background. A run
    // already going (409) or one started moments ago (429) is a wait, not a fault.
    async recompute() {
      if (this.recomputeStarting) return false
      this.recomputeStarting = true
      let started = false
      try {
        await api.post('/api/admin/kpis/recompute', {})
        toast('Recompute started')
        started = true
      } catch (err) {
        toast(recomputeErrorMessage(err), err?.status === 409 || err?.status === 429 ? 'warning' : 'error')
      } finally {
        this.recomputeStarting = false
      }
      await this.refresh()
      return started
    },
  },
})
