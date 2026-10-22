// Heuristic: does this load row need dispatcher attention?
// True when the n8n extraction pipeline produced a partial row — i.e. the
// rate-con PDF didn't parse cleanly and one of the columns body-fallback
// can't recover is still blank or holds a placeholder — or when the server
// says the load's rate-con driver instructions need a person: it sends their
// review codes on the open loads' rows as `_instructionsReview` (codes only,
// while its flag is on). The client words the codes; it never works one out.
//
// Single source of truth, used by ActiveLoadsTab / JobBoardTab /
// CompletedLoadsTab for both the row-level badge and the
// "Needs Review only" filter toggle. Display only: no total reads it.
// Runner: scripts/test-load-review.mjs.

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

// Why a row is flagged, in display order: 'payment' (blank or $0 Payment),
// 'pickup' / 'drop' (that address still says "Awaiting Rate Con"),
// 'instructions' (the server sent driver-instructions review codes).
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
  if (!r.includes('instructions')) return text;
  return text ? `${text} + instructions` : 'Driver instructions need a look';
}

// The reason in words, for the badge's title and the load detail.
export function reviewReasonText(job) {
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
  return parts.join(' ');
}

export function countNeedsReview(jobs) {
  if (!Array.isArray(jobs)) return 0;
  let n = 0;
  for (const j of jobs) if (needsReview(j)) n++;
  return n;
}
