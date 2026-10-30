import { ref, watch, onBeforeUnmount } from 'vue'

// The content-box width of one element (a template ref), kept current by a
// ResizeObserver: for a layout that depends on the space a panel actually has,
// which the window width alone can't tell (the sidebar may be open or folded).
// A hidden element (display: none, as under v-show) measures 0; the last real
// width is kept, so a layout chosen from it doesn't flip while it is hidden.
export function useElementWidth(elRef) {
  const width = ref(0)
  let observer = null
  const stop = () => {
    if (observer) observer.disconnect()
    observer = null
  }
  watch(elRef, (el) => {
    stop()
    if (!el || typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1].contentRect.width
      if (w > 0) width.value = w
    })
    observer.observe(el)
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(stop)
  return { width }
}
