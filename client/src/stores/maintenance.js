import { defineStore } from 'pinia'
import { watch } from 'vue'
import { useApi } from '../composables/useApi'
import { useAuthStore } from './auth'
import { useInvestorStore } from './investor'

const api = useApi()

// Fallback copy, used when the config fetch fails. Deliberately NOT "enabled:
// true" — a network blip must never invent a maintenance notice out of thin air.
// The server owns the real strings (MAINTENANCE_NOTICE_* env vars) so the client
// can retune the wording without a redeploy.
const DEFAULTS = {
  enabled: false,
  // Two headlines, deliberately different. `title` is the red banner's — short,
  // shouted, rendered uppercase. `modalTitle` is the login popup's, in the
  // client's own words. Sharing one string could only ever satisfy one surface.
  title: 'SYSTEM UPDATE IN PROGRESS',
  modalTitle: 'Application is currently under maintenance',
  message:
    'The portal is being updated right now. You can keep using it as normal — nothing here is locked.',
  disclaimer: 'The final settlements are still being calculated.',
  audience: 'investor',
  version: '1',
}

// The popup's dismissal is kept per browser TAB and per PERSON (owner decision,
// 2026-09-26). Per tab because it lives in sessionStorage, which survives a reload
// and every in-SPA navigation and dies only with the tab: a mid-session refresh
// doesn't nag, a new tab or a relaunched browser shows it again. sessionStorage
// ONLY, never localStorage: this is convenience state, and the house rule for that
// is tab-scoped and gone with the tab (lib/formDraft.js).
//
// Per person because the key carries the signed-in user's id. A sign-out, and a
// sign-in as someone else, load a fresh page in the same tab (stores/auth.js), and
// sessionStorage survives that load like any other reload, so under the old
// tab-only key two investors sharing one tab shared one dismissal: the second one
// signed in and never saw the popup. Now each person dismisses it once per tab.
// With no user id (nobody signed in yet, or the id-less user setup() builds for
// itself) nothing is read or saved: not dismissed, and a dismissal lasts only
// until this page is reloaded.
//
// Bumping the server-side MAINTENANCE_NOTICE_VERSION re-shows the popup to
// everyone who already dismissed it, which is the intended way to re-nag.
function dismissKeyFor(version, userId) {
  return `logisx.maintenanceNotice.dismissed.v${version}.u${userId}`
}

function hasUserId(userId) {
  return userId != null && userId !== ''
}

function readDismissed(version, userId) {
  if (!hasUserId(userId)) return false
  try {
    return sessionStorage.getItem(dismissKeyFor(version, userId)) === '1'
  } catch {
    return false // private mode / storage disabled — show it rather than hide it
  }
}

export const useMaintenanceStore = defineStore('maintenance', {
  state: () => ({
    ...DEFAULTS,
    loaded: false,
    // Mirrors sessionStorage, for the person signed in. Kept in state so the
    // modal reacts to dismissal without every component re-reading storage.
    modalDismissed: false,
  }),

  getters: {
    // Does the current viewer fall inside the configured audience?
    //
    // 'all'      → every authenticated user
    // 'investor' → the Investor role, PLUS a Super Admin sitting inside the
    //              read-only investor-portal preview. The preview exists so an
    //              admin can see exactly what the investor sees; hiding the
    //              notice there would defeat that.
    inAudience() {
      const auth = useAuthStore()
      if (!auth.isAuthenticated) return false
      if (this.audience === 'all') return true
      if (this.audience === 'investor') {
        if (auth.isInvestor) return true
        const investor = useInvestorStore()
        return auth.isSuperAdmin && investor.isPreview
      }
      return false
    },

    // The single switch every maintenance surface reads. Banner, modal and the
    // inline disclaimer are all gated on this, so one env var turns the whole
    // feature on or off.
    active() {
      return this.loaded && this.enabled && this.inAudience
    },

    // The popup shows once per tab and person; the banner always does.
    showModal() {
      return this.active && !this.modalDismissed
    },
  },

  actions: {
    // Fetch once per app load. Never throws: a failure leaves `enabled` false,
    // which is the safe direction (no false alarm shown to an investor).
    //
    // The dismissal is read when the config lands, AND again whenever the signed-in
    // user's id changes. The second read is not optional: App.vue calls this in
    // onMounted while the router's first navigation is still waiting on the session
    // check, so this `finally` can run before anyone is signed in, when there is no
    // id to read a dismissal for. Without it, a person who had dismissed the popup
    // would get it back on every reload that fetched the config faster than the
    // session. The same watch covers an in-app sign-in.
    async fetchConfig() {
      this._followUser()
      try {
        const data = await api.get('/api/config/maintenance')
        this.enabled = !!data?.enabled
        this.title = data?.title || DEFAULTS.title
        // Falls back to `title` before DEFAULTS.modalTitle: a server that
        // predates this field (an older deploy, or a rollback) should show the
        // banner headline in the popup — the behaviour before the split — not a
        // sentence the operator never configured.
        this.modalTitle = data?.modalTitle || data?.title || DEFAULTS.modalTitle
        this.message = data?.message || DEFAULTS.message
        this.disclaimer = data?.disclaimer || DEFAULTS.disclaimer
        this.audience = data?.audience || DEFAULTS.audience
        this.version = String(data?.version ?? DEFAULTS.version)
      } catch {
        this.enabled = false
      } finally {
        this.modalDismissed = readDismissed(this.version, useAuthStore().user?.id)
        this.loaded = true
      }
    },

    // Installed once per store, by the first fetchConfig(). Synchronous, so the
    // dismissal changes in the same tick as the user, never a render later.
    _followUser() {
      if (this._followingUser) return
      this._followingUser = true
      const auth = useAuthStore()
      watch(
        () => auth.user?.id,
        (userId) => {
          this.modalDismissed = readDismissed(this.version, userId)
        },
        { flush: 'sync' },
      )
    },

    dismissModal() {
      this.modalDismissed = true
      const userId = useAuthStore().user?.id
      if (!hasUserId(userId)) return // nobody to remember it for: this page load only
      try {
        sessionStorage.setItem(dismissKeyFor(this.version, userId), '1')
      } catch {
        /* storage unavailable — dismissal just won't survive a refresh */
      }
    },
  },
})
