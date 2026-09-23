import { useApi } from './useApi'

// Shared document-scan call. Sends a base64 image data URI to the server-side
// ScanKit.io proxy (POST /api/documents/scan) and returns the enhanced result
// (a cleaned JPEG, or a searchable PDF with an OCR text layer when returnPdf is
// true) as a base64 data URI.
//
// Throws the useApi error (with .status / .code) on failure so callers can
// branch on the status: 503 (scanning disabled / no key), 402 (no credits),
// 429 (rate limited), 502 (upstream/auth failure). Used by DocumentUpload.vue
// (driver POD/BOL + the admin dashboard) and the receipt forms (ExpenseForm.vue,
// ExpensesTab.vue).
export function useDocumentScan() {
  const api = useApi()

  // photoDataUrl: "data:image/jpeg;base64,..." (caller downscales first).
  // opts: { returnPdf?: boolean, filter?: 'original' | 'flat' | 'white',
  //         outputWidth?: number, signal?: AbortSignal }
  // resolves to { data, contentType, ext, isPdf }
  //
  // `outputWidth` is sent ONLY when a caller asks. Omitted, the body is exactly
  // what it always was and the server keeps its 1536 default — which is what
  // every POD/BOL scan still gets. The receipt form asks for less; see
  // RECEIPT_SCAN_WIDTH in lib/receiptPhoto.js for why.
  // `signal` lets a caller abandon a scan it no longer wants (useApi reports
  // that as code 'ABORT', never as a timeout).
  async function scanDocument(photoDataUrl, opts = {}) {
    const { returnPdf = false, filter = 'white', outputWidth, signal } = opts
    const body = { photoData: photoDataUrl, returnPdf, filter }
    if (outputWidth) body.outputWidth = outputWidth
    return await api.post('/api/documents/scan', body, { timeout: 30000, signal })
  }

  return { scanDocument }
}
