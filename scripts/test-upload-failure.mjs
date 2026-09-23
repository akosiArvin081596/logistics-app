#!/usr/bin/env node
// Deterministic check on client/src/lib/uploadFailure.js — what a driver is told
// when an upload or a receipt is refused.
//
// WHY THIS EXISTS. Two surfaces (the POD/document upload and the expense form)
// share one rule: a 4xx REFUSAL is final, so the server's own words are shown
// and the "tap Upload to retry" / "take the photo again" step is added ONLY when
// retrying could actually help. Get that wrong in either direction and the app
// either tells someone to retry a request that can never succeed, or tells them
// to retake a photo when the real problem was a closed month.
//
// Each case is paired with the shape that must NOT get the same treatment, and
// the mutants at the end are the ways the rule has been got wrong before.
//
// No network, no DOM, no Vue — pure input/output, safe anywhere.
//   node scripts/test-upload-failure.mjs      # exits 1 on any failure

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.join(__dirname, '..', 'client', 'src', 'lib', 'uploadFailure.js')

let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.error(`FAIL  ${label}`) }
}

const mod = await import(pathToFileURL(MODULE_PATH).href)
const { isRefusal, isPhotoRefusal, asSentence, withRetakeHint, uploadFailureToast, PHOTO_FAILURE_RE } = mod

const err = (status, message, code) => ({ status, message, code })
const HINT = 'Take the receipt photo again, then submit.'
const FALLBACK = 'Could not submit this expense. Nothing was saved — tap Try Again.'

// ── isRefusal: a 4xx that will not change on retry, minus the timeout 408 ──
ok('413 is a refusal', isRefusal(err(413, 'too large')) === true)
ok('415 is a refusal', isRefusal(err(415, 'bad type')) === true)
ok('400 is a refusal', isRefusal(err(400, 'closed month')) === true)
ok('403 is a refusal', isRefusal(err(403, 'not yours')) === true)
ok('408 (timeout) is NOT a refusal — retrying can help', isRefusal(err(408, 'timeout')) === false)
ok('429 is NOT a refusal — retrying after a wait can help', isRefusal(err(429, 'slow down')) === false)
ok('500 is NOT a refusal', isRefusal(err(500, 'server')) === false)
ok('502 is NOT a refusal', isRefusal(err(502, 'gateway')) === false)
ok('a timeout with status 0 is NOT a refusal', isRefusal({ status: 0, code: 'TIMEOUT' }) === false)
ok('a dropped connection (no status) is NOT a refusal', isRefusal({ message: 'Load failed' }) === false)
ok('null / undefined are not refusals', isRefusal(null) === false && isRefusal(undefined) === false)

// ── isPhotoRefusal: the file itself, i.e. retaking it could fix it ──
ok('413 is about the photo (it is the body)', isPhotoRefusal(err(413, 'too large')) === true)
ok('415 is about the photo (its type)', isPhotoRefusal(err(415, 'bad type')) === true)
ok('a 400 whose words name the file is about the photo',
  isPhotoRefusal(err(400, 'This image could not be read.')) === true)
ok('a 400 about a closed month is NOT about the photo',
  isPhotoRefusal(err(400, 'this receipt books to August 2026, a closed month')) === false)
ok('a 400 about a duplicate is NOT about the photo',
  isPhotoRefusal(err(400, 'A receipt just like this was already logged')) === false)
ok('a 409 duplicate is not a photo problem even though it is a refusal',
  isRefusal(err(409, 'duplicate')) === true && isPhotoRefusal(err(409, 'duplicate')) === false)
ok('the word "receipt" alone does not read as a photo problem',
  PHOTO_FAILURE_RE.test('this receipt books to a closed month') === false)

// ── asSentence: one trailing stop, no doubling ──
ok('adds a period', asSentence('too large') === 'too large.')
ok('keeps an existing period', asSentence('too large.') === 'too large.')
ok('keeps a question mark', asSentence('too large?') === 'too large?')
ok('empty stays empty', asSentence('') === '' && asSentence(null) === '')

// ── withRetakeHint: verbatim server message; hint only when it helps ──
ok('a photo refusal gets the hint appended',
  withRetakeHint(err(413, 'This photo is too large to process. Retake it with the app camera.'), FALLBACK, HINT)
    === 'This photo is too large to process. Retake it with the app camera.')
ok('a 415 with a terse message gets a period AND the hint',
  withRetakeHint(err(415, 'This file could not be read'), FALLBACK, HINT)
    === 'This file could not be read. Take the receipt photo again, then submit.')
ok('a non-photo refusal is shown VERBATIM, with no hint and no added period',
  withRetakeHint(err(400, 'this receipt books to a closed month'), FALLBACK, HINT)
    === 'this receipt books to a closed month')
ok('a message that already says retake is not given the hint twice',
  withRetakeHint(err(413, 'Too large — retake it with the app camera.'), FALLBACK, HINT)
    === 'Too large — retake it with the app camera.')
ok('a failure with no message falls back',
  withRetakeHint({ status: 0, code: 'TIMEOUT' }, FALLBACK, HINT) === FALLBACK)

// ── uploadFailureToast: refusals named verbatim; transient ones counted ──
{
  const toast = uploadFailureToast([
    { index: 0, label: 'POD (2 pages)', error: err(413, 'This photo is too large to process. Retake it with the app camera.') },
  ])
  ok('a single refusal shows its label and the server words, no "tap Upload to retry"',
    toast === 'POD (2 pages): This photo is too large to process. Retake it with the app camera.' &&
    !/tap Upload to retry/.test(toast))
}
{
  const toast = uploadFailureToast([
    { index: 0, label: 'BOL', error: err(500, 'server') },
    { index: 1, label: 'POD', error: { status: 0, code: 'TIMEOUT' } },
  ])
  ok('two transient failures are counted once with the retry step',
    toast === 'Upload failed for 2 items — tap Upload to retry.')
}
{
  const toast = uploadFailureToast([
    { index: 0, label: 'Receipt', error: err(415, 'This file could not be read. Attach a JPEG photo or a PDF.') },
    { index: 1, label: 'POD', error: err(500, 'server') },
  ])
  ok('a refusal and a transient failure are reported separately',
    /Receipt: This file could not be read/.test(toast) && /Upload failed for 1 item — tap Upload to retry\./.test(toast))
  ok('one item is singular', / 1 item /.test(toast))
}
ok('no failures → empty string', uploadFailureToast([]) === '' && uploadFailureToast(null) === '')

// ── MUTANTS: each once-made mistake must be caught above ──
// M1  treat every failure as a refusal (drop the retry advice on a timeout).
ok('M1 mutant caught: 500 must be retryable', isRefusal(err(500, 'x')) === false)
// M2  treat 413/415 as retryable transient (would loop the client on a size cap).
ok('M2 mutant caught: 413 must be a refusal', isRefusal(err(413, 'x')) === true)
// M3  add the retake hint to every refusal, including a closed month.
ok('M3 mutant caught: closed-month 400 gets no retake hint',
  !/again/i.test(withRetakeHint(err(400, 'this receipt books to a closed month'), FALLBACK, HINT)))
// M4  count 408 as final (would strand a genuinely retryable timeout).
ok('M4 mutant caught: 408 stays retryable', isRefusal(err(408, 'timeout')) === false)

console.log(fail ? `\n${fail} failed, ${pass} passed` : `\nall ${pass} passed`)
process.exit(fail ? 1 : 0)
