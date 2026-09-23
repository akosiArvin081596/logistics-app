// What to tell someone whose upload or receipt was refused. Pure — no Vue, no
// DOM — so scripts/test-upload-failure.mjs can pin every branch.
//
// The rule both surfaces share: a REFUSAL (a 4xx) is final. Sending the same
// file again cannot change the answer, so the server's own words are shown —
// they are the only thing that knows why. Anything else (a timeout, a dropped
// connection, a 5xx) may well succeed on a retry, and says so.

// Words that mean "the FILE was the problem". Deliberately excludes "receipt",
// which every message on the expense endpoint contains — with it in, a
// closed-period 400 ("…this receipt books to August 2026") came back telling the
// driver to retake a photo that was never the issue. Caught in the browser, kept
// here as the reason the list looks arbitrary. (Moved from ExpenseForm.vue;
// scripts/test-expense-load-window.js reads it from here.)
export const PHOTO_FAILURE_RE = /image|photo|jpe?g|png|webp|format|file type|data uri/i

// A message that already tells the person to take the photo again needs no
// second instruction appended to it.
const RETAKE_RE = /\bretake\b|\btake (?:it|them|the [a-z]+(?: [a-z]+)?) again\b/i

// The 4xx statuses that a retry can still clear, so they are NOT final refusals:
// 408 is a timeout wearing a 4xx, and 429 is "too many requests" — both may
// succeed when sent again. useUpload.js retries exactly these among the 4xx.
const RETRYABLE_4XX = new Set([408, 429])

// Is this failure a refusal — an answer that will not change if the same thing
// is sent again?
export function isRefusal(err) {
  const s = err && err.status
  return typeof s === 'number' && s >= 400 && s < 500 && !RETRYABLE_4XX.has(s)
}

// Is this refusal about the photo itself, i.e. something taking it again can
// fix? 413 is the body being too large, and in these forms the photo is the
// body; 415 names the file's type. A 400 counts only when its words are about
// the file (PHOTO_FAILURE_RE).
export function isPhotoRefusal(err) {
  const status = err && err.status
  if (status === 413 || status === 415) return true
  return status === 400 && PHOTO_FAILURE_RE.test((err && err.message) || '')
}

// Server messages don't reliably end in punctuation, and without this two
// sentences run together into one unreadable line on a phone.
export function asSentence(msg) {
  const s = String(msg || '').trim()
  if (!s) return ''
  return /[.!?]$/.test(s) ? s : `${s}.`
}

// The server's message, verbatim, plus a "take it again" step when the refusal
// is about the photo and the message does not already say so. `hint` is that
// step; `fallback` stands in for a failure that carried no message.
export function withRetakeHint(err, fallback, hint) {
  const msg = (err && err.message) || fallback
  if (!isPhotoRefusal(err) || RETAKE_RE.test(msg)) return msg
  return `${asSentence(msg)} ${hint}`
}

// The toast after a document-upload batch. `failed` is useUpload's list:
// [{ index, label, error }]. Each refusal is named and shown in the server's
// words; everything else is counted once, with the retry instruction.
export function uploadFailureToast(failed) {
  const list = Array.isArray(failed) ? failed : []
  const parts = []
  let retryable = 0
  for (const f of list) {
    const err = f && f.error
    if (!isRefusal(err)) { retryable++; continue }
    const msg = asSentence((err && err.message) || 'The server refused this upload.')
    parts.push(f.label ? `${f.label}: ${msg}` : msg)
  }
  if (retryable) {
    parts.push(`Upload failed for ${retryable} item${retryable !== 1 ? 's' : ''} — tap Upload to retry.`)
  }
  return parts.join(' ')
}
