// Is another tab of this app open? A sign-out the app starts by itself takes every other tab with it
// (stores/auth.js follows it), and this page can't see what's typed or on its way out in them. So
// every page of the app keeps a record in this browser while it's open, and a sign-out holds while
// another page's record stands. Nothing has to answer, so a tab the phone has frozen, or one too busy
// to reply, holds all the same. A record is a random page id and a time: no name, no account.
// Pinned by scripts/test-driver-release-notices-client.mjs.

const RECORD_PREFIX = 'logisx.appPage.v1.'
// A tab that died without saying so holds the sign-out until then. That costs the driver only the
// update at their next sign-in, which a session of the same length brings anyway.
export const RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const RECORD_REWRITE_MS = 60 * 60 * 1000

const stillCounts = (written, nowMs) => nowMs - Number(written) < RECORD_MAX_AGE_MS
const everyRewrite = (fn) => setInterval(fn, RECORD_REWRITE_MS)?.unref?.()

export function openAppTabs(storage, { now = () => Date.now(), page = globalThis.window, doc = globalThis.document, every = everyRewrite } = {}) {
  const ownKey = RECORD_PREFIX + Math.random().toString(36).slice(2)

  const write = () => {
    try {
      storage.setItem(ownKey, String(now()))
    } catch {
      /* otherPageOpen() finds no record and holds */
    }
  }
  const remove = () => {
    try {
      storage.removeItem(ownKey)
    } catch {
      /* a record left behind goes when it expires */
    }
  }
  function recordKeys() {
    const keys = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key && key.startsWith(RECORD_PREFIX)) keys.push(key)
    }
    return keys
  }

  // Tabs that died without saying so can't pile up: whichever page starts next tidies them away.
  try {
    const nowMs = now()
    for (const key of recordKeys()) {
      if (!stillCounts(storage.getItem(key), nowMs)) storage.removeItem(key)
    }
  } catch {
    /* they stay until a page can tidy them, and they count for nothing once expired */
  }
  write()
  // A tab that's running stays counted however long it's left; a frozen or dead one runs nothing and ages out.
  every(write)

  page?.addEventListener?.('pagehide', remove)
  // Back from the browser's page cache.
  page?.addEventListener?.('pageshow', write)
  // In use again: a tab someone uses counts past a record's age, where a dead one doesn't.
  doc?.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState === 'visible') write()
  })

  return {
    // true: another page's record stands. false: none does. null: this browser can't tell, which the
    // sign-out takes as a no, as it does any input it hasn't got. A record of its own gone missing
    // means the records can't be relied on this time. Never throws.
    otherPageOpen() {
      try {
        if (storage.getItem(ownKey) === null) {
          write()
          return null
        }
        const nowMs = now()
        return recordKeys().some((key) => key !== ownKey && stillCounts(storage.getItem(key), nowMs))
      } catch {
        return null
      }
    },
  }
}

let thisPage = null
// This page's one record. main.js starts it, so every page of the app counts from then on.
export function thisPageTabs() {
  if (!thisPage) {
    let storage = null
    try {
      storage = window.localStorage
    } catch {
      /* no storage to read: otherPageOpen() says it can't tell */
    }
    thisPage = openAppTabs(storage)
  }
  return thisPage
}
