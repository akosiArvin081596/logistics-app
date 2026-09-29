import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

const BASE = '/api/admin/investor-invites'

// A render runs a headless browser on the server, and the first one after a
// restart is slow; 20 s (useApi's default) is too tight for it.
const PREVIEW_TIMEOUT_MS = 60000

export const INVITE_STATUS_FILTERS = ['all', 'active', 'used', 'revoked', 'expired']

// Every list read takes the next number, and only the newest one's answer is
// kept: a live update, a write and a filter change can each start a read, and
// the answers can come back in any order.
let latestListRead = 0

function matchesFilter(invite, status) {
  return status === 'all' || invite.status === status
}

async function readPreviewError(res) {
  let data = {}
  try { data = await res.json() } catch { data = {} }
  const err = new Error(data.error || `The preview could not be generated (${res.status}).`)
  err.status = res.status
  err.code = data.code || ''
  err.data = data
  return err
}

export const useInvestorInvitesStore = defineStore('investorInvites', {
  state: () => ({
    invites: [],
    status: 'all',
    // True while the list for the current filter is read for the first time.
    // A refresh leaves the table (and any dialog opened from it) mounted.
    isLoading: false,
    hasLoaded: false,
    loadError: '',
  }),

  actions: {
    // Reads the invites for `status` (one of INVITE_STATUS_FILTERS). Rejects
    // when the list could not be read, and keeps the reason in loadError.
    async list(status = this.status) {
      const ticket = ++latestListRead
      if (status !== this.status) {
        this.status = status
        this.invites = []
        this.hasLoaded = false
        this.loadError = ''
      }
      if (!this.hasLoaded) this.isLoading = true
      try {
        const data = await api.get(`${BASE}?status=${encodeURIComponent(status)}`)
        if (ticket === latestListRead) {
          this.invites = Array.isArray(data.invites) ? data.invites : []
          this.hasLoaded = true
          this.loadError = ''
        }
      } catch (err) {
        if (ticket === latestListRead) this.loadError = err?.message || 'The invites could not be loaded.'
        throw err
      } finally {
        if (ticket === latestListRead) this.isLoading = false
      }
      return this.invites
    },

    // list() for a live update, a filter change or the re-read after a write.
    // A failure stays in loadError, which the panel shows; this never rejects.
    async refresh(status = this.status) {
      try {
        await this.list(status)
      } catch {
        // loadError already holds the reason.
      }
    },

    // Puts the server's copy of one invite into the list at once, ahead of the
    // re-read, so the row the admin just changed never shows its old state.
    upsert(invite) {
      if (!invite || invite.id == null) return
      const at = this.invites.findIndex((i) => i.id === invite.id)
      if (!matchesFilter(invite, this.status)) {
        if (at !== -1) this.invites.splice(at, 1)
      } else if (at === -1) {
        this.invites.unshift(invite)
      } else {
        this.invites.splice(at, 1, invite)
      }
    },

    // body: { inviteeName, inviteeEmail, paymentType, leaseAmount?, details }.
    // Resolves { invite, invitePath }; invitePath is shown once and never again.
    async create(body) {
      const data = await api.post(BASE, body)
      this.upsert(data.invite)
      this.refresh()
      return data
    },

    // expectedRevision is the termsRevision the edit started from, so a save
    // over someone else's newer terms is refused (409 INVITE_REVISION_CONFLICT)
    // rather than silently replacing them.
    async update(id, body, expectedRevision) {
      const data = await api.put(`${BASE}/${encodeURIComponent(id)}`, { ...body, expectedRevision })
      this.upsert(data.invite)
      this.refresh()
      return data
    },

    // A new link: the old one stops working at once. Resolves { invite, invitePath }.
    async reissue(id) {
      const data = await api.post(`${BASE}/${encodeURIComponent(id)}/reissue`, {})
      this.upsert(data.invite)
      this.refresh()
      return data
    },

    async revoke(id, reason = '') {
      const data = await api.post(`${BASE}/${encodeURIComponent(id)}/revoke`, { reason })
      this.upsert(data.invite)
      this.refresh()
      return data
    },

    // The agreement as the invitee would see it, rendered for a sample
    // applicant. Resolves a PDF Blob; the caller owns any object URL it makes.
    async previewPdf(id, docKey, { signal } = {}) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS)
      const onAbort = () => controller.abort()
      if (signal) signal.addEventListener('abort', onAbort)
      try {
        const res = await fetch(
          `${BASE}/${encodeURIComponent(id)}/preview/${encodeURIComponent(docKey)}`,
          {
            method: 'POST',
            credentials: 'same-origin',
            // The server's same-site write check; useApi sets it on every other call.
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            signal: controller.signal,
          },
        )
        if (!res.ok) throw await readPreviewError(res)
        const blob = await res.blob()
        if (!/pdf/i.test(blob.type || res.headers.get('Content-Type') || '')) {
          throw new Error('The server did not send a PDF for this preview.')
        }
        return blob
      } catch (err) {
        if (err.name === 'AbortError') {
          const cancelled = !!(signal && signal.aborted)
          const e = new Error(cancelled ? 'Request cancelled.' : 'The preview took too long. Please try again.')
          e.code = cancelled ? 'ABORT' : 'TIMEOUT'
          e.status = 0
          throw e
        }
        throw err
      } finally {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
    },
  },
})
