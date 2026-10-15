// The "New password" / "Confirm new password" pair in Users › Edit User (B21).
//
// A browser's saved-login autofill once dropped the signed-in admin's own
// password into another account's "New password" field, and Save reset that
// account to it. Autofill fills one field, never a matching second one, so a
// password is sent only when both fields hold the same text:
//   - both blank: keep the current password (no password is sent);
//   - different, or only one filled: Save stays disabled;
//   - the same: that password is sent.
// Existing passwords are never shown: the server never sends them, and both
// fields open empty.
export function passwordChange(newPassword, confirmPassword) {
  const next = typeof newPassword === 'string' ? newPassword : ''
  const confirm = typeof confirmPassword === 'string' ? confirmPassword : ''
  if (!next && !confirm) return { canSave: true, keepCurrent: true, mismatch: false, password: null }
  if (next !== confirm) return { canSave: false, keepCurrent: false, mismatch: true, password: null }
  return { canSave: true, keepCurrent: false, mismatch: false, password: next }
}

// What the form says under the pair, or '' when nothing needs saying.
export function passwordChangeHint(newPassword, confirmPassword) {
  const state = passwordChange(newPassword, confirmPassword)
  if (!state.mismatch) return ''
  return confirmPassword ? "The passwords don't match." : 'Type the new password again to confirm it.'
}
