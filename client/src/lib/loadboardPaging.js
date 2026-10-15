// Loadboard paging (R8, owner request): display only.
//
//   - Active Loads shows every active load on one page; it pages only above
//     ACTIVE_LOADS_PAGE_SIZE, with no size choice.
//   - Job Board and Completed start at 25 a page with a 10/25/50/100 choice,
//     remembered per user and per tab in localStorage.
//
// Storage is optional: private mode, a full quota or a blocked localStorage
// must never break the page, so every read and write is wrapped and falls back
// to the default (a choice then lasts until the page reloads).
// Runner: scripts/test-loadboard-paging.mjs.

export const LOADBOARD_PAGE_SIZES = Object.freeze([10, 25, 50, 100])
export const LOADBOARD_DEFAULT_PAGE_SIZE = 25
export const ACTIVE_LOADS_PAGE_SIZE = 50

export function isLoadboardPageSize(n) {
  return LOADBOARD_PAGE_SIZES.includes(n)
}

// One key per tab and per signed-in user; no user, no key.
export function pageSizeKey(tab, userId) {
  if (!tab || userId == null || userId === '') return null
  return `logisx.loadboard.pageSize.${tab}.u${userId}`
}

// The page's localStorage, or null where there is none or reaching it throws.
export function browserStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readPageSize(storage, key) {
  if (!storage || !key) return LOADBOARD_DEFAULT_PAGE_SIZE
  try {
    const raw = storage.getItem(key)
    const n = raw == null || raw === '' ? NaN : Number(raw)
    return isLoadboardPageSize(n) ? n : LOADBOARD_DEFAULT_PAGE_SIZE
  } catch {
    return LOADBOARD_DEFAULT_PAGE_SIZE
  }
}

// true when the size was written.
export function savePageSize(storage, key, size) {
  if (!storage || !key || !isLoadboardPageSize(size)) return false
  try {
    storage.setItem(key, String(size))
    return true
  } catch {
    return false
  }
}
