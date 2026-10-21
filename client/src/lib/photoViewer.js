// The full-size photo viewer's rules (components/shared/ZoomableImage.vue):
// next/previous through a set of photos, the swipe that does the same on a
// phone, and where Tab moves focus inside the open viewer. Pure, no DOM:
// scripts/test-chat-photo-viewer.mjs pins it.

// A swipe is a one-finger move at fit size (not zoomed) of at least this many
// CSS px, mostly sideways. Shorter or steeper moves are a tap or a scroll.
export const SWIPE_MIN_PX = 50
const SWIPE_SLOPE = 1.5

// +1 (next: the finger moved left), -1 (previous: it moved right) or 0.
export function swipeStep(dx, dy, minPx = SWIPE_MIN_PX) {
  const x = Number(dx) || 0
  const y = Number(dy) || 0
  if (Math.abs(x) < minPx || Math.abs(x) < Math.abs(y) * SWIPE_SLOPE) return 0
  return x < 0 ? 1 : -1
}

// The index `delta` steps from `index` among `count` photos. No wrap: the
// first photo has no previous and the last has no next.
export function stepIndex(index, delta, count) {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  const i = Math.floor(Number(index))
  if (!n || !(i >= 0) || i >= n) return -1
  return Math.min(n - 1, Math.max(0, i + Math.sign(Number(delta) || 0)))
}

// "Photo 2 of 5", or '' for a single photo (nothing to count).
export function positionLabel(index, count, noun = 'Photo') {
  const n = Math.floor(Number(count) || 0)
  const i = Math.floor(Number(index))
  if (n < 2 || !(i >= 0) || i >= n) return ''
  return `${noun} ${i + 1} of ${n}`
}

// Tab inside the open viewer: the index (into its focusable controls, in DOM
// order) to move focus to, or -1 to let the browser move it. Focus never leaves
// the viewer: Tab on the last control goes to the first, Shift+Tab on the first
// goes to the last, and focus that is on the viewer itself (where it lands when
// it opens) or anywhere outside it goes to the first or the last control.
export function trapTabIndex(count, activeIndex, shift) {
  const n = Math.floor(Number(count) || 0)
  if (n < 1) return -1
  const i = Math.floor(Number(activeIndex))
  if (!(i >= 0) || i >= n) return shift ? n - 1 : 0
  if (shift && i === 0) return n - 1
  if (!shift && i === n - 1) return 0
  return -1
}
