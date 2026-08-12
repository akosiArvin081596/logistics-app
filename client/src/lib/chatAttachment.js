// Attachment prep + send bookkeeping shared by the two chat composers:
//   components/dashboard/MessagingPanel.vue  (admin ↔ driver)
//   components/investor/InvestorChat.vue     (investor ↔ dispatch)
//
// Both post to POST /api/chat/attachment and then to a message route, and both
// carried the same defects in slightly different shapes. Everything the two must
// agree on now lives here exactly once:
//
//   1. The media type we SEND describes the BYTES we send — never a display
//      bucket, never the label the browser guessed for a file we then re-encoded.
//      MessagingPanel used to post mimeType:"image", so the server's
//      `(mimeType||'').startsWith('image/')` test always answered "other" and
//      every admin-chat photo rendered as a download link.
//   2. HEIC is converted, and the file is RENAMED to match the converted bytes.
//   3. An upload that already succeeded is never repeated, so a failed message
//      send can be retried without stranding a second copy in uploads/chat/.
//
// Everything except prepareChatAttachment() is PURE and directly node-importable
// — the rename, the decode gate and the upload memo can all be exercised with no
// DOM, the same way scripts/test-file-accept-matching.js exercises fileValidation.
//
// ⚠️ The import below carries its `.js` extension deliberately, unlike the two
// other cross-lib imports in this folder. Vite resolves either; Node's ESM
// resolver does NOT do extension guessing, so dropping it makes this file
// importable only through the bundler and silently un-testable.
import {
  DEFAULT_MAX_EDGE,
  compressImage,
  isDecodedImage,
  isHeic,
  readFileAsDataURL,
} from './imageUtils.js'

// ── The contract with POST /api/chat/attachment ──────────────────────────────
// server.js applies three independent gates, and a file must satisfy ALL of
// them or the send fails with a bare "Failed to send":
//
//   validateFileExt         (server.js:134) — the extension must be in
//                           ALLOWED_FILE_EXTS. **`.heic` is not on that list
//                           and never was.**
//   verifyInlineServedBytes (server.js:175) — the magic bytes must match that
//                           extension. So converted JPEG bytes posted under the
//                           original `.heic` name are refused TWICE over, which
//                           is why the rename below is mandatory and not
//                           cosmetic tidying.
//   attachmentType          — `mimeType.startsWith('image/')` decides inline
//                           <img> vs download link in every chat bubble.
//
// This table is the client half of that contract: the media types we can produce
// and the extensions the server accepts for each. Keep it a SUBSET of
// ALLOWED_FILE_EXTS — an entry the server refuses turns a friendly, immediate
// refusal into a mystery failure at send time.
const MEDIA_TYPE_EXTENSIONS = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
}

// Reverse lookup — the only signal available on a blank-MIME file, which is not
// an edge case: Windows hands us PDFs with file.type === '' and every non-Safari
// browser does the same for iPhone HEIC.
const EXTENSION_MEDIA_TYPE = Object.entries(MEDIA_TYPE_EXTENSIONS).reduce((map, [type, exts]) => {
  for (const ext of exts) map[ext] = type
  return map
}, {})

// Every extension a chat attachment may be sent under. Derived from the table
// above so the two can never drift.
export const CHAT_UPLOAD_EXTS = Object.keys(EXTENSION_MEDIA_TYPE)

// One accept string for both composers. `.heic,.heif` sit beside `image/*`
// because Safari reports HEIC as image/heic (so the wildcard already admitted
// it) while every other browser reports a BLANK type, where only the extension
// token matches — the same asymmetry `.pdf` beside `application/pdf` exists for.
export const CHAT_ATTACH_ACCEPT = 'image/*,application/pdf,.pdf,.heic,.heif'

// 10 MB of file is ~13.3 M of base64, just under the route's 13_500_000 ceiling.
export const CHAT_ATTACH_MAX_MB = 10

// Lower-cased extension INCLUDING the dot, or '' when the name has none.
// Excludes path separators so a name like "photos.2026/scan" isn't read as a
// ".2026/scan" extension.
export function extensionOf(fileName) {
  const match = /\.[^./\\]+$/.exec(String(fileName || ''))
  return match ? match[0].toLowerCase() : ''
}

// The media type declared by a data URL — i.e. what the bytes we are about to
// POST actually are. '' when the input is not a data URL.
export function dataUrlMediaType(dataUrl) {
  const match = /^data:([^;,]+)[;,]/.exec(String(dataUrl || ''))
  return match ? match[1].trim().toLowerCase() : ''
}

// Fold the spellings browsers actually emit onto the canonical type. Without
// this, a Windows-sourced "image/pjpeg" misses MEDIA_TYPE_EXTENSIONS and falls
// through to the extension branch for no reason.
function normalizeMediaType(raw) {
  const type = String(raw || '').trim().toLowerCase()
  if (type === 'image/jpg' || type === 'image/pjpeg') return 'image/jpeg'
  if (type === 'image/x-png') return 'image/png'
  return type
}

// Decide the media type to POST, most trustworthy source first.
//
// ⚠️ The BYTES win, not `file.type`. That ordering is the whole of fix (1) and
// of the HEIC fix: after conversion the File still says image/heic (or nothing
// at all) while the data URL says image/jpeg, and image/jpeg is the truth.
export function resolveMediaType(file, dataUrl) {
  // (1) What we are actually sending.
  const fromBytes = normalizeMediaType(dataUrlMediaType(dataUrl))
  if (MEDIA_TYPE_EXTENSIONS[fromBytes]) return fromBytes
  // (2) The extension — the only signal on a blank-MIME file. FileReader labels
  //     a type-less Blob "application/octet-stream", so (1) cannot answer here.
  const fromExtension = EXTENSION_MEDIA_TYPE[extensionOf(file?.name)]
  if (fromExtension) return fromExtension
  // (3) The browser's guess for the original file, last and only if usable.
  const fromFile = normalizeMediaType(file?.type)
  return MEDIA_TYPE_EXTENSIONS[fromFile] ? fromFile : ''
}

// Force `fileName`'s extension to agree with `mediaType`.
//
// ⚠️ THIS IS THE STEP THAT IS EASY TO MISS AND MAKES THE HEIC FIX A NO-OP.
// Converting IMG_0421.HEIC to JPEG and posting it as IMG_0421.HEIC is refused by
// validateFileExt (no .heic in ALLOWED_FILE_EXTS) and, were it not, by
// verifyInlineServedBytes (JPEG magic under a .heic extension).
//
// An already-correct extension is left EXACTLY as it is, case and all, so this
// is a no-op for every file that was working before — `.jpeg` is not rewritten
// to `.jpg`, and `PHOTO.JPG` keeps its case (the server lower-cases before every
// extension test of its own).
export function alignFileName(fileName, mediaType) {
  const name = String(fileName || '')
  const allowed = MEDIA_TYPE_EXTENSIONS[normalizeMediaType(mediaType)]
  if (!allowed) return name // unknown media type — we have nothing better to say
  const current = extensionOf(name)
  if (allowed.includes(current)) return name
  // Slice by length, never by lastIndexOf on the lower-cased copy: the name may
  // be mixed case and we must cut the real characters.
  const stem = current ? name.slice(0, name.length - current.length) : name
  // A dot-file ("`.heic`") leaves no stem at all; naming it "attachment" beats
  // posting ".jpg", which path.extname() reads as no extension at all.
  return `${stem || 'attachment'}${allowed[0]}`
}

// The display bucket the server derives from the media type — mirrored here ONLY
// as a fallback for a response that omits it. Same three values, same order of
// tests, so the two can't disagree about what renders inline.
export function attachmentBucket(mediaType) {
  const type = normalizeMediaType(mediaType)
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf') return 'pdf'
  return 'other'
}

// PURE. Given the picked file and the bytes we read from it, produce either the
// attachment to send or the reason we won't send it.
//
// Copy rule: an investor reads these too, so no message names an admin action,
// an endpoint, a role or a server-side term.
export function resolveChatAttachment(file, dataUrl) {
  const originalName = String(file?.name || 'file')
  // readFileAsDataURL resolves '' on an unreadable/corrupt file rather than
  // rejecting, so an empty result is the failure signal — never a valid attach.
  // Showing the name with no bytes behind it would let send() post a message
  // with a silently missing attachment.
  if (!dataUrl) {
    return { ok: false, error: `Couldn’t read “${originalName}”. Try attaching it again.`, attachment: null }
  }

  const mediaType = resolveMediaType(file, dataUrl)
  const fileName = alignFileName(originalName, mediaType)
  const extension = extensionOf(fileName)

  // Refuse here rather than at send time. `accept="image/*"` admits SVG, BMP and
  // TIFF, none of which the server accepts, and the composers' only failure copy
  // is "Failed to send" — which names neither the file nor the reason.
  if (!CHAT_UPLOAD_EXTS.includes(extension)) {
    return {
      ok: false,
      error: `“${originalName}” isn’t a file type we can attach — try a JPG, PNG or PDF.`,
      attachment: null,
    }
  }

  return {
    ok: true,
    error: '',
    attachment: {
      displayName: originalName, // what the composer chip shows — the file they picked
      fileName, // what we POST — may differ, see alignFileName
      mediaType,
      dataUrl,
      // Set by uploadChatAttachment on the first successful upload; see the ⚠️
      // there. Null means "not on the server yet".
      uploaded: null,
    },
  }
}

// Read a picked file and turn it into something the chat endpoint will accept.
// The only function here that touches the File/canvas APIs.
export async function prepareChatAttachment(file, maxEdge = DEFAULT_MAX_EDGE) {
  if (!file) return { ok: false, error: 'No file to attach.', attachment: null }

  // ⚠️ HEIC ONLY — everything else is passed through byte-for-byte, deliberately.
  // compressImage re-encodes to JPEG at maxEdge, which is right for a phone photo
  // in an unreadable format and wrong for the rest of this surface: a chat
  // screenshot is sent to be READ, and downscaling it to 1200px destroys exactly
  // the text that was the point of sending it (and would flatten a transparent
  // PNG onto black). HEIC is the one format a browser cannot be relied on to
  // decode and the server does not accept at all, so it is the one format worth
  // rewriting.
  if (isHeic(file)) {
    const dataUrl = await compressImage(file, maxEdge)
    // ⚠️ compressImage NEVER throws — its contract is deliberately lossy about
    // failure and an undecodable file resolves to the RAW bytes under the
    // browser's own media type. Without this gate those raw HEIC bytes would be
    // posted, refused by the server's magic-byte check, and reach the user as a
    // bare "Failed to send" with nothing to act on.
    if (!isDecodedImage(dataUrl)) {
      return {
        ok: false,
        error: `“${file.name}” couldn’t be opened as a photo. Try attaching a JPG or PNG instead.`,
        attachment: null,
      }
    }
    return resolveChatAttachment(file, dataUrl)
  }

  return resolveChatAttachment(file, await readFileAsDataURL(file))
}

// Upload the attachment, at most once per attachment, and hand back the URL and
// display bucket to put on the message.
//
// `post` is the caller's own API function — (url, body) => Promise — passed in
// rather than imported so this module stays free of the composable singletons
// and can be driven by a stub in Node.
//
// ⚠️ THE MEMO IS THE WHOLE POINT OF THIS FUNCTION. Sending is two calls: upload
// the file, then post the message. When the first succeeds and the second fails,
// the file is already on the server — so a retry that uploads again strands a
// second, unreferenced copy in uploads/chat/ for every attempt. Reusing the
// stored result makes retry safe AND makes it correct to keep the attachment on
// screen after a failure, which is the other half of the fix: clearing it (as
// InvestorChat did) destroys the user's file, and keeping it without this memo
// duplicates the upload (as MessagingPanel did).
export async function uploadChatAttachment(attachment, post) {
  if (!attachment) return { url: '', type: '' }
  if (attachment.uploaded) return attachment.uploaded

  const res = await post('/api/chat/attachment', {
    fileName: attachment.fileName,
    fileData: attachment.dataUrl,
    mimeType: attachment.mediaType,
  })

  const uploaded = {
    url: res?.fileUrl || '',
    type: res?.attachmentType || attachmentBucket(attachment.mediaType),
  }
  // Never memoize a URL-less "success": a message carrying an attachment type and
  // no URL renders as a broken attachment forever, and the memo would stop the
  // retry that could still fix it. Fail loudly instead — the caller's catch keeps
  // the attachment on screen.
  if (!uploaded.url) throw new Error('That file didn’t finish uploading. Try sending again.')

  attachment.uploaded = uploaded
  return uploaded
}
