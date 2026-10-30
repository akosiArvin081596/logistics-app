// Heuristic: does this load row need dispatcher attention?
// True when the n8n extraction pipeline produced a partial row — i.e. the
// rate-con PDF didn't parse cleanly and one of the columns body-fallback
// can't recover is still blank or holds a placeholder — or when the server
// says the load's rate-con driver instructions need a person: it sends their
// review codes on the open loads' rows as `_instructionsReview` (codes only,
// while its flag is on) — or when the server says the rate con marked the
// pickup date "Needs Confirmation": a `_review` entry (below). The client words
// the codes; it never works one out.
//
// Single source of truth, used by ActiveLoadsTab / JobBoardTab /
// CompletedLoadsTab for both the row-level badge and the
// "Needs Review only" filter toggle. Display only: no total reads it.
// Runner: scripts/test-load-review.mjs.

import { MONTH_NAMES, monthLabel } from './monthLabel.js';
import { loadRef } from './loadRef.js';

// Resilient column reads — the sheet stores "  Payment  " with leading/
// trailing whitespace (one of the original headers) and may rename or
// re-pad columns in the future. Match any key whose trimmed lowercase
// form equals the canonical name.
function readField(job, canonical) {
  if (!job) return '';
  const want = canonical.toLowerCase();
  for (const k of Object.keys(job)) {
    if (k.trim().toLowerCase() === want) return (job[k] || '').toString().trim();
  }
  return '';
}

const PLACEHOLDER_RE = /awaiting\s+rate\s+con/i;
const ZERO_RATE_RE = /^\$?\s*0+(\.0+)?\s*$/;

// Words for each driver-instructions review code the server sends (the
// dashboard row carries codes only, no counts). The load detail's Driver
// instructions section shows the server's own sentences.
export const INSTRUCTION_REVIEW_WORDS = Object.freeze({
  no_rate_con: 'no rate con is on file',
  rate_con_unmatched: "a rate-con file names this load but couldn't be matched to it",
  rate_con_not_read: "the rate con on file hasn't been read yet",
  extract_failed: "the rate con couldn't be read",
  load_number_unconfirmed: "the load number on the rate con doesn't match",
  reference_missed: 'reference-like numbers on the rate con are missing',
  reference_not_on_rate_con: 'some references are not on the rate con',
  unusual_content: 'some items hold another address, redirect wording or no category',
  stop_place_mismatch: "a stop's city or state differs from the load",
  refiltered: 'something stored was withheld under the current rules',
  money_or_number_withheld: 'some references were left out as amounts, phones or account numbers',
  reference_too_long: 'some references were too long and left out',
  reference_unknown_type: "some references had a kind the app doesn't show",
  requirement_missed: "the rate con mentions requirements the instructions don't include",
  stop_count_mismatch: 'the rate con lists a different number of stops',
  not_cross_checked: "the rate con's text can't be checked for completeness",
  suspicious_text: 'some items read like instructions to a computer',
  critical_dropped: 'the newer reading leaves out a critical requirement drivers see now',
  rate_con_changed: 'a newer reading of the rate con is waiting',
});

// The row's driver-instructions codes: strings only, each once, in the order sent.
function instructionCodes(job) {
  const codes = job && Array.isArray(job._instructionsReview) ? job._instructionsReview : [];
  return [...new Set(codes.filter((c) => typeof c === 'string' && c))];
}

// "Needs Confirmation" pickup dates (lib/load-review-flags.js on the server): a
// `_review` entry { code, stored?, arrived?, closedMonth?, replaced? }. The open
// code has a "Mark confirmed" button; the closed-month one can't be edited, so
// it has none. Days come as server-computed 'YYYY-MM-DD' / 'YYYY-MM' strings and
// are read by splitting: a Date built from one shows the day before in US zones.
export const PICKUP_UNCONFIRMED = 'pickup_unconfirmed';
export const PICKUP_UNCONFIRMED_CLOSED = 'pickup_unconfirmed_closed';
export const PICKUP_CONFIRMED_URL = '/api/loads/pickup-confirmed';
const PICKUP_CODES = [PICKUP_UNCONFIRMED, PICKUP_UNCONFIRMED_CLOSED];
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^\d{4}-(\d{2})$/;

function dayKey(v) {
  const m = typeof v === 'string' ? DAY_RE.exec(v) : null;
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return days && d >= 1 && d <= days ? v : '';
}
function monthKey(v) {
  const m = typeof v === 'string' ? MONTH_RE.exec(v) : null;
  return m && Number(m[1]) >= 1 && Number(m[1]) <= 12 ? v : '';
}
// 'YYYY-MM-DD' -> "Oct 17" ('' when it isn't a real day).
function shortDay(v) {
  const k = dayKey(v);
  if (!k) return '';
  const [, m, d] = k.split('-');
  return `${MONTH_NAMES[Number(m) - 1].slice(0, 3)} ${Number(d)}`;
}

// The row's pickup-date entry (the first one sent), keeping only the days it
// can read, or null.
export function pickupReview(job) {
  const list = job && Array.isArray(job._review) ? job._review : [];
  const e = list.find((x) => x && typeof x === 'object' && PICKUP_CODES.includes(x.code));
  if (!e) return null;
  return { code: e.code, stored: dayKey(e.stored), arrived: dayKey(e.arrived), closedMonth: monthKey(e.closedMonth), replaced: e.replaced === true };
}

// The pickup-date reason in words ('' when the row has none).
export function pickupReviewText(job) {
  const e = pickupReview(job);
  if (!e) return '';
  const stored = shortDay(e.stored);
  if (e.code === PICKUP_UNCONFIRMED_CLOSED) {
    const month = monthLabel(e.closedMonth);
    const named = month ? ` (${month})` : '';
    // The server names the stored date's month when that one is closed, else
    // another closed month of the row: say which.
    const where = !e.stored || !e.closedMonth || e.stored.slice(0, 7) === e.closedMonth
      ? `the stored date is in a closed month${named}, so it can't be edited here.`
      : `this load has a date in a closed month${named}, so the pickup date can't be edited here.`;
    return `The rate con marked this pickup date 'Needs Confirmation', and ${where}`;
  }
  const arrived = shortDay(e.arrived);
  const parts = [];
  if (e.replaced) parts.push('A later rate con replaced the pickup date you confirmed.');
  else if (!(arrived && stored)) parts.push("The rate con marks the pickup date 'Needs Confirmation'.");
  if (arrived) {
    parts.push(stored ? `The driver reached the shipper on ${arrived}; the Pickup Appointment says ${stored}.` : `The driver reached the shipper on ${arrived}.`);
    parts.push('Correct the Pickup Appointment or mark it confirmed.');
  } else {
    parts.push('Confirm the real pickup date.');
  }
  return parts.join(' ');
}

// The "Mark confirmed" call, addressed like PUT /api/data/:rowIndex: the row
// index and the key or Load ID as served (loadRef()). null when the row has no
// open pickup code or can't be addressed.
export function pickupConfirmedRequest(job, loadIdCol = '') {
  const e = pickupReview(job);
  if (!e || e.code !== PICKUP_UNCONFIRMED) return null;
  const rowIndex = job._rowIndex;
  const loadId = loadRef(job, loadIdCol).trim();
  if (!Number.isInteger(rowIndex) || rowIndex < 2 || !loadId) return null;
  return { url: PICKUP_CONFIRMED_URL, body: { rowIndex, loadId } };
}

export function canMarkPickupConfirmed(job, loadIdCol = '') {
  return pickupConfirmedRequest(job, loadIdCol) !== null;
}

// The button's title: what the click keeps.
export function pickupConfirmTitle(job) {
  const e = pickupReview(job);
  const stored = e ? shortDay(e.stored) : '';
  return `Keep the Pickup Appointment${stored ? ` (${stored})` : ''} as the real pickup date. The change is logged.`;
}

// The toast once the server answered 200.
export function pickupConfirmedToast(res) {
  return res && res.alreadyConfirmed ? 'This pickup date was already confirmed.' : 'Pickup date marked confirmed.';
}

// A refused or failed call in words: the server's own sentence where it sent one.
export function pickupConfirmErrorText(err) {
  const e = err || {};
  // 404 with no code: the feature is off (a stale key's 404 has its own sentence).
  if (e.status === 404 && e.code !== 'LOAD_KEY_UNKNOWN') return "Marking a pickup date confirmed isn't available right now. Reload the dashboard.";
  if (e.status === 403) return 'Only a Super Admin or a Dispatcher can mark a pickup date confirmed.';
  const said = e.data && typeof e.data.error === 'string' ? e.data.error.trim() : '';
  if (said) return said;
  if (e.status === 0 && typeof e.message === 'string' && e.message) return e.message;
  return 'The pickup date could not be marked confirmed. Try again.';
}

// The open load once the server recorded the confirmation: its pickup entries
// dropped, so the badge clears before the dashboard is read again.
export function withoutPickupReview(job) {
  if (!job || !Array.isArray(job._review)) return job;
  return { ...job, _review: job._review.filter((x) => !(x && typeof x === 'object' && PICKUP_CODES.includes(x.code))) };
}

// After a refresh: the open load's `_review` from its refreshed row ([] when it
// carries none), or null when the row is gone.
export function freshReview(selected, rows) {
  if (!selected || !Array.isArray(rows)) return null;
  const row = rows.find((r) => r && r._rowIndex === selected._rowIndex);
  if (!row) return null;
  return Array.isArray(row._review) ? row._review : [];
}

// The Needs Review toggle's title. Each badge says why its load is flagged, so
// this names no reason and can't fall behind the list.
export const REVIEW_FILTER_TITLE = "Show only loads that need review (each load's badge says why)";

// Why a row is flagged, in display order: 'payment' (blank or $0 Payment),
// 'pickup' / 'drop' (that address still says "Awaiting Rate Con"),
// 'instructions' (the server sent driver-instructions review codes),
// PICKUP_UNCONFIRMED / PICKUP_UNCONFIRMED_CLOSED (the server's pickup-date code).
export function reviewReasons(job) {
  if (!job) return [];
  const out = [];
  // Empty / placeholder Payment is the strongest signal — rate only ever
  // comes from the rate-con PDF, never from email body.
  const payment = readField(job, 'Payment');
  if (!payment || ZERO_RATE_RE.test(payment)) out.push('payment');
  // "Awaiting Rate Con" placeholder on either address means the rate-con
  // didn't parse and the Bison address hardcode also didn't fire. The row
  // shows the geocoded address, so only these words say why it is flagged.
  if (PLACEHOLDER_RE.test(readField(job, 'Pickup Address'))) out.push('pickup');
  if (PLACEHOLDER_RE.test(readField(job, 'Drop-off Address'))) out.push('drop');
  if (instructionCodes(job).length) out.push('instructions');
  const pickupDate = pickupReview(job);
  if (pickupDate) out.push(pickupDate.code);
  return out;
}

export function needsReview(job) {
  return reviewReasons(job).length > 0;
}

// The row badge: the reason in a few words ('' when the row isn't flagged).
export function reviewBadgeText(job) {
  const r = reviewReasons(job);
  const payment = r.includes('payment');
  const address = r.includes('pickup') || r.includes('drop');
  let text = '';
  if (payment && address) text = 'No payment + address';
  else if (payment) text = 'No payment';
  else if (address) text = 'Address: Awaiting Rate Con';
  if (r.includes('instructions')) text = text ? `${text} + instructions` : 'Driver instructions need a look';
  const closed = r.includes(PICKUP_UNCONFIRMED_CLOSED);
  if (!closed && !r.includes(PICKUP_UNCONFIRMED)) return text;
  if (text) return `${text} + pickup date`;
  return closed ? 'Pickup date unconfirmed (closed month)' : 'Pickup date unconfirmed';
}

// The reason in words, for the badge's title and the load detail. With
// { pickup: false } the pickup-date words are left out, for a pane that shows
// them on their own beside the "Mark confirmed" button.
export function reviewReasonText(job, { pickup: withPickup = true } = {}) {
  const r = reviewReasons(job);
  const parts = [];
  if (r.includes('payment')) parts.push('Payment is blank or $0.');
  const pickup = r.includes('pickup');
  const drop = r.includes('drop');
  if (pickup && drop) parts.push('Pickup and Drop-off Addresses say "Awaiting Rate Con".');
  else if (pickup) parts.push('Pickup Address says "Awaiting Rate Con".');
  else if (drop) parts.push('Drop-off Address says "Awaiting Rate Con".');
  if (r.includes('instructions')) {
    const words = instructionCodes(job).filter((c) => Object.hasOwn(INSTRUCTION_REVIEW_WORDS, c)).map((c) => INSTRUCTION_REVIEW_WORDS[c]);
    parts.push(words.length ? `Driver instructions need a look: ${words.join('; ')}.` : 'Driver instructions need a look.');
  }
  if (withPickup) {
    const words = pickupReviewText(job);
    if (words) parts.push(words);
  }
  return parts.join(' ');
}

export function countNeedsReview(jobs) {
  if (!Array.isArray(jobs)) return 0;
  let n = 0;
  for (const j of jobs) if (needsReview(j)) n++;
  return n;
}
