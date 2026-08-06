import { defineStore } from 'pinia'
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

// Scoped to the browser TAB, not to the login session — sessionStorage survives
// a reload and every in-SPA navigation, and dies only when the tab does. So the
// popup shows once per tab: a mid-session refresh doesn't nag, a new tab or a
// relaunched browser shows it again.
//
// Read that literally, because it is not the same thing as "once per login".
// Logging out does not clear it: auth's logout() resets store state without
// touching storage or reloading, and App.vue fetches this config once in
// onMounted and never again. Two investors sharing one tab therefore share one
// dismissal — the second one logs in and sees no popup (the red banner and the
// inline disclaimers still render for them, so the notice itself is not lost).
// Keying the dismissal per user would close that gap; it is a deliberate
// behaviour change and hasn't been signed off, so it is NOT done here.
//
// Bumping the server-side MAINTENANCE_NOTICE_VERSION re-shows the popup to
// everyone who already dismissed it, which is the intended way to re-nag.
function dismissKeyFor(version) {
  return `logisx.maintenanceNotice.dismissed.v${version}`
}

function readDismissed(version) {
  try {
    return sessionStorage.getItem(dismissKeyFor(version)) === '1'
  } catch {
    return false // private mode / storage disabled — show it rather than hide it
  }
}

export const useMaintenanceStore = defineStore('maintenance', {
  state: () => ({
    ...DEFAULTS,
    loaded: false,
    // Mirrors sessionStorage. Kept in state so the modal reacts to dismissal
    // without every component re-reading storage.
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

    // The popup is one-shot per session; the banner is not.
    showModal() {
      return this.active && !this.modalDismissed
    },
  },

  actions: {
    // Fetch once per app load. Never throws: a failure leaves `enabled` false,
    // which is the safe direction (no false alarm shown to an investor).
    async fetchConfig() {
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
        this.modalDismissed = readDismissed(this.version)
        this.loaded = true
      }
    },

    dismissModal() {
      this.modalDismissed = true
      try {
        sessionStorage.setItem(dismissKeyFor(this.version), '1')
      } catch {
        /* storage unavailable — dismissal just won't survive a refresh */
      }
    },
  },
})
