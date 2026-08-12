// Client-side file validation shared by every upload surface, via useFileDrop.
//
// ⚠️ THIS IS NOT A CONVENIENCE — IT IS THE ONLY TYPE GATE ON A DROP.
// The `accept` attribute filters the OS file dialog and NOTHING ELSE. A file
// arriving through drag-and-drop bypasses it completely, so before drop support
// existed a surface could rely on `accept` alone and be right. The moment a zone
// accepts drops, `accept` becomes decorative and this module is what stands
// between a dropped .docx and a Gemini OCR call.
//
// Pure — no Vue, no DOM beyond the File interface, no network. Directly
// node-importable, which is what makes scripts/test-file-accept-matching.js a
// real regression lock rather than a text-extraction exercise.

// Rejection reason codes. Callers switch on these; the message is for humans.
export const REJECT_TYPE = 'type'
export const REJECT_SIZE = 'size'
export const REJECT_EMPTY = 'empty'
export const REJECT_COUNT = 'count'

// Split an accept attribute into its tokens. Tolerates the spacing people
// actually write ("image/*, .pdf") and de-duplicates.
function acceptTokens(accept) {
  return [
    ...new Set(
      String(accept || '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
}

// True when `file` satisfies `accept`, using the same rules as the attribute:
//   ".pdf"        extension, case-insensitive
//   "image/*"     type group wildcard
//   "image/png"   exact MIME
//
// ⚠️ An EMPTY accept means "everything is allowed", deliberately. LegalDocument-
// Portal has no accept today and the server (validateFileExt, server.js:134) is
// its authority; returning false here would silently give that surface a rule it
// never had and refuse uploads that work in production right now.
//
// ⚠️ Extension tokens are what make blank-MIME files work, and those are not an
// edge case: Windows hands us PDFs with file.type === '' and every non-Safari
// browser does the same for iPhone HEIC. Matching MIME alone would refuse the
// two formats this app receives most.
export function matchesAccept(file, accept) {
  const tokens = acceptTokens(accept)
  if (!tokens.length) return true
  if (!file) return false

  const name = String(file.name || '').toLowerCase()
  const type = String(file.type || '').toLowerCase()

  return tokens.some((token) => {
    if (token.startsWith('.')) return name.endsWith(token)
    if (token.endsWith('/*')) {
      // "image/*" — compare the group, not a prefix. A prefix test would let
      // "imagex/foo" through on token "image/*".
      const group = token.slice(0, -2)
      return type.startsWith(group + '/')
    }
    return type === token
  })
}

// Human-readable rendering of an accept string, for error copy.
// Returns '' for an empty accept so the caller can omit the whole clause rather
// than printing a dangling "use  instead".
export function describeAccept(accept) {
  const tokens = acceptTokens(accept)
  if (!tokens.length) return ''

  const seen = new Set()
  const parts = []
  for (const token of tokens) {
    let label
    if (token === 'image/*') label = 'images'
    else if (token === 'video/*') label = 'video'
    else if (token === 'audio/*') label = 'audio'
    else if (token.startsWith('.')) label = token.slice(1).toUpperCase()
    else if (token.includes('/')) label = token.split('/')[1].toUpperCase()
    else label = token.toUpperCase()
    // "application/pdf" and ".pdf" both render as PDF — say it once.
    if (seen.has(label)) continue
    seen.add(label)
    parts.push(label)
  }

  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`
}

function formatMb(bytes) {
  const mb = bytes / 1024 / 1024
  return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1)
}

// Validate a batch. Returns every accepted file AND every rejection, so the
// caller can process the good ones and still explain the bad ones — dropping
// eight receipts and silently keeping seven is exactly the failure this avoids.
//
// `maxFiles` is the remaining capacity, not a constant: surfaces with a batch
// cap bind it to (LIMIT - alreadyLoaded) so the over-limit message names the
// right number.
export function validateFiles(files, options = {}) {
  const {
    accept = '',
    multiple = false,
    maxFiles = 0,
    maxSizeMb = 0,
  } = options

  const list = Array.from(files || [])
  const accepted = []
  const rejections = []

  // Trim to capacity BEFORE per-file checks so a rejected file doesn't consume a
  // slot, and so the "only N were added" count matches what actually landed.
  const cap = !multiple ? 1 : maxFiles > 0 ? maxFiles : Infinity
  const maxBytes = maxSizeMb > 0 ? maxSizeMb * 1024 * 1024 : Infinity
  const describedTypes = describeAccept(accept)

  for (const file of list) {
    if (accepted.length >= cap) {
      rejections.push({
        file,
        reason: REJECT_COUNT,
        message: !multiple
          ? `Only one file at a time — "${file.name}" was not used.`
          : cap === 0
            ? `"${file.name}" was not added — the limit is already reached.`
            : `"${file.name}" was not added — only ${cap} more file${cap === 1 ? '' : 's'} fit.`,
      })
      continue
    }

    if (!matchesAccept(file, accept)) {
      rejections.push({
        file,
        reason: REJECT_TYPE,
        message: describedTypes
          ? `"${file.name}" isn't a supported file — use ${describedTypes}.`
          : `"${file.name}" isn't a supported file.`,
      })
      continue
    }

    // A dropped FOLDER arrives as a zero-byte File with no type. Without this,
    // it would sail through every other check and "upload" nothing at all.
    // useFileDrop catches the common case earlier via webkitGetAsEntry(); this
    // is the backstop for browsers/paths where that isn't available.
    if (!file.size) {
      rejections.push({
        file,
        reason: REJECT_EMPTY,
        message: file.type
          ? `"${file.name}" is empty.`
          : `"${file.name}" is empty — if you dragged a folder, open it and drag the files inside.`,
      })
      continue
    }

    if (file.size > maxBytes) {
      rejections.push({
        file,
        reason: REJECT_SIZE,
        message: `"${file.name}" is ${formatMb(file.size)} MB — the limit is ${maxSizeMb} MB.`,
      })
      continue
    }

    accepted.push(file)
  }

  return { accepted, rejections }
}

// One line for the whole batch, for surfaces with a single message slot.
// Names the first failure and counts the rest rather than concatenating N
// sentences into an unreadable wall.
export function summarizeRejections(rejections) {
  if (!rejections || !rejections.length) return ''
  const [first, ...rest] = rejections
  if (!rest.length) return first.message
  return `${first.message} (${rest.length} other file${rest.length === 1 ? '' : 's'} also refused.)`
}
