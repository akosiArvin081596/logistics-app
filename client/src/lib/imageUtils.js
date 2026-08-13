// Image helpers shared by the driver upload + receipt flows. Extracted from
// DocumentUpload.vue / ExpenseForm.vue so the createImageBitmap one-pass
// downscale (and its low-RAM OOM fix) lives in exactly one place.

// Max edge (px) for plain photo/file uploads — POD pages, gallery picks.
export const DEFAULT_MAX_EDGE = 1200
// Max edge (px) fed to the ScanKit scan flow — a touch larger so the server has
// enough detail to detect the document edges. Also the size of the raw photo we
// re-attach when scanning is unavailable (the 402/503 fallback in the scanner).
export const SCAN_MAX_EDGE = 1280
// Max edge (px) for profile pictures — driver, investor and drivers-directory
// avatars. Matches the 512 the four hand-rolled resizeImageToBase64 copies used
// before they were absorbed here.
export const AVATAR_MAX_EDGE = 512

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
//
// `background` matters more than it looks: the output is always JPEG, which has
// no alpha channel, so a transparent PNG composites against whatever the canvas
// starts as — transparent black. Every avatar path used to hand-roll its own
// resize purely to fillRect('#ffffff') first, and absorbing those copies without
// this option would silently turn every transparent-PNG profile picture into a
// black square. Left unset for photos/receipts, which are opaque anyway.
async function bitmapToJpegDataUrl(src, maxEdge = DEFAULT_MAX_EDGE, opts = {}) {
  const { background = '', quality = 0.8 } = opts
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
  const ctx = canvas.getContext('2d')
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const dataUrl = canvas.toDataURL('image/jpeg', quality)
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
// `opts.background` (e.g. '#ffffff') flattens transparency — required for
// avatars, see bitmapToJpegDataUrl. `opts.quality` defaults to 0.8.
export async function compressImage(file, maxEdge = DEFAULT_MAX_EDGE, opts = {}) {
  try {
    return await bitmapToJpegDataUrl(file, maxEdge, opts)
  } catch {
    if (isHeic(file)) {
      try {
        const { default: heic2any } = await import('heic2any')
        const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 })
        return await bitmapToJpegDataUrl(Array.isArray(out) ? out[0] : out, maxEdge, opts)
      } catch {
        // Conversion failed — fall through to the raw fallback below.
      }
    }
    // Non-HEIC undecodable file, or a HEIC whose conversion failed: keep the raw
    // file so the upload can still proceed (callers treat '' as "couldn't read it").
    return await readFileAsDataURL(file)
  }
}

// True only for a data URL that came out of a REAL decode (the canvas JPEG the
// fast path produces, or a PNG/WebP a caller passed through untouched).
//
// This exists because compressImage's contract is deliberately lossy about
// failure: an undecodable file falls back to `readFileAsDataURL`, so the caller
// gets the RAW bytes under the browser's own media type and CANNOT tell
// "downscaled photo" from "file we could not read" by the return value alone —
// only by the media type. Everything that reaches the fallback (an SVG, a
// mislabelled PDF, a HEIC even heic2any refused) is rejected server-side, which
// verifies the actual magic bytes rather than trusting this string. Test with
// this BEFORE uploading so the common case never spends a round trip, and so
// the person holding the phone is told to retake the photo instead of watching
// an expense get booked with its evidence quietly dropped.
//
// Deliberately narrower than the server (which also accepts GIF): compressImage
// re-encodes a decodable GIF to JPEG anyway, so the only GIF that could reach
// here is one that failed to decode — exactly what this is meant to catch.
export const DECODED_IMAGE_RE = /^data:image\/(jpeg|jpg|png|webp);base64,/i

export function isDecodedImage(dataUrl) {
  return DECODED_IMAGE_RE.test(dataUrl || '')
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
