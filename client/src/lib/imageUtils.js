// Image helpers shared by the driver upload + receipt flows. Extracted from
// DocumentUpload.vue / ExpenseForm.vue so the createImageBitmap one-pass
// downscale (and its low-RAM OOM fix) lives in exactly one place.

// Max edge (px) for plain photo/file uploads — POD pages, gallery picks.
export const DEFAULT_MAX_EDGE = 1200
// Max edge (px) fed to the ScanKit scan flow — a touch larger so the server has
// enough detail to detect the document edges. Also the size of the raw photo we
// re-attach when scanning is unavailable (the 402/503 fallback in the scanner).
export const SCAN_MAX_EDGE = 1280

// True for an iPhone HEIC/HEIF still — by MIME (Safari sets it) or by extension
// (Chrome/Firefox/Edge/Android often leave file.type blank for HEIC).
export function isHeic(file) {
  if (!file) return false
  return /^image\/(heic|heif)$/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '')
}

// Decode a Blob/File and downscale it to a JPEG data URL in one createImageBitmap
// pass — the old Image+Canvas path materialised a 12MP photo as ~48MB of raw
// RGBA and OOM-killed the tab on low-RAM phones (fix from commit 59fcd80).
// Throws on any decode failure (including the 0-dimension case some browsers
// resolve to instead of rejecting) so compressImage can route into its fallback.
async function bitmapToJpegDataUrl(src, maxEdge = DEFAULT_MAX_EDGE) {
  const MAX = maxEdge
  const probe = await createImageBitmap(src)
  let w = probe.width
  let h = probe.height
  probe.close()
  // Some browsers resolve createImageBitmap on odd/undecodable inputs rather
  // than throwing, yielding a 0-dimension bitmap — treat that as a failure.
  if (!w || !h) throw new Error('empty bitmap')
  if (w > MAX || h > MAX) {
    if (w > h) { h = Math.round((h * MAX) / w); w = MAX }
    else { w = Math.round((w * MAX) / h); h = MAX }
  }
  const bitmap = await createImageBitmap(src, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: 'medium',
  })
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  bitmap.close()
  const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
  canvas.width = 0
  canvas.height = 0
  return dataUrl
}

// Decode + downscale an image to a JPEG data URL. maxEdge defaults to 1200 for
// plain uploads; the scan flow passes a larger value so ScanKit has enough
// detail to detect the document edges.
//
// Universal format handling: the fast path decodes JPEG/PNG/WEBP/GIF (and HEIC
// on Safari, which can decode it natively). When that fails on a HEIC/HEIF —
// which Chrome/Firefox/Edge/Android cannot decode via createImageBitmap — we
// convert it to JPEG with heic2any first, then run the same downscale. The
// heic2any wasm (~1.5MB) is lazy-imported so it ONLY downloads when a HEIC
// actually needs converting; every JPEG/PNG upload and all of Safari never pay
// for it. Any other undecodable file (or a failed conversion) falls back to the
// raw bytes so the receipt/upload is never lost.
export async function compressImage(file, maxEdge = DEFAULT_MAX_EDGE) {
  try {
    return await bitmapToJpegDataUrl(file, maxEdge)
  } catch {
    if (isHeic(file)) {
      try {
        const { default: heic2any } = await import('heic2any')
        const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 })
        return await bitmapToJpegDataUrl(Array.isArray(out) ? out[0] : out, maxEdge)
      } catch {
        // Conversion failed — fall through to the raw fallback below.
      }
    }
    // Non-HEIC undecodable file, or a HEIC whose conversion failed: keep the raw
    // file so the upload can still proceed (callers treat '' as "couldn't read it").
    return await readFileAsDataURL(file)
  }
}

export function readFileAsDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    // On a FileReader error (unreadable/corrupt file) resolve to '' instead of
    // hanging forever — every caller treats an empty result as "couldn't read it".
    reader.onerror = () => resolve('')
    reader.readAsDataURL(file)
  })
}
