// THE month formatter: a period key -> "August 2026". One definition, one
// contract, for every surface in the client that names a month.
//
// WHY THIS FILE EXISTS. Two modules in THIS directory exported a function called
// `monthLabel` with OPPOSITE failure behaviour: lib/fuelReview.js returned ''
// when it could not read the key, lib/payoutPeriod.js returned the raw input
// string. Same name, same directory, silently different contract — so a caller
// that imported "the other one" rendered `2026-13` on screen where it expected
// to render nothing, and neither import site looked wrong. That is a trap for
// the next author, not a style question, which is why the arithmetic now lives
// here and the others delegate instead of re-implementing.
//
// ---------------------------------------------------------------------------
// THE CONTRACT — tolerant on input, EMPTY on failure
// ---------------------------------------------------------------------------
//   monthLabel('2026-08')      -> 'August 2026'
//   monthLabel('2026-08-01')   -> 'August 2026'   (a day names its own month)
//   monthLabel('2026-13')      -> ''              (there is no month 13)
//   monthLabel('') / null / 7  -> ''
//
// '' ON FAILURE IS THE LOAD-BEARING HALF. Every caller here renders the result
// straight into a sentence or a heading, and most of them guard on it
// (`if (!posted) return`, `monthLabel(p) || p`). An unreadable key must produce
// NOTHING — a blank where a month name would have been is obviously incomplete,
// whereas echoing the raw key prints `2026-13` into a driver-facing note as
// though it were a real month we had understood.
//
// TOLERANT ON INPUT because the callers genuinely hold both shapes: the fuel and
// data-issue queues carry a `localDay` / `receiptDate` ('YYYY-MM-DD'), while the
// posting-period and payout paths carry a bare month ('YYYY-MM'). Matching a
// 'YYYY-MM' PREFIX serves both without asking each caller to slice first.
//
// ⚠️ STRING ARITHMETIC ONLY — never `new Date(key)`. `new Date('2026-08')` is
// parsed as UTC, so it renders as JULY for any US viewer; the same trap is
// documented at length in utils/datetime.js. This implementation is
// payoutPeriod's (index into a name table, slice the year out of the string),
// kept because it cannot touch a timezone at all. The `new Date(y, m-1, 1)` +
// `toLocaleDateString` form the other copies used is safe by accident — it
// happens to use the local-time constructor — and one edit away from not being.
//
// Pure: no Vue, no network, no imports. The '.js' on every specifier that points
// at this file is deliberate, so bare Node (the scripts/test-*.js locks) can
// import it as well as Vite; Node ESM rejects an extensionless specifier with
// ERR_MODULE_NOT_FOUND before a single assertion runs.

/** Frozen so a caller that reaches for the names cannot reorder them. */
export const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
])

// A PREFIX match, not an anchored one: 'YYYY-MM' and 'YYYY-MM-DD' both qualify.
const MONTH_PREFIX_RE = /^(\d{4})-(\d{2})/

/**
 * '2026-08' or '2026-08-01' -> 'August 2026'. '' for anything this cannot read,
 * including a well-formed key naming a month that does not exist ('2026-00',
 * '2026-13'). See the contract note above before changing either half.
 */
export function monthLabel(key) {
  const m = MONTH_PREFIX_RE.exec(String(key ?? '').trim())
  if (!m) return ''
  const name = MONTH_NAMES[Number(m[2]) - 1]
  return name ? `${name} ${m[1]}` : ''
}
