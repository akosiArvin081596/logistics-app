// Heuristic: does this load row need dispatcher attention?
// True when the n8n extraction pipeline produced a partial row — i.e. the
// rate-con PDF didn't parse cleanly and one of the columns body-fallback
// can't recover is still blank or holds a placeholder.
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

// Why a row is flagged, in display order: 'payment' (blank or $0 Payment),
// 'pickup' / 'drop' (that address still says "Awaiting Rate Con").
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
  if (payment && address) return 'No payment + address';
  if (payment) return 'No payment';
  return address ? 'Address: Awaiting Rate Con' : '';
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
  return parts.join(' ');
}

export function countNeedsReview(jobs) {
  if (!Array.isArray(jobs)) return 0;
  let n = 0;
  for (const j of jobs) if (needsReview(j)) n++;
  return n;
}
