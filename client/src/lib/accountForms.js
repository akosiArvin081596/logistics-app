// Users › Add User, and the sign-in page's hint.
//
// The password is typed twice (src/lib/passwordFields.js): autofill fills one
// field, never a matching second one, so a saved login dropped into the form
// cannot become the new account's password unnoticed. The form keeps what was
// typed until the server accepts the account.
import { passwordChange, passwordChangeHint } from './passwordFields.js'

export const STAFF_ROLES = Object.freeze(['Super Admin', 'Dispatcher'])
export const STAFF_PASSWORD_NOTE = 'Staff accounts change this password at first sign-in.'
export const USERNAME_TIP = 'Tip: sign in with your username.'

// What Add User sends, or why it can't: { body } or { error }.
export function newUserRequest(form) {
  const f = form || {}
  const username = String(f.username ?? '').trim()
  const pw = passwordChange(f.password, f.confirmPassword)
  if (!username || pw.keepCurrent) return { error: 'Username and password required.' }
  if (pw.mismatch) return { error: passwordChangeHint(f.password, f.confirmPassword) }
  if (f.role === 'Driver' && !f.driverName) return { error: 'Select a driver name for Driver role.' }
  return {
    body: {
      username,
      password: pw.password,
      role: f.role,
      driverName: f.role === 'Driver' ? f.driverName : '',
      email: String(f.email ?? '').trim(),
      fullName: String(f.fullName ?? '').trim(),
    },
  }
}

// The note under the password pair: only for a staff role, and only while the
// server makes new staff accounts change the password at first sign-in
// (GET /api/users newStaffMustChangePassword).
export function staffPasswordNote(role, forcedChange) {
  return forcedChange && STAFF_ROLES.includes(role) ? STAFF_PASSWORD_NOTE : ''
}

// A refused create: the message the form shows, and whether the password pair
// is emptied (PASSWORD_IS_YOURS: it holds the signed-in admin's own password).
export function addUserRefusal(err) {
  return {
    message: (err && err.message) || 'The account could not be created. Try again.',
    clearPasswords: !!err && err.code === 'PASSWORD_IS_YOURS',
  }
}

// The sign-in page's hint after a refusal: an email may be on more than one
// account, and then only the username signs in. Shown for any 401 when the
// typed name holds "@", so it says nothing about whether that email exists.
export function signInTip(status, typed) {
  return status === 401 && String(typed ?? '').includes('@') ? USERNAME_TIP : ''
}
