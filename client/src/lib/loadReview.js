// Heuristic: does this load row need dispatcher attention?
// True when the n8n extraction pipeline produced a partial row — i.e. the
// rate-con PDF didn't parse cleanly and one of the columns body-fallback
// can't recover is still blank or holds a placeholder.
//
// Single source of truth, used by ActiveLoadsTab / JobBoardTab /
// CompletedLoadsTab for both the row-level badge and the
// "Needs Review only" filter toggle.

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

export function needsReview(job) {
  if (!job) return false;
  // Empty / placeholder Payment is the strongest signal — rate only ever
  // comes from the rate-con PDF, never from email body.
  const payment = readField(job, 'Payment');
  if (!payment || ZERO_RATE_RE.test(payment)) return true;
  // "Awaiting Rate Con" placeholder on either address means the rate-con
  // didn't parse and the Bison address hardcode also didn't fire.
  if (PLACEHOLDER_RE.test(readField(job, 'Drop-off Address'))) return true;
  if (PLACEHOLDER_RE.test(readField(job, 'Pickup Address'))) return true;
  return false;
}

export function countNeedsReview(jobs) {
  if (!Array.isArray(jobs)) return 0;
  let n = 0;
  for (const j of jobs) if (needsReview(j)) n++;
  return n;
}
