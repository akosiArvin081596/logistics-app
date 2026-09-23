// Receipt-photo helpers for the driver's ExpenseForm. Pure — no DOM, no network,
// no Vue — so scripts/test-driver-receipt-flow.mjs can run them under plain node.

// Longest edge (px) a receipt photo is downscaled to before anything else sees
// it: the ScanKit enhancement, the Gemini read and the stored receipt. Was an
// inline `1024` in ExpenseForm.
export const RECEIPT_MAX_EDGE = 1024

// Width asked of ScanKit when it enhances a receipt.
//
// ScanKit's `output_width` is the width of the image it RETURNS, not a cap: the
// cropped document is resampled to exactly that width and its height follows
// the document's aspect ratio (api.scankit.io/swagger.yaml, POST /scan/crop).
// Sent nothing, the server asks for 1536 (POST /api/documents/scan). A receipt
// reaches the scan at RECEIPT_MAX_EDGE on its long edge, so every one came back
// upscaled — a portrait shot, 768 px wide, to twice its width — and that bigger
// image is what the driver then uploads over cellular in POST /api/expenses,
// and what Gemini reads.
//
// The photo's LONG edge, deliberately not its width: a receipt lying sideways or
// at an angle can present a "width" edge longer than the frame is wide, and
// asking for less than that edge would shrink real detail. Capped at the long
// edge, nothing that fits inside it is ever shrunk, so the read sees everything
// the 1024 px photo holds — which was always the ceiling, 1536 or not. 1024 is
// also the bottom of ScanKit's own recommended 1024-2048 range.
//
// Receipts only. POD/BOL scans (DocumentUpload) send no width and keep 1536.
export const RECEIPT_SCAN_WIDTH = RECEIPT_MAX_EDGE

// ── One receipt photo at a time ─────────────────────────────────────────────
// Every photo the driver attaches starts a JOB: decode, then the ScanKit
// enhancement, then the Gemini read. Each stage awaits a slow decoder or the
// network, so its answer can land after the photo it belongs to is gone —
// replaced, deleted, submitted and cleared, or the form unmounted. Before this,
// a late read refilled a just-submitted form with a hidden photo and the old
// amount, so a receipt that HAD saved looked like one that had not, and the
// driver sent it again.
//
// Two ways a job ends early, and the difference is the whole point:
//
//   cancel() / start()  the PHOTO is gone. Nothing from this job may write
//                       anything, ever again: isCurrent() goes false.
//   skipRead()          the driver stopped waiting for the READ. The photo is
//                       still theirs and must stay attached, so isCurrent() stays
//                       true (a decode still in flight still lands) and only
//                       mayRead() goes false — no enhancement or read result can
//                       overwrite what they type next.
//
// Both abort the job's signal so the requests stop spending the driver's data.
// The signal is a courtesy, not the guarantee — a response can resolve in the
// same tick the abort fires — so every write is gated on isCurrent()/mayRead().
export function createPhotoJobs() {
  let current = null

  function retire(job) {
    if (job) job.abort()
  }

  return {
    start() {
      retire(current)
      const controller = new AbortController()
      current = {
        signal: controller.signal,
        readSkipped: false,
        abort: () => controller.abort(),
      }
      return current
    },
    cancel() {
      retire(current)
      current = null
    },
    skipRead() {
      if (!current) return
      current.readSkipped = true
      current.abort()
    },
    isCurrent(job) {
      return !!job && job === current
    },
    mayRead(job) {
      return !!job && job === current && !job.readSkipped
    },
  }
}
