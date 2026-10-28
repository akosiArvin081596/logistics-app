// The logins more than one person has used. A row written under one of them
// (an audit row, an invoice's "Manual by", a payout-basis change) names the
// login, never the person. The server's copy is SHARED_LOGIN_USERNAMES in
// lib/sign-in.js; scripts/test-shared-login-labels.mjs keeps the two identical.
export const SHARED_LOGIN_USERNAMES = Object.freeze(['super_admin'])

export const SHARED_LOGIN_NOTE = 'shared login, person not recorded'

export function isSharedLogin(name) {
  return SHARED_LOGIN_USERNAMES.includes(String(name ?? '').trim().toLowerCase())
}

// How an actor's name is shown: "super_admin · shared login, person not
// recorded" for a shared login, otherwise the name as given (trimmed).
export function actorLabel(name) {
  const shown = String(name ?? '').trim()
  return isSharedLogin(shown) ? `${shown} · ${SHARED_LOGIN_NOTE}` : shown
}

// The staff desk names a message can come from when its thread's party is not
// known. Kept as the fallback for isStaffMessage().
const STAFF_DESK_SENDERS = Object.freeze(['dispatch', 'admin', 'super_admin'])
const foldName = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

// Whether a chat message was sent by staff (shown as "sent"). A thread is
// between staff and one party, a driver by driver name or an investor by
// username: everything not from that party came from staff, whatever name a
// staff member sent it under (a named Super Admin sends as himself). Without a
// party, only the staff desk names count.
export function isStaffMessage(from, party) {
  const sender = foldName(from)
  if (!sender) return false
  const p = foldName(party)
  if (p) return sender !== p
  return STAFF_DESK_SENDERS.includes(sender)
}
