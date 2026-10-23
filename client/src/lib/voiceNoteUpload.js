// Sends one recorded voice note: POST /api/messages/voice, the raw audio/mp4
// bytes as the body (no base64, no JSON), the recipient and load in
// percent-encoded headers (request lines reach the proxy's logs, headers do
// not), and the clip's Idempotency-Key. Shaped like composables/useUpload.js: a
// 90 s timeout per try (one bar of signal, 4 MB) and up to 3 tries with
// backoff. Every try carries the same key, so a try whose reply was lost
// answers the first note's id instead of writing a second one.
//
// Retried only when the note may not have arrived: no answer (timeout, no
// network), 408, or a 5xx other than 507 (disk low). Every other answer is
// final (409 the truck is moving, 413/415/422 the clip, 429 the limits, 404 the
// flag off). Nothing here drops the clip: the caller keeps it on any error.
//
// `request` is useApi().request (its errors carry status and code).
export const VOICE_UPLOAD_TIMEOUT_MS = 90000
const TRIES = 3

function retryable(err) {
  if (!err || err.code === 'ABORT') return false
  const s = Number(err.status) || 0
  if (s === 0) return true
  if (s === 408) return true
  return s >= 500 && s !== 507
}

// { blob, to, loadId?, from?, key, durationMs, sleep? } -> { id, durationMs, duplicate }.
// durationMs is the server's; on a duplicate (the server had it already and
// says only its id) the recorder's length stands in until the next read.
export async function uploadVoiceNote(request, { blob, to, loadId = '', from = '', key, durationMs = 0, sleep } = {}) {
  const headers = {
    'Content-Type': 'audio/mp4',
    'Idempotency-Key': key,
    'X-Message-To': encodeURIComponent(String(to || '')),
  }
  if (loadId) headers['X-Message-Load-Id'] = encodeURIComponent(String(loadId))
  if (from) headers['X-Message-From'] = encodeURIComponent(String(from))
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  let lastErr
  for (let attempt = 0; attempt < TRIES; attempt++) {
    try {
      const data = await request('/api/messages/voice', { method: 'POST', body: blob, headers, timeout: VOICE_UPLOAD_TIMEOUT_MS })
      const id = Number(data && data.id)
      if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('The voice note could not be sent. Try again.'), { status: 500, code: '' })
      const measured = Number(data.durationMs)
      return { id, durationMs: measured > 0 ? measured : durationMs, duplicate: !!data.duplicate }
    } catch (err) {
      lastErr = err
      if (!retryable(err) || attempt === TRIES - 1) throw err
      await wait(500 * Math.pow(2, attempt))
    }
  }
  throw lastErr
}
