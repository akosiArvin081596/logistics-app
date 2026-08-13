import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi'

const api = useApi()

/**
 * The empty ledger totals — ONE definition, used by the state initialiser, the
 * fetch error path, and resetPayouts().
 *
 * ⚠️ IT MUST CARRY EVERY KEY `GET /api/investor/payouts` RETURNS. It used to
 * carry only the first three, so `totalAdjustments` and `carriedLossOutstanding`
 * read `undefined` before the first fetch succeeded — and again after every
 * preview switch, since resetPayouts() reset to the same short shape. Nothing
 * was visibly broken, because both consumers happen to guard (`|| 0` in
 * LoadReportsSection, a truthiness `v-if` in PayoutsSection). That is the
 * problem: whether an investor's money screen renders `$NaN` was left to whether
 * the next consumer remembers a guard. A default that silently omits half the
 * shape makes correctness a matter of luck.
 *
 * A FACTORY, not a shared frozen constant. Pinia state is reactive and mutable,
 * so handing three call sites the same object reference would let a write
 * through one of them redefine "empty" for the other two.
 */
function emptyPayoutTotals() {
  return {
    totalOwed: 0,
    totalProcessing: 0,
    totalPaid: 0,
    // Signed corrections applied across the ledger — legitimately negative.
    totalAdjustments: 0,
    // Earlier losses still carried against future months (server excludes the
    // still-open month; see lib/payoutPeriod.js).
    carriedLossOutstanding: 0,
  }
}

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
    payoutTotals: emptyPayoutTotals(),
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
    //
    // ⚠️ DESPITE THE NAME THIS IS THE STORE'S SCOPE TOKEN, NOT A PAYOUTS-ONLY
    // ONE, and EVERY action that writes scope-dependent state must read it.
    // It is bumped by resetPayouts(), whose only callers are setPreview() and
    // clearPreview() — so it changes exactly when the previewed investor
    // changes and never on an ordinary refresh. Four actions depend on it
    // today: _fetchPayouts(), fetchPayoutDetail(), load() and updateConfig().
    // It was originally added for the ledger alone, and the two siblings that
    // did not read it — load(), which owns the portal's PRIMARY payload, and
    // updateConfig() — were both cross-investor leaks for exactly as long. The
    // name is kept because renaming it buys nothing the comment does not; the
    // rule is the comment.
    _payoutsToken: 0,

    // ---- Per-month payout drill-down (GET /api/investor/payouts/:period/detail) ----
    // Line-item composition behind each waterfall figure (revenue loads, driver-pay
    // rows, fixed-cost items, trip expenses), fetched lazily the first time an
    // investor clicks a Revenue / Driver Pay / Fixed Costs / Trip Expenses row.
    // Cached per period ({ 'YYYY-MM': detail }) so re-opening a month's lines never
    // refetches; cleared by resetPayouts() on a preview switch so one investor's
    // items never surface under another's name. Clearing is only half of that
    // guarantee — a request already in flight when the cache was emptied would
    // repopulate it with the OLD investor's lines, so fetchPayoutDetail() also
    // checks `_payoutsToken` before writing here. See the note on that action.
    payoutDetailCache: {},
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
    // ⚠️ CARRIES THE SAME `_payoutsToken` SCOPE GUARD AS _fetchPayouts(), and it
    // is the WIDER of the two leaks without it. `data` is the portal's PRIMARY
    // payload — earnings, cash flow, the monthly breakdown, the truck fleet,
    // myLoads, taxShield and `investor.fullName` — so an unguarded write puts one
    // investor's whole dashboard under another investor's name:
    //   1. Admin on /investor-portals/1. GET /api/investor is in flight. This is
    //      not a tight race: that endpoint runs the ELD active-days math and has
    //      historically taken seconds, so clicking between two previews is enough.
    //   2. Admin moves to /investor-portals/2. setPreview(2) nulls `data` and
    //      bumps the token; InvestorView remounts on its :key and refetches.
    //   3. Investor 1's response lands last and WINS. PayoutsSection renders
    //      investor 2's correctly-guarded ledger while EarningsSection,
    //      CashFlowSection, myLoads and taxShield render investor 1's numbers on
    //      the same page — and InvestorPortalPreviewView's banner reads
    //      `data.investor.fullName`, so the URL says one investor while the
    //      heading and the money say the other.
    // Last-write-wins, so unlike a momentary flash this PERSISTS until the next
    // switch. It is the same failure `_payoutsToken` was introduced for on the
    // ledger; this sibling simply never read it.
    //
    // ⚠️ `isLoading` IS INSIDE THE GUARD TOO. An unconditional `finally` clears
    // the spinner on behalf of a request that is no longer the live one, so the
    // new investor's still-pending fetch renders as "loaded" over a null `data`
    // (empty dashboard, and InvestorView's Refresh button re-enabled mid-flight).
    // Only the request that still owns the scope may say loading is over.
    //
    // The error path is deliberately unchanged: it writes nothing and rethrows,
    // so a FAILED load leaves the last good `data` on screen instead of blanking
    // the dashboard. A superseded failure is still rethrown — the caller's toast
    // is the pre-existing behaviour, and swallowing it here would hide a real
    // outage whenever it happened to overlap a scope change.
    async load() {
      this.isLoading = true
      const token = this._payoutsToken
      try {
        const qs = this.previewUserId != null ? `?as_user_id=${this.previewUserId}` : ''
        const data = await api.get(`/api/investor${qs}`)
        if (token !== this._payoutsToken) return // superseded — drop the result
        this.data = data
      } catch (err) {
        throw err
      } finally {
        if (token === this._payoutsToken) this.isLoading = false
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
    // ⚠️ THE HANDLE IS RELEASED ONLY IF IT IS STILL OURS. The `.finally()` used to
    // null `_payoutsInFlight` unconditionally, so a request superseded by a
    // preview switch released the handle of the request that REPLACED it:
    // resetPayouts() nulls the handle and bumps the token, the new request stores
    // its own handle, then the old request settles and nulls that one. From then
    // on the dedupe is off, and the next concurrent caller — InvestorView and
    // PayoutsSection both ask on mount — fires a second request. Not a
    // correctness bug (both carry the current token and the same scope), but
    // GET /api/investor/payouts runs reconcileInvestorPayouts(), which WRITES, so
    // the cost is a redundant write to the payout ledger, not a wasted round trip.
    async loadPayouts(overrideUserId) {
      const scopeId = overrideUserId !== undefined ? overrideUserId : this.previewUserId
      if (this._payoutsInFlight) return this._payoutsInFlight
      this.payoutsLoading = true
      const tracked = this._fetchPayouts(scopeId, this._payoutsToken).finally(() => {
        if (this._payoutsInFlight === tracked) this._payoutsInFlight = null
      })
      this._payoutsInFlight = tracked
      return tracked
    },

    async _fetchPayouts(scopeId, token) {
      try {
        const qs = scopeId != null ? `?as_user_id=${scopeId}` : ''
        const data = await api.get(`/api/investor/payouts${qs}`)
        if (token !== this._payoutsToken) return // superseded — drop the result
        this.payouts = data.payouts || []
        this.currentMonth = data.currentMonth || null
        // Spread OVER the factory rather than replacing it, so the slice always
        // holds the full shape even if the wire omits a key — the store's shape
        // then cannot drift from the default no matter what the server sends.
        this.payoutTotals = { ...emptyPayoutTotals(), ...(data.totals || {}) }
        this.payoutsFailed = false
        this.payoutsNotFound = false
      } catch (err) {
        if (token !== this._payoutsToken) return
        this.payouts = []
        this.currentMonth = null
        this.payoutTotals = emptyPayoutTotals()
        this.payoutsFailed = true
        this.payoutsNotFound = err.status === 404
      } finally {
        if (token === this._payoutsToken) this.payoutsLoading = false
      }
    },

    // Fetch (and cache) the per-month line-item drill-down for a single period.
    // Threads the preview scope as ?as_user_id= exactly like loadPayouts(); the
    // component passes its previewUserId prop explicitly (it renders standalone on
    // /my-payouts, where the store holds no previewUserId). Resolves to the detail
    // payload; throws on failure so the caller can render an inline error and retry
    // (a rejected fetch is NOT cached, so the next open tries again).
    //
    // ⚠️ IT CARRIES THE SAME `_payoutsToken` STALENESS GUARD AS _fetchPayouts(),
    // and it is a cross-investor leak without it. resetPayouts() empties
    // payoutDetailCache on a preview switch, but emptying a cache does nothing
    // about a request that was already in flight when it was emptied:
    //   1. Admin on /investor-portals/1 opens July -> Revenue. Request in flight.
    //   2. Admin moves to /investor-portals/2. setPreview(2) -> resetPayouts()
    //      clears the cache; InvestorView remounts on its :key so PayoutsSection
    //      is destroyed and the modal goes with it.
    //   3. Investor 1's response lands and writes payoutDetailCache['2026-07'].
    //      The store is a singleton, so that cache now belongs to investor 2.
    //   4. Admin opens July -> Revenue for investor 2. The `if (cache[period])`
    //      short-circuit returns INVESTOR 1's loads, driver-pay rows, fixed-cost
    //      items and trip expenses, rendered under investor 2's name, with no
    //      network call at all.
    // Persistent, not a momentary flash — it sticks until the next reset. This is
    // exactly the failure `_payoutsToken` was introduced for on the ledger; this
    // sibling fetch simply never used it.
    //
    // A superseded response is DROPPED, not cached and not returned: throwing is
    // the honest answer to "the scope you asked about is no longer on screen",
    // the documented contract already lets this reject, and PayoutsSection's
    // caller wraps the await in try/catch. In the reachable flow that caller is
    // already unmounted, so nothing renders; a caller that did survive gets an
    // error instead of another investor's money, which is the right direction to
    // fail. The rejection carries `superseded` so a future caller can tell it
    // apart from a real fetch failure and stay silent instead of alarming.
    async fetchPayoutDetail(period, overrideUserId) {
      if (this.payoutDetailCache[period]) return this.payoutDetailCache[period]
      const scopeId = overrideUserId !== undefined ? overrideUserId : this.previewUserId
      const qs = scopeId != null ? `?as_user_id=${scopeId}` : ''
      const token = this._payoutsToken
      const data = await api.get(`/api/investor/payouts/${encodeURIComponent(period)}/detail${qs}`)
      if (token !== this._payoutsToken) {
        const err = new Error('Payout detail request was superseded by a scope change.')
        err.superseded = true
        throw err
      }
      this.payoutDetailCache[period] = data
      return data
    },

    // Same `_payoutsToken` scope guard, third sibling. The PUT is scoped by the
    // session (it takes no as_user_id), but the local write-back is not: without
    // the token check a config saved while viewing one investor lands on
    // `this.data.config` AFTER a preview switch has replaced `data` with another
    // investor's payload, so investor B's dashboard renders investor A's view
    // configuration. Not reachable today — the preview is read-only and hides
    // ConfigPanel, so `data` can only be swapped by leaving the config screen
    // entirely — but it is the identical one-line guard, and "not reachable
    // today" is what made the two leaks above ship.
    //
    // A superseded response DROPS the local write and does NOT throw: the PUT
    // itself succeeded, so reporting a failure would be a lie. The caller
    // (InvestorView.handleSaveConfig) re-fetches with `load()` immediately
    // after, and a scope change re-fetches on mount, so the cache is refilled
    // from the server either way.
    async updateConfig(config) {
      const token = this._payoutsToken
      const data = await api.put('/api/investor/config', config)
      if (token !== this._payoutsToken) return // superseded — don't touch the new scope's data
      if (this.data) {
        this.data.config = data.config || config
      }
    },

    // Enter preview mode for a given investor user_id. Reset data so the UI
    // doesn't flash stale numbers from the previously-previewed investor
    // while the new fetch is in flight (singleton store gotcha).
    //
    // ⚠️ THESE TWO ARE THE ONLY BUMPERS OF `_payoutsToken`, AND THEY MUST STAY
    // AHEAD OF THE NEXT load(). Both set `isLoading = true`, and load() now
    // clears it only for the request that still owns the scope — so a bump that
    // lands AFTER the destination view has already fired load() would drop that
    // response and leave the spinner up for good. It cannot happen today:
    // InvestorPortalPreviewView calls clearPreview() from onBeforeUnmount, and
    // Vue unmounts the outgoing view before mounting the incoming one (verified
    // against the real runtime), so the bump always precedes the new load().
    // That holds because App.vue renders a BARE `<router-view />`. Wrapping it in
    // a `<Transition>` without `mode="out-in"` overlaps leave and enter, inverts
    // that order, and strands /investor on a permanent skeleton after exiting a
    // preview — so if a route transition is ever added, use `mode="out-in"`.
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
      this.payoutTotals = emptyPayoutTotals()
      this.payoutsLoading = true
      this.payoutsFailed = false
      this.payoutsNotFound = false
      this._payoutsInFlight = null
      this._payoutsToken += 1
      this.payoutDetailCache = {}
    },
  },
})
