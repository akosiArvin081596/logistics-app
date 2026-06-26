// Image helpers shared by the driver upload + receipt flows. Extracted from
// DocumentUpload.vue / ExpenseForm.vue so the createImageBitmap one-pass
// downscale (and its low-RAM OOM fix) lives in exactly one place.

// Max edge (px) for plain photo/file uploads — POD pages, gallery picks.
export const DEFAULT_MAX_EDGE = 1200
// Max edge (px) fed to the ScanKit scan flow — a touch larger so the server has
// enough detail to detect the document edges. Also the size of the raw photo we
// re-attach when scanning is unavailable (the 402/503 fallback in the scanner).
export const SCAN_MAX_EDGE = 1280

// Decode + downscale an image to a JPEG data URL. maxEdge defaults to 1200 for
// plain uploads; the scan flow passes a larger value so ScanKit has enough
// detail to detect the document edges. createImageBitmap resizes in one pass —
// the old Image+Canvas path materialised a 12MP photo as ~48MB of raw RGBA and
// OOM-killed the tab on low-RAM phones (fix from commit 59fcd80).
export async function compressImage(file, maxEdge = DEFAULT_MAX_EDGE) {
  const MAX = maxEdge
  try {
    const probe = await createImageBitmap(file)
    let w = probe.width
    let h = probe.height
    probe.close()
    if (w > MAX || h > MAX) {
      if (w > h) { h = Math.round((h * MAX) / w); w = MAX }
      else { w = Math.round((w * MAX) / h); h = MAX }
    }
    const bitmap = await createImageBitmap(file, {
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
  } catch {
    // Unsupported format (HEIC on older browsers, etc.) — fall back to the
    // raw file so the upload can still proceed without compression.
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
