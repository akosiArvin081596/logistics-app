// The photos in a chat thread, for the full-size viewer in the dashboard
// Messages page (components/dashboard/MessagingPanel.vue) and the driver app's
// Messages tab (components/driver/ChatView.vue). Pure, no DOM:
// scripts/test-chat-photo-viewer.mjs pins it.
//
// A photo is a message whose attachment the server classed as an image and
// whose URL is one of our own uploads, so the viewer loads it the way the
// thread already does: the same signed-in /uploads/ URL, never another host.
//
// ⚠️ The `.js` on the import is deliberate: Node's ESM resolver does no
// extension guessing, and the runner imports this file directly.
import { positionLabel, stepIndex } from './photoViewer.js'

// Our own upload path: starts with one slash (never "//host"), no "..", no
// backslash, no scheme, no query or fragment.
const OWN_UPLOAD_URL = /^\/uploads\/[^\s\\:?#]+$/

// Is this attachment URL one of our own uploads? Every thread links an
// attachment only when it is (a script URL or another site's link never
// becomes a link); anything else reads "File unavailable".
export function isOwnUploadUrl(url) {
  const u = typeof url === 'string' ? url : ''
  return OWN_UPLOAD_URL.test(u) && !u.includes('/..') && !u.includes('//')
}

export function isChatPhoto(msg) {
  if (!msg || msg.attachment_type !== 'image') return false
  return isOwnUploadUrl(msg.attachment_url)
}

// The photo's text alternative: who sent it.
export function chatPhotoAlt(msg) {
  const from = msg && typeof msg.from === 'string' ? msg.from.trim() : ''
  return from ? `Photo from ${from}` : 'Photo'
}

// The thread's photos, oldest first, each URL once.
export function chatPhotos(messages) {
  const out = []
  const seen = new Set()
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!isChatPhoto(msg) || seen.has(msg.attachment_url)) continue
    seen.add(msg.attachment_url)
    out.push({ url: msg.attachment_url, alt: chatPhotoAlt(msg) })
  }
  return out
}

// The open photo (by URL) and its place in the thread, or null when no photo
// is open or the open one is no longer in the thread (another conversation was
// picked).
export function chatPhotoView(photos, openUrl) {
  const list = Array.isArray(photos) ? photos : []
  const index = openUrl ? list.findIndex((p) => p.url === openUrl) : -1
  if (index < 0) return null
  return {
    index,
    photo: list[index],
    hasPrev: index > 0,
    hasNext: index < list.length - 1,
    position: positionLabel(index, list.length),
  }
}

// The URL of the photo `delta` steps from the open one; the open one's own URL
// at either end, and '' when none is open.
export function chatPhotoStep(photos, openUrl, delta) {
  const view = chatPhotoView(photos, openUrl)
  if (!view) return ''
  return photos[stepIndex(view.index, delta, photos.length)].url
}
