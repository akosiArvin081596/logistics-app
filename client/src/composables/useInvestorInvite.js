import { reactive, computed } from 'vue'
import { useApi } from './useApi'
import {
  INVITE_TOKEN_RE,
  INVITE_UNAVAILABLE,
  inviteErrorMessage,
  inviteLookupFailureCode,
} from '../lib/investorInvite'

// The personal invitation on /invest (see lib/investorInvite.js).
//
//   const invite = useInvestorInvite(() => inviteTokenFromQuery(route.query))
//   await invite.load()
//
// state: 'none'    no token in the URL; the page is the plain application form
//        'loading' the first lookup is in flight
//        'active'  the invitation is valid; its terms are in `terms` / `display`
//        'error'   refused or unreachable; `error` = { code, message }
//
// The token is read from the getter and never stored anywhere else: not in the
// draft, not in any browser store.
export function useInvestorInvite(tokenGetter) {
  const api = useApi()
  // Each load() and fail() takes a number; an answer that arrives after a newer
  // one was asked for is dropped, so a slow first lookup cannot overwrite a reload.
  let seq = 0

  const invite = reactive({
    token: computed(() => {
      const t = tokenGetter()
      return typeof t === 'string' ? t : ''
    }),
    state: 'none',
    error: null,
    inviteeName: '',
    inviteeEmail: '',
    terms: null,
    display: null,
    revision: null,
    expiresAt: '',
    isStandard: true,
    active: computed(() => invite.state === 'active'),
    load,
    fail,
  })

  function clearTerms() {
    invite.inviteeName = ''
    invite.inviteeEmail = ''
    invite.terms = null
    invite.display = null
    invite.revision = null
    invite.expiresAt = ''
    invite.isStandard = true
  }

  function fail(code) {
    seq++
    clearTerms()
    invite.error = { code, message: inviteErrorMessage(code) }
    invite.state = 'error'
  }

  function apply(row) {
    const pt = row.paymentTerms
    invite.inviteeName = typeof row.inviteeName === 'string' ? row.inviteeName : ''
    invite.inviteeEmail = typeof row.inviteeEmail === 'string' ? row.inviteeEmail : ''
    invite.terms = pt && typeof pt === 'object'
      ? {
          type: pt.type === 'lease' ? 'lease' : 'split',
          leaseAmountCents: Number.isSafeInteger(pt.leaseAmountCents) ? pt.leaseAmountCents : null,
          details: typeof pt.details === 'string' ? pt.details : '',
        }
      : null
    invite.display = row.display && typeof row.display === 'object' ? { ...row.display } : null
    invite.revision = row.termsRevision
    invite.expiresAt = typeof row.expiresAt === 'string' ? row.expiresAt : ''
    invite.isStandard = row.isStandard === true || !invite.terms
    invite.error = null
    invite.state = 'active'
  }

  async function load() {
    const token = invite.token
    const mine = ++seq
    if (!token) {
      clearTerms()
      invite.error = null
      invite.state = 'none'
      return
    }
    if (!INVITE_TOKEN_RE.test(token)) {
      fail('INVITE_NOT_FOUND')
      return
    }
    // A reload of an active invitation keeps the page as it is until the answer
    // lands; only the first lookup shows the loading line.
    if (invite.state !== 'active') {
      invite.error = null
      invite.state = 'loading'
    }
    let res
    try {
      res = await api.get('/api/public/investor-invite', { headers: { 'X-Invite-Token': token } })
    } catch (err) {
      if (mine === seq) fail(inviteLookupFailureCode(err.status, err.code))
      return
    }
    if (mine !== seq) return
    const row = res && res.invite
    // Without a whole-number revision the submit could not prove which terms were
    // signed, so a malformed answer is treated as no answer.
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.termsRevision)) {
      fail(INVITE_UNAVAILABLE)
      return
    }
    apply(row)
  }

  return invite
}
