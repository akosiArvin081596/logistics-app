// Keeps a keyboard-focused item, and `margin` px around it for its focus
// outline, inside the sideways scroll box it sits in (2026-10-22, #578).
//
// Only `scroller` moves, never the page (unlike scrollIntoView), and only as
// far as needed: an item already in view, or a box with nothing to scroll (a
// desktop width), stays as it is. Mouse and touch focus don't match
// :focus-visible, so a click or a tap never moves the box. A browser that
// doesn't know :focus-visible (matches() throws) is treated as no keyboard
// focus: the box stays as it is.
export function revealOnKeyboardFocus(el, scroller, margin = 0) {
  if (!el || !scroller) return
  let keyboard = false
  try { keyboard = el.matches(':focus-visible') } catch { return }
  if (!keyboard) return
  const box = scroller.getBoundingClientRect()
  const item = el.getBoundingClientRect()
  const left = item.left - margin
  const right = item.right + margin
  if (left < box.left) scroller.scrollLeft -= box.left - left
  else if (right > box.right) scroller.scrollLeft += right - box.right
}
