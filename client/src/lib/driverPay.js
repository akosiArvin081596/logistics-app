// The three pay cells a Drivers Database save sends: PayType, PayPercentage and
// PayDaily, the last three of the directory's headers. The Add Driver form
// (POST /api/drivers-directory) and the Edit dialog (PUT
// /api/drivers-directory/:id) both build them here.
//
// ⚠️ TEXT IS A VALUE; A NUMBER 0 IS "NOT SENT". Both routes read the body with
// `values[i] || ""`, so a NUMBER 0 arrives as "", which means "not sent": an
// edit keeps the stored value, and a create takes the column default. That
// mapping stays, so a page loaded before this rule never wipes stored terms
// with its zeros. The TEXT "0" is a value. On the daily rate it clears the
// driver's own rate, and resolveDailyRate() falls back to the truck's rate,
// else $250. On the share it is 0 %. So:
//   • the active pay type's amount goes as text, "0" included. A blank field
//     goes as "0", which is what the form says blank means ("Leave blank/0 to
//     use the assigned truck's rate"). Anything else goes as typed, so the
//     server's range and number checks (400 INVALID_PAY) still answer it;
//   • the other type's amount goes as "" (not sent), so a save, or a switch of
//     the pay type, never touches the terms stored for the type not in use;
//   • anyone who may not edit pay sends all three as "". The server refuses a
//     pay change from anyone but a Super Admin (403 PAY_EDIT_ADMIN_ONLY).
// The server's half of this contract is the comment at the body mapping of
// both routes in server.js. scripts/test-driver-pay-cells.mjs pins this
// function, and scripts/test-driver-pay-clear.js runs its cells through the
// shipped handlers.
//
// Pure: no Vue, no DOM, so it runs under plain Node.

// One amount as the text the server reads. The inputs use v-model.number, so
// a field holds a number, or "" when it is blank.
function amountCell(value) {
  if (typeof value === 'number') return String(value)
  const text = String(value ?? '').trim()
  return text === '' ? '0' : text
}

export function directoryPayCells({ canEditPay, payType, payPercentage, payDaily }) {
  if (!canEditPay) return ['', '', '']
  if (payType === 'percentage') return ['percentage', amountCell(payPercentage), '']
  if (payType === 'fixed') return ['fixed', '', amountCell(payDaily)]
  // A type the radios do not offer, such as a legacy "Fixed" the row was
  // stored with: neither amount field is on screen, so neither was edited.
  // The type goes as loaded (the server lowercases it) and both amounts as
  // not sent, as before this rule.
  return [payType ?? '', '', '']
}
