<template>
  <!-- Drag handlers live on the WRAPPER, never on the inner <button>: a disabled
       button stops firing events, the drop would bubble to the document, and the
       browser would happily navigate away from the SPA to render the file. The
       wrapper always preventDefault()s, busy or not. -->
  <div class="fdz" :class="{ 'fdz-compact': compact }" v-bind="dropzoneProps">
    <slot :drag-active="dragActive" :busy="busy" :open-picker="openPicker" :supports-drag="supportsDrag">
      <button
        type="button"
        class="fdz-zone"
        :class="{ 'is-over': dragActive, 'is-busy': busy }"
        :disabled="busy || disabled"
        :aria-busy="busy"
        @click="openPicker"
      >
        <span v-if="busy" class="fdz-spinner" aria-hidden="true"></span>
        <slot v-else name="icon">
          <svg class="fdz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <polyline points="9 15 12 12 15 15" />
          </svg>
        </slot>
        <span class="fdz-copy">
          <span class="fdz-title">
            <template v-if="busy">{{ busyLabel }}</template>
            <template v-else-if="dragActive">{{ dropLabel }}</template>
            <template v-else>{{ resolvedLabel }}</template>
          </span>
          <span class="fdz-hint">
            <slot name="hint">
              <template v-if="busy">{{ busyHint }}</template>
              <template v-else>{{ resolvedHint }}</template>
            </slot>
          </span>
        </span>
      </button>
    </slot>

    <input
      :ref="setInputEl"
      v-bind="inputProps"
      class="fdz-file"
      tabindex="-1"
      aria-hidden="true"
    />

    <p v-if="showErrors && notice" class="fdz-msg fdz-msg-note" aria-live="polite">{{ notice }}</p>
    <p v-if="showErrors && error" class="fdz-msg fdz-msg-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="fdz-msg-dismiss" @click="clearMessages">Dismiss</button>
    </p>
  </div>
</template>

<script setup>
// Default chrome for a drop target. Deliberately thin: EVERY mechanic and every
// validation rule lives in useFileDrop, so a surface that needs its own chrome
// (chat composer, avatar label, Vant uploader) calls the composable directly and
// inherits identical behaviour rather than forking it.
import { computed, toRef } from 'vue'
import { useFileDrop } from '../../composables/useFileDrop'
import { describeAccept } from '../../lib/fileValidation'

const props = defineProps({
  accept: { type: String, default: '' },
  multiple: { type: Boolean, default: false },
  // Remaining capacity, not a constant — bind it to (LIMIT - loaded) so the
  // over-limit message names the right number.
  maxFiles: { type: Number, default: 0 },
  maxSizeMb: { type: Number, default: 0 },
  disabled: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  capture: { type: String, default: '' },
  label: { type: String, default: '' },
  hint: { type: String, default: '' },
  busyLabel: { type: String, default: 'Working…' },
  busyHint: { type: String, default: 'This takes a moment.' },
  dropLabel: { type: String, default: 'Drop to upload' },
  // Compact = a slim strip inline above a table. Full = a taller banner.
  compact: { type: Boolean, default: false },
  // Set false when the host renders its own error surface (a toast, a form row).
  showErrors: { type: Boolean, default: true },
})

const emit = defineEmits(['files', 'reject', 'notice'])

const { dropzoneProps, inputProps, setInputEl, openPicker, dragActive, supportsDrag, error, notice, clearMessages } =
  useFileDrop({
    accept: toRef(props, 'accept'),
    multiple: toRef(props, 'multiple'),
    maxFiles: toRef(props, 'maxFiles'),
    maxSizeMb: toRef(props, 'maxSizeMb'),
    disabled: toRef(props, 'disabled'),
    busy: toRef(props, 'busy'),
    capture: toRef(props, 'capture'),
    onFiles: (files) => emit('files', files),
    onReject: (rejections) => emit('reject', rejections),
  })

// Touch devices have no drag-and-drop, so telling a driver on a phone to "drop"
// a file is an instruction they cannot follow. Copy only — never gates anything.
const resolvedLabel = computed(() => {
  if (props.label) return props.label
  return supportsDrag.value ? 'Drop a file here' : 'Tap to choose a file'
})

const resolvedHint = computed(() => {
  if (props.hint) return props.hint
  const types = describeAccept(props.accept)
  const size = props.maxSizeMb > 0 ? ` · up to ${props.maxSizeMb} MB` : ''
  const verb = supportsDrag.value ? 'or click to browse' : 'Choose from your device'
  return types ? `${verb} — ${types}${size}` : `${verb}${size}`
})
</script>

<style scoped>
/* position:relative contains the off-screen input below; with no offsets it
   moves nothing and only establishes a containing block. */
.fdz {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.fdz-zone {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  text-align: left;
  font-family: inherit;
  padding: 1.25rem 1.1rem;
  border: 1.5px dashed var(--border, #e2e4ea);
  border-radius: var(--radius, 10px);
  background: var(--surface, #fff);
  color: var(--text, #1a1d27);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.fdz-zone:hover:not(:disabled) {
  border-color: var(--accent, #38bdf8);
  background: var(--accent-dim, rgba(56, 189, 248, 0.1));
}
.fdz-zone:focus-visible {
  outline: 2px solid var(--accent, #38bdf8);
  outline-offset: 2px;
}
.fdz-zone.is-over {
  border-color: var(--accent, #38bdf8);
  border-style: solid;
  background: var(--accent-dim, rgba(56, 189, 248, 0.1));
}
.fdz-zone:disabled { cursor: default; opacity: 0.65; }
.fdz-zone.is-busy {
  border-style: solid;
  border-color: var(--accent, #38bdf8);
  background: var(--accent-dim, rgba(56, 189, 248, 0.1));
  opacity: 1;
}

.fdz-compact .fdz-zone { padding: 0.6rem 0.85rem; gap: 0.6rem; }

.fdz-icon {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  color: var(--accent, #38bdf8);
}
.fdz-compact .fdz-icon { width: 20px; height: 20px; }

.fdz-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.fdz-title {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
}
.fdz-hint {
  font-size: 0.75rem;
  color: var(--text-dim, #6b7085);
  line-height: 1.35;
}
.fdz-compact .fdz-title { font-size: 0.8125rem; }
.fdz-compact .fdz-hint { font-size: 0.7rem; }

.fdz-spinner {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border: 2px solid var(--accent-dim, rgba(56, 189, 248, 0.25));
  border-top-color: var(--accent, #38bdf8);
  border-radius: 50%;
  animation: fdz-spin 0.7s linear infinite;
}
@keyframes fdz-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .fdz-spinner { animation-duration: 2s; }
  .fdz-zone { transition: none; }
}

/* Off-screen rather than display:none so assistive tech and programmatic
   .click() both behave predictably across browsers. */
.fdz-file {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.fdz-msg {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
  padding: 0.5rem 0.7rem;
  font-size: 0.75rem;
  line-height: 1.4;
  border-radius: 6px;
}
.fdz-msg-note {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}
.fdz-msg-error {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  justify-content: space-between;
}
.fdz-msg-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 700;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}

@media (max-width: 640px) {
  .fdz-zone { padding: 0.85rem 0.75rem; }
  .fdz-compact .fdz-zone { padding: 0.55rem 0.7rem; }
}
</style>
