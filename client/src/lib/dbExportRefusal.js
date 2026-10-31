// What the Admin Tools "Download database backup" button says when the server
// answers 403.
//
// The server limits the database routes to the accounts in
// RATECON_PDF_VIEWER_IDS and answers everyone else 403 DB_DOWNLOAD_RESTRICTED
// with its own sentence ("limited to the owner", or "sign in again" for an
// out-of-date session). That refusal is about the account, not about where the
// request came from, so it gets no cross-site hint. Any other 403 is the
// cross-site guard or the role check and keeps the wording it always had.
//
// Returns { title, error, hint } for a 403, null for anything else.
// scripts/test-db-export-refusal.mjs covers every branch.

export const DB_DOWNLOAD_RESTRICTED = 'DB_DOWNLOAD_RESTRICTED'
export const DB_DOWNLOAD_RESTRICTED_TITLE = 'Not available for this account.'
export const DB_DOWNLOAD_RESTRICTED_TEXT = 'Downloading the database is limited to the owner.'

export function dbExportRefusalText(status, data) {
  if (status !== 403) return null
  const body = data && typeof data === 'object' ? data : {}
  const serverText = typeof body.error === 'string' && body.error.trim() ? body.error : ''
  if (body.code === DB_DOWNLOAD_RESTRICTED) {
    return { title: DB_DOWNLOAD_RESTRICTED_TITLE, error: serverText || DB_DOWNLOAD_RESTRICTED_TEXT, hint: '' }
  }
  return {
    title: 'Refused.',
    error: serverText || 'The export is available to Super Admins, from this site only.',
    hint: 'Open LogisX directly rather than through a link from another site, then try again.',
  }
}
