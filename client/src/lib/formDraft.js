// Draft persistence for the long public forms (/apply, /invest).
//
// WHY THIS EXISTS
// Both forms are 20+ minutes of typing across 3-5 steps, so losing the lot to a
// stray refresh or a back-navigation is a real abandonment problem. That is the
// behaviour this module preserves.
//
// WHAT IT REFUSES TO DO
// It will not write identity or financial credentials to disk. Both forms used to
// persist the whole form object to `localStorage`, which has no expiry and is not
// scoped to the tab — so an applicant who abandoned the form on a shared or public
// computer left their SSN / EIN / bank routing + account numbers sitting in that
// browser indefinitely, readable from devtools or by any script on the origin.
//
// THE RULE, in one line:
//   credentials live in memory only; convenience data is tab-scoped and expires.
//
// Three mechanisms, each covering what the others cannot:
//   1. `sensitiveKeys` are stripped before the write. A value that is never written
//      cannot be read back, whatever happens to the store. This is the only one of
//      the three that defends the "next person opens devtools on the same open tab"
//      case, because sessionStorage is fully readable there.
//   2. `sessionStorage`, not `localStorage`. The draft dies with the tab, while
//      still surviving a refresh and a back-navigation — i.e. exactly the failure
//      the persistence was written for, and nothing beyond it.
//   3. A TTL. sessionStorage is already tab-scoped, so this covers one specific
//      residual: browsers that restore a session ("continue where you left off")
//      restore sessionStorage with it, so an abandoned tab can come back days
//      later on a shared machine.
//
// ⚠️ Sensitive keys are matched EXACTLY, never by substring. `account_number` is
// sensitive; `account_type` and `account_name` are not, and a substring rule would
// eat both. (Same trap `lib/pii-mask.js` documents on the server side.)

const SCHEMA_VERSION = 1

// 12 hours. Long enough that nobody filling one of these forms in a sitting — even
// with a lunch break — ever hits it, short enough that a restored tab from a
// previous day comes back empty.
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000

// Recursively drop `keys` (exact name match, any depth). Arrays are mapped so the
// per-vehicle rows in /invest are covered as well as the top-level objects.
function stripKeys(value, keys) {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, keys))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (keys.has(k)) continue
      out[k] = stripKeys(v, keys)
    }
    return out
  }
  return value
}

/**
 * @param {object}   opts
 * @param {string}   opts.key            sessionStorage key for the draft
 * @param {string[]} opts.sensitiveKeys  field names never written to any store
 * @param {string[]} opts.legacyKeys     localStorage keys to PURGE on first load
 * @param {number}   opts.ttlMs
 */
export function createFormDraft({ key, sensitiveKeys = [], legacyKeys = [], ttlMs = DEFAULT_TTL_MS }) {
  const sensitive = new Set(sensitiveKeys)

  // Delete the pre-fix `localStorage` drafts. Shipping a change that only stops
  // NEW writes would leave every already-exposed SSN and account number exactly
  // where it is, forever — the browsers holding them are the whole finding.
  //
  // ⚠️ Deliberately a purge and NOT a migration. Migrating the non-sensitive half
  // into the new store would be nicer UX, but on the shared computer this fix
  // exists for, the person at the keyboard is not necessarily the person who
  // typed it — so restoring a stranger's name and address into a fresh session is
  // the same disclosure by another route.
  function purgeLegacy() {
    for (const k of legacyKeys) {
      try { localStorage.removeItem(k) } catch { /* private mode / disabled */ }
    }
  }

  function save(data) {
    try {
      sessionStorage.setItem(key, JSON.stringify({
        v: SCHEMA_VERSION,
        savedAt: Date.now(),
        data: stripKeys(data, sensitive),
      }))
    } catch { /* quota or disabled — fall back to in-memory only */ }
  }

  function load() {
    purgeLegacy()
    try {
      const raw = sessionStorage.getItem(key)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (!parsed || parsed.v !== SCHEMA_VERSION || typeof parsed.savedAt !== 'number') {
        clear()
        return null
      }
      if (Date.now() - parsed.savedAt > ttlMs) {
        clear()
        return null
      }
      // Strip on read as well as on write. A draft written by an older build of
      // this bundle (open tab across a deploy) can still carry the fields.
      return stripKeys(parsed.data ?? null, sensitive)
    } catch {
      clear()
      return null
    }
  }

  function clear() {
    try { sessionStorage.removeItem(key) } catch { /* ignore */ }
    purgeLegacy()
  }

  return { save, load, clear, purgeLegacy }
}

/**
 * Delete a whole IndexedDB database, used to clear the /apply photo store.
 * Best-effort and never throws: `deleteDatabase` blocks indefinitely while another
 * tab holds the DB open, so this resolves on success, error AND blocked.
 */
export function deleteIndexedDb(name) {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve()
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch { resolve() }
  })
}
