// The one key the client compares driver names by.
//
// It mirrors normalizeDriverName() in server.js exactly: trim, lowercase, and
// read every run of whitespace as one space. One driver reaches the screen under
// several spellings — the drivers directory, the account, the truck assignment,
// a Job Tracking Driver cell, an ELD ping — and they can differ in case and in
// spacing ("Rodney  Brown" next to "Rodney Brown"). Compared any other way, one
// driver is listed twice, or a ping, a load or a clock is filed under nobody.
//
// Keep it identical to the server's rule rather than "smarter": the server
// decides which spellings name the same driver, and a client that disagreed
// would show a match the server never made, or miss one it did.
// scripts/test-driver-name-key-parity.mjs runs both on the same inputs.

export function normDriver(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ')
}
