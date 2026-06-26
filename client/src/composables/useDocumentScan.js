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
  // opts: { returnPdf?: boolean, filter?: 'original' | 'flat' | 'white' }
  // resolves to { data, contentType, ext, isPdf }
  async function scanDocument(photoDataUrl, opts = {}) {
    const { returnPdf = false, filter = 'white' } = opts
    return await api.post('/api/documents/scan', {
      photoData: photoDataUrl,
      returnPdf,
      filter,
    }, { timeout: 30000 })
  }

  return { scanDocument }
}
