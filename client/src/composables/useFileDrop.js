// Drag-and-drop + click-to-browse mechanics for every upload surface.
//
// This is the primitive. `components/shared/FileDropZone.vue` is a thin consumer
// of it that supplies the default dashed-box chrome; surfaces that already have
// their own chrome (chat composers, avatar labels, the apply-wizard cards, the
// Vant uploader) call this directly and keep their markup. Every rule below is
// therefore implemented exactly once.
//
// Lifted from components/shared/RateConDropzone.vue, which was the only surface
// in the app with working drag-and-drop and got the hard parts right. The
// numbered comments below are why each part exists — they are not decoration,
// each one is a bug that was already found and fixed once.

import { computed, onBeforeUnmount, onMounted, ref, toValue } from 'vue'
import { REJECT_EMPTY, summarizeRejections, validateFiles } from '../lib/fileValidation'

// ───────────────────────────────────────────────────────────────────────────
// The stray-drop guard: ONE listener pair for the whole app, refcounted.
//
// Why it exists: the browser's default action for a file dropped anywhere on the
// document is to NAVIGATE to that file. Miss the dropzone by ten pixels and the
// SPA is torn down — a half-filled Log Expense form, a 25-row bulk receipt grid,
// or a public job application with no draft, all gone. So while any dropzone is
// on screen, file drops everywhere else are swallowed.
//
// ⚠️ WHY REFCOUNTED, AND WHY YOU MUST NOT "SIMPLIFY" THIS.
// ExpensesTab renders BulkReceiptScan under `v-show`, not `v-if` (its comment:
// "Unmounting here would silently discard all of it"), so on /expenses the Log
// Expense zone and the Bulk zone are BOTH mounted at all times. Add a Drivers DB
// row modal and there are three.
//
// The obvious cleanup — declare the handler once at module scope and let each
// instance add/remove it — is silently catastrophic. addEventListener
// de-duplicates identical (type, listener, capture) triples, so instance 2's add
// is a no-op, and instance 1's unmount removes the guard for EVERY zone still
// alive. Closing a modal on /expenses would unprotect the bulk grid with no
// visible symptom until someone missed a drop and lost their batch.
//
// Per-instance closures (what RateConDropzone did) are correct but install one
// listener pair per zone, all doing identical work on every dragover frame at
// ~60 Hz. The refcount gives correctness AND one pair. Modelled on the in-repo
// precedent, composables/useViewport.js.
let strayGuardCount = 0
// Cleared on any window-level drop/dragend so a drag that leaves the window —
// which fires dragleave but never drop — cannot leave a zone stuck highlighted.
const dragResetters = new Set()

function isFileDrag(e) {
  const types = e.dataTransfer && Array.from(e.dataTransfer.types || [])
  return !!types && types.includes('Files')
}

function onWindowDragOver(e) {
  if (!isFileDrag(e)) return // leave text/link drags alone
  // (a) A zone's own handler runs at the target and bubbles to window, so by the
  //     time we see a claimed event there is nothing to do.
  if (e.defaultPrevented) return
  // (b) ⚠️ NEVER cancel a native file input's own drop. Assigning the dropped
  //     files IS that input's default action, so preventDefault() here makes a
  //     bare <input type="file"> silently ignore a drop that visibly landed on
  //     it. That breaks every surface not yet migrated, and any added later.
  if (e.target?.closest?.('input[type="file"]')) return
  e.preventDefault()
  // Say so with the cursor rather than falsely promising a copy we're about to eat.
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
}

function onWindowDrop(e) {
  for (const reset of dragResetters) reset()
  if (!isFileDrag(e)) return
  if (e.defaultPrevented) return
  if (e.target?.closest?.('input[type="file"]')) return
  e.preventDefault()
}

function onWindowDragEnd() {
  for (const reset of dragResetters) reset()
}

function retainStrayDropGuard() {
  if (strayGuardCount === 0) {
    window.addEventListener('dragover', onWindowDragOver)
    window.addEventListener('drop', onWindowDrop)
    window.addEventListener('dragend', onWindowDragEnd)
  }
  strayGuardCount++
}

function releaseStrayDropGuard() {
  strayGuardCount = Math.max(0, strayGuardCount - 1)
  if (strayGuardCount === 0) {
    window.removeEventListener('dragover', onWindowDragOver)
    window.removeEventListener('drop', onWindowDrop)
    window.removeEventListener('dragend', onWindowDragEnd)
  }
}

// Exported for hand-verification only — see the plan's guard-refcount check.
// Without this, "is the guard actually installed?" is unanswerable without a
// debugger, and the failure mode it protects against is silent.
export function __strayDropGuardCount() {
  return strayGuardCount
}

// Touch devices have no drag-and-drop. This only ever changes COPY ("Tap to
// add…" vs "Drop … here") — it must never gate a handler, because a hybrid
// laptop reports touch and still drags.
const canDrag =
  typeof window !== 'undefined' && 'ondragover' in window && !/Mobi|Android/i.test(navigator?.userAgent || '')

export function useFileDrop(options = {}) {
  const {
    accept = '',
    multiple = false,
    maxFiles = 0,
    maxSizeMb = 0,
    disabled = false,
    busy = false,
    capture = '',
    busyNotice = 'Still working on the last file — wait for it to finish.',
    onFiles,
    onReject = null,
  } = options

  const inputRef = ref(null)
  const error = ref('')
  const notice = ref('')
  // ⚠️ Depth counter, NOT a boolean. dragenter/dragleave also fire when the
  // pointer crosses a CHILD element, so a boolean flickers the highlight the
  // whole time the pointer is over the zone's own icon or label.
  const dragDepth = ref(0)

  const isDisabled = computed(() => !!toValue(disabled))
  const isBusy = computed(() => !!toValue(busy))
  const dragActive = computed(() => dragDepth.value > 0 && !isBusy.value && !isDisabled.value)
  const supportsDrag = computed(() => canDrag)

  function resetDrag() {
    dragDepth.value = 0
  }

  onMounted(() => {
    dragResetters.add(resetDrag)
    retainStrayDropGuard()
  })
  onBeforeUnmount(() => {
    dragResetters.delete(resetDrag)
    releaseStrayDropGuard()
  })

  function clearMessages() {
    error.value = ''
    notice.value = ''
  }

  function setInputEl(el) {
    inputRef.value = el
  }

  function openPicker() {
    if (isBusy.value || isDisabled.value) return
    inputRef.value?.click()
  }

  function handleFiles(files) {
    clearMessages()
    const list = Array.from(files || [])
    if (!list.length) return

    const { accepted, rejections } = validateFiles(list, {
      accept: toValue(accept),
      multiple: toValue(multiple),
      maxFiles: toValue(maxFiles),
      maxSizeMb: toValue(maxSizeMb),
    })

    if (rejections.length) {
      error.value = summarizeRejections(rejections)
      if (typeof onReject === 'function') onReject(rejections)
    }
    // Partial success is still success — never discard the good files because a
    // sibling was refused. Both messages are surfaced at once.
    if (accepted.length && typeof onFiles === 'function') onFiles(accepted)
  }

  function onDragEnter() {
    dragDepth.value++
  }

  function onDragOver(e) {
    // ⚠️ Required on EVERY frame, not just on enter. Without a preventDefault in
    // dragover the drop is never allowed to happen at all.
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = isBusy.value || isDisabled.value ? 'none' : 'copy'
    }
  }

  function onDragLeave() {
    dragDepth.value = Math.max(0, dragDepth.value - 1)
  }

  function onDrop(e) {
    dragDepth.value = 0
    if (isBusy.value) {
      notice.value = toValue(busyNotice)
      return
    }
    if (isDisabled.value) return

    // Folders must be caught HERE. dataTransfer.items is the only place the
    // directory flag survives — by the time it reaches dataTransfer.files a
    // folder is just a zero-byte File with no type, indistinguishable from an
    // empty file. Read it synchronously; the list is neutered after this tick.
    const items = e.dataTransfer?.items
    if (items && items.length) {
      let sawDirectory = false
      for (const item of items) {
        if (item.kind !== 'file') continue
        const entry = item.webkitGetAsEntry?.()
        if (entry && entry.isDirectory) {
          sawDirectory = true
          break
        }
      }
      if (sawDirectory) {
        clearMessages()
        const message = 'Folders can’t be uploaded — open the folder and drag the files inside it.'
        error.value = message
        // ⚠️ MUST go through onReject as well. A surface that routes rejections
        // to a toast and never renders `error` would otherwise show absolutely
        // nothing for a dropped folder — the one rejection with no file to name.
        if (typeof onReject === 'function') {
          onReject([{ file: null, reason: REJECT_EMPTY, message }])
        }
        return
      }
    }

    handleFiles(e.dataTransfer?.files)
  }

  function onPicked(e) {
    const files = Array.from(e.target?.files || [])
    // ⚠️ Clear the input BEFORE handling. Without this, re-picking the same file
    // after an error never fires @change again, so the user's obvious recovery
    // (fix it, pick it again) silently does nothing.
    if (e.target) e.target.value = ''
    handleFiles(files)
  }

  // v-bind onto the WRAPPER element, never onto an inner <button>. A disabled
  // button stops firing events entirely, so the drop would bubble past it to the
  // document and the browser would navigate away. The wrapper always
  // preventDefault()s a FILE drag, busy or not.
  //
  // ⚠️ EVERY HANDLER IS GATED ON isFileDrag, exactly like the window guard.
  // These handlers go on a wrapper, and a wrapper can contain a text input —
  // the chat composers are the first zones where that is true. Ungated, dragging
  // selected text into a reply box lit up "Drop to attach" and then swallowed
  // the drop (a text drag carries an empty FileList, so handleFiles early-
  // returns in silence), which is a plain regression against a browser default
  // that used to work. Gating dragenter and dragleave with the SAME predicate
  // also keeps the depth counter balanced — gating only one would strand the
  // highlight on.
  const dropzoneProps = computed(() => ({
    onDragenter: (e) => { if (!isFileDrag(e)) return; e.preventDefault(); onDragEnter() },
    onDragover: (e) => { if (!isFileDrag(e)) return; e.preventDefault(); onDragOver(e) },
    onDragleave: (e) => { if (!isFileDrag(e)) return; e.preventDefault(); onDragLeave() },
    onDrop: (e) => { if (!isFileDrag(e)) return; e.preventDefault(); onDrop(e) },
  }))

  // v-bind onto the hidden <input type="file">.
  // ⚠️ `capture` is OMITTED unless explicitly set. Rendering capture="" on
  // DocumentUpload's camera inputs forces the FILE BROWSER instead of the camera,
  // which is how drivers photograph PODs. An absent key can't clobber markup.
  const inputProps = computed(() => {
    const props = {
      type: 'file',
      accept: toValue(accept) || undefined,
      multiple: toValue(multiple) || undefined,
      onChange: onPicked,
    }
    const cap = toValue(capture)
    if (cap) props.capture = cap
    return props
  })

  return {
    dropzoneProps,
    inputProps,
    setInputEl,
    openPicker,
    handleFiles,
    dragActive,
    supportsDrag,
    error,
    notice,
    clearMessages,
  }
}
