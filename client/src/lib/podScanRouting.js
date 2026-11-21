// The upload card's POD and BOL rules (DocumentUpload.vue) under the two switches the server hands it
// in GET /api/auth/session `features` (lib/pod-upload-shape.js on the server):
//   podUploadNormalize (POD_UPLOAD_NORMALIZE_ENABLED): the server shapes each POD or BOL photo; the
//     card asks ScanKit for the photo's long edge, tells the server each page's source, waits the
//     server's steps longer, and shows office users a note on a large POD or BOL PDF;
//   podUploadScanAll (POD_UPLOAD_SCAN_ALL_ENABLED): pictures added by Upload File, "+" and
//     drag-and-drop go through the scan too, one decode at a time, and each such page can go back to
//     the photo as it was ("Use the original photo").
// Both off, every answer here is what the card did before. Pure: no DOM, no network, no Vue, so
// scripts/test-driver-receipt-flow.mjs runs it under plain node.

import { SCAN_MAX_EDGE } from './imageUtils.js'

export const POD_SCAN_TYPES = Object.freeze(['POD', 'BOL'])
// The server's lib/pod-upload-shape.js PAGE_SOURCES, word for word.
export const PAGE_SOURCES = Object.freeze(['scanned', 'fallback', 'original', 'not_routed'])
// useUpload's own wait for one attempt, and the server's time for the steps (UPLOAD_BUDGET_MS).
export const UPLOAD_ATTEMPT_MS = 90000
export const SHAPE_BUDGET_MS = 20000
export const LARGE_PDF_BYTES = 600 * 1024
export const LARGE_PDF_WORDS = 'This file is large: Triumph takes at most 921,600 bytes per load, all documents together.'
export const OFFICE_ROLES = Object.freeze(['Super Admin', 'Dispatcher'])
export const USE_ORIGINAL_WORDS = 'Use the original photo'
export const USE_SCAN_WORDS = 'Use the scanned page'

// The two switches from a GET /api/auth/session answer: on only when the server says exactly true.
export function podFeatures(session) {
  const f = session && typeof session === 'object' && session.features && typeof session.features === 'object' ? session.features : {}
  return { normalize: f.podUploadNormalize === true, scanAll: f.podUploadScanAll === true }
}

export function isPodScanType(docType) {
  return POD_SCAN_TYPES.includes(String(docType || ''))
}

// Does a picture added by Upload File, "+" or drag-and-drop go through the scan? Only a POD or BOL
// image, and only with podUploadScanAll on. The camera's Scan Document always does, as before.
export function routesToScan({ scanAll = false, docType = '', isImage = false } = {}) {
  return scanAll === true && isImage === true && isPodScanType(docType)
}

// What the card asks ScanKit for. Off: exactly what it always asked (the server's 1536 width).
// On: the photo's long edge, at most SCAN_MAX_EDGE (the size the scan is sent at), so a page is
// never upscaled; the server's floor of 512 still applies. Unknown edge: SCAN_MAX_EDGE.
export function scanOptions({ normalize = false, longEdge = null } = {}) {
  if (normalize !== true) return { filter: 'white' }
  const edge = Number.isInteger(longEdge) && longEdge > 0 ? Math.min(longEdge, SCAN_MAX_EDGE) : SCAN_MAX_EDGE
  return { filter: 'white', outputWidth: edge }
}

// A JPEG data URL's long edge in pixels, read from its frame header within the first 64 KB, or null.
export function jpegLongEdge(dataUrl) {
  const url = typeof dataUrl === 'string' ? dataUrl : ''
  const label = /^data:image\/(?:jpeg|jpg);base64,/i.exec(url)
  if (!label) return null
  let bin
  try {
    bin = atob(url.slice(label[0].length, label[0].length + 87384))
  } catch {
    return null
  }
  const at = (i) => bin.charCodeAt(i)
  if (at(0) !== 0xff || at(1) !== 0xd8) return null
  let i = 2
  while (i + 9 <= bin.length) {
    if (at(i) !== 0xff) return null
    const marker = at(i + 1)
    if (marker === 0xff) { i++; continue }
    if (marker === 0xda || marker === 0xd9) return null
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = (at(i + 5) << 8) | at(i + 6)
      const w = (at(i + 7) << 8) | at(i + 8)
      return w > 0 && h > 0 ? Math.max(w, h) : null
    }
    i += 2 + ((at(i + 2) << 8) | at(i + 3))
  }
  return null
}

// Each page's source, as the server's row counts it: what the scan step set on the page, or a
// picture the card never sent to the scan.
export function pageSourceOf(entry) {
  const s = entry && entry.source
  return PAGE_SOURCES.includes(s) && s !== 'not_routed' ? s : 'not_routed'
}

export function pageSourcesFor(images) {
  return (Array.isArray(images) ? images : []).map(pageSourceOf)
}

// One upload attempt's wait for a POD or BOL image upload: the server's steps on top of the usual
// wait with podUploadNormalize on, so a phone never sends the upload again while the server is
// still shaping it. undefined: useUpload's own wait, as before.
export function uploadTimeoutFor({ normalize = false, docType = '' } = {}) {
  return normalize === true && isPodScanType(docType) ? UPLOAD_ATTEMPT_MS + SHAPE_BUDGET_MS : undefined
}

const isPdfEntry = (f) => !!f && f.isImage === false && (/^application\/pdf$/i.test(String(f.type || '')) || /\.pdf$/i.test(String(f.name || '')))

// The note an office user sees on a POD or BOL PDF over LARGE_PDF_BYTES (the PDF itself goes as it
// is). '' for a driver, any other type, or with podUploadNormalize off.
export function largePdfWarning({ normalize = false, role = '', docType = '', files = [] } = {}) {
  if (normalize !== true || !OFFICE_ROLES.includes(role) || !isPodScanType(docType)) return ''
  return (Array.isArray(files) ? files : []).some((f) => isPdfEntry(f) && Number(f.size) > LARGE_PDF_BYTES) ? LARGE_PDF_WORDS : ''
}

// "Use the original photo" on a page the scan routed: the photo as it was sent to the scan, and back.
// null on any page that has no scan and photo to choose between (the camera's, a fallback, a file).
export function chooseOriginal(entry, useOriginal) {
  if (!entry || entry.routed !== true || !entry.original || !entry.scanned) return null
  return useOriginal ? { data: entry.original, source: 'original' } : { data: entry.scanned, source: 'scanned' }
}

// The choice the preview offers on such a page, or '' when it offers none.
export function originalChoiceWords(entry) {
  if (!chooseOriginal(entry, true)) return ''
  return entry.source === 'original' ? USE_SCAN_WORDS : USE_ORIGINAL_WORDS
}

// Pictures sent through the scan from Upload File, "+" and drag-and-drop: each is decoded in turn,
// one decode in flight at a time, and only the scans run side by side, `concurrency` at most.
// `decode(item)` and `scan(item, decoded)` are the card's; a decode that throws hands null on.
export async function decodeThenScan(items, { decode, scan, concurrency = 3 } = {}) {
  const running = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    let decoded = null
    try {
      decoded = await decode(item)
    } catch {
      decoded = null
    }
    while (running.size >= Math.max(1, concurrency)) await Promise.race(running)
    const job = Promise.resolve()
      .then(() => scan(item, decoded))
      .catch(() => {})
      .finally(() => running.delete(job))
    running.add(job)
  }
  await Promise.all(running)
}
