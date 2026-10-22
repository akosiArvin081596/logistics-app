#!/usr/bin/env node
// The driver app's centered dialogs never cut themselves off on a short phone or
// with large text (2026-10-22).
//
// WHY THIS EXISTS. The "Welcome to the Team!" card a newly onboarded driver sees
// sat in a fixed overlay with align-items: center and no overflow, and the card
// had no max-height. At 390x664 with a 125% root font the card is 833 px tall in
// a 664 px window: centering pushed ~85 px off the top and the bottom, nothing
// scrolled, and "Let's Get Started" (the only way out) was out of reach. The
// decline confirmation in DriverView and the driver's Change Password dialog use
// the same fixed + centered + no-overflow pattern.
//
//   §1 the welcome overlay scrolls, with safe-area padding at the top and bottom
//   §2 the welcome card centers with margin: auto (never clips its top) and is
//      capped at the window height (100dvh, with a 100vh fallback first, less the
//      overlay's padding and both safe-area insets); its own content scrolls
//   §3 a close (x) button at the top of the card: a <button type="button">,
//      aria-label "Close", at least 44x44, calling dismissWelcome() like
//      "Let's Get Started" does; dismissWelcome() saves the seen flag
//   §4 the decline confirmation overlay scrolls and its dialog centers with
//      margin: auto
//   §5 the Change Password overlay scrolls and its dialog centers with margin: auto
//   §6 overscroll containment sits on the welcome overlay only, so on a browser
//      without dvh (both may scroll) a swipe on the card can hand over to it
//   §7 the keyboard: focus moves to the close (x) when the card opens, and Escape
//      on the overlay (focusable, so a tap inside the card keeps focus there) calls
//      dismissWelcome()
//
// The components' own markup and styles, parsed with the client's compiler and
// postcss. No DOM, no browser (scripts/e2e/driver-welcome.mjs is the browser half).
//   node scripts/test-driver-modal-scroll.mjs
//   DRIVER_VIEW_VUE=/tmp/base/DriverView.vue node scripts/test-driver-modal-scroll.mjs        # a base copy: fails
//   CHANGE_PASSWORD_VUE=/tmp/base/ChangePasswordModal.vue node scripts/test-driver-modal-scroll.mjs
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, '..')
const CLIENT_DIR = path.join(ROOT, 'client')
const DRIVER_VIEW_VUE = process.env.DRIVER_VIEW_VUE || path.join(CLIENT_DIR, 'src', 'views', 'DriverView.vue')
const CHANGE_PASSWORD_VUE = process.env.CHANGE_PASSWORD_VUE || path.join(CLIENT_DIR, 'src', 'components', 'driver', 'ChangePasswordModal.vue')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}
function eq(name, actual, expected) {
  ok(`${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`, actual === expected)
}

const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const { parse } = clientRequire('vue/compiler-sfc')
const postcss = clientRequire('postcss')

function load(file) {
  const { descriptor, errors } = parse(fs.readFileSync(file, 'utf8'), { filename: file })
  if (errors.length) throw new Error(`${file}: ${errors[0].message || errors[0]}`)
  const css = descriptor.styles.map((s) => s.content).join('\n')
  return { descriptor, root: postcss.parse(css), script: descriptor.scriptSetup?.content || descriptor.script?.content || '' }
}

// Every declaration of `prop` in the top-level rules whose selector list names
// exactly `selector`, in source order (a later one wins in the browser).
function decls(root, selector, prop) {
  const out = []
  root.each((node) => {
    if (node.type !== 'rule') return
    if (!node.selectors.map((s) => s.trim()).includes(selector)) return
    node.walkDecls(prop, (d) => out.push(d.value.replace(/\s+/g, ' ').trim()))
  })
  return out
}
const last = (list) => list[list.length - 1]
// overflow and overflow-y read together, in source order: the later one wins.
const scrolls = (root, sel) => ['auto', 'scroll'].includes(last(decls(root, sel, /^overflow(-y)?$/)))
// A centered flex item with margin: auto keeps its top in the scrollable area when
// it is taller than the overlay; align-items: safe center does the same.
const safeCentered = (root, overlay, card) =>
  last(decls(root, card, 'margin')) === 'auto' || /^safe\b/.test(last(decls(root, overlay, 'align-items')) || '')

// ══ §1-§3 the welcome card ═══════════════════════════════════════════════════
const dv = load(DRIVER_VIEW_VUE)

console.log('§1 the welcome overlay scrolls, with safe-area padding')
eq('the welcome overlay is position: fixed', last(decls(dv.root, '.welcome-overlay', 'position')), 'fixed')
ok('the welcome overlay scrolls (overflow-y: auto)', scrolls(dv.root, '.welcome-overlay'))
ok('the welcome overlay pads the top by the safe-area inset',
  /env\(safe-area-inset-top/.test(last(decls(dv.root, '.welcome-overlay', 'padding-top')) || ''))
ok('the welcome overlay pads the bottom by the safe-area inset',
  /env\(safe-area-inset-bottom/.test(last(decls(dv.root, '.welcome-overlay', 'padding-bottom')) || ''))

console.log('§2 the welcome card centers safely and is capped at the window height')
ok('the welcome card centers with margin: auto (or the overlay uses align-items: safe center)',
  safeCentered(dv.root, '.welcome-overlay', '.welcome-card'))
const maxH = decls(dv.root, '.welcome-card', 'max-height')
const capped = (v) => /calc\(/.test(v) && /2rem/.test(v) && /env\(safe-area-inset-top/.test(v) && /env\(safe-area-inset-bottom/.test(v)
ok('the welcome card has a max-height', maxH.length > 0)
ok('the welcome card\'s last max-height is calc(100dvh - 2rem - both safe-area insets)', capped(last(maxH) || '') && /100dvh/.test(last(maxH)))
const vhAt = maxH.findIndex((v) => /100vh/.test(v) && capped(v))
const dvhAt = maxH.findIndex((v) => /100dvh/.test(v))
ok('a 100vh max-height comes first as the fallback for browsers without dvh', vhAt >= 0 && dvhAt > vhAt)
ok('the welcome card\'s own content scrolls when it is capped', scrolls(dv.root, '.welcome-card'))

console.log('§3 a close (x) button at the top of the welcome card')
function findEl(node, pred) {
  if (node.type === 1 && pred(node)) return node
  for (const c of node.children || []) {
    const hit = findEl(c, pred)
    if (hit) return hit
  }
  return null
}
const attr = (el, name) => el.props.find((p) => p.type === 6 && p.name === name)?.value?.content
const onClick = (el) => el.props.find((p) => p.type === 7 && p.name === 'on' && p.arg?.content === 'click')?.exp?.content?.trim()
const hasClass = (el, cls) => (attr(el, 'class') || '').split(/\s+/).includes(cls)
const card = findEl(dv.descriptor.template.ast, (el) => hasClass(el, 'welcome-card'))
ok('the template has a .welcome-card', !!card)
const firstChild = card ? card.children.find((c) => c.type === 1) : null
eq('the card\'s first element is a <button>', firstChild?.tag, 'button')
eq('the close button is type="button"', firstChild && attr(firstChild, 'type'), 'button')
eq('the close button\'s aria-label is "Close"', firstChild && attr(firstChild, 'aria-label'), 'Close')
eq('the close button calls dismissWelcome', firstChild && onClick(firstChild), 'dismissWelcome')
const closeCls = firstChild ? (attr(firstChild, 'class') || '').split(/\s+/)[0] : ''
const px = (v) => (/^\d+(\.\d+)?px$/.test(v || '') ? parseFloat(v) : (/^\d+(\.\d+)?rem$/.test(v || '') ? parseFloat(v) * 16 : 0))
ok('the close button has a class to style it', !!closeCls)
ok('the close button is at least 44 px wide', px(last(decls(dv.root, `.${closeCls}`, 'width'))) >= 44)
ok('the close button is at least 44 px tall', px(last(decls(dv.root, `.${closeCls}`, 'height'))) >= 44)
const start = card ? findEl(card, (el) => el.tag === 'button' && /Let's Get Started/.test(el.children.map((c) => c.content || '').join(''))) : null
eq('"Let\'s Get Started" still calls dismissWelcome', start && onClick(start), 'dismissWelcome')
const dismissSrc = (dv.script.match(/function dismissWelcome\(\)\s*\{[\s\S]*?\n\}/) || [''])[0]
ok('dismissWelcome() saves the seen flag (localStorage.setItem under the welcome key)',
  /welcomeStorageKey\(\)/.test(dismissSrc) && /localStorage\.setItem\(key,/.test(dismissSrc))

// ══ §4 the decline confirmation ══════════════════════════════════════════════
console.log('§4 the decline confirmation overlay scrolls')
ok('the decline overlay scrolls (overflow-y: auto)', scrolls(dv.root, '.confirm-overlay'))
ok('the decline dialog centers with margin: auto', safeCentered(dv.root, '.confirm-overlay', '.confirm-dialog'))

// ══ §5 Change Password ═══════════════════════════════════════════════════════
console.log('§5 the Change Password overlay scrolls')
const pw = load(CHANGE_PASSWORD_VUE)
ok('the Change Password overlay scrolls (overflow-y: auto)', scrolls(pw.root, '.pw-overlay'))
ok('the Change Password dialog centers with margin: auto', safeCentered(pw.root, '.pw-overlay', '.pw-dialog'))

// ══ §6-§7 the welcome card's scroll handover and keyboard ════════════════════
console.log('§6 overscroll containment on the welcome overlay only')
eq('the welcome overlay keeps overscroll-behavior: contain', last(decls(dv.root, '.welcome-overlay', 'overscroll-behavior')), 'contain')
eq('the welcome card sets no overscroll-behavior', decls(dv.root, '.welcome-card', 'overscroll-behavior').length, 0)

console.log('§7 focus moves into the card and Escape closes it')
const overlay = findEl(dv.descriptor.template.ast, (el) => hasClass(el, 'welcome-overlay'))
const escDir = overlay && overlay.props.find((p) => p.type === 7 && p.name === 'on' && p.arg?.content === 'keydown' &&
  (p.modifiers || []).some((m) => (m?.content ?? m) === 'esc' || (m?.content ?? m) === 'escape'))
eq('Escape on the welcome overlay calls dismissWelcome', escDir?.exp?.content?.trim(), 'dismissWelcome')
eq('the welcome overlay is focusable (tabindex="-1")', overlay && attr(overlay, 'tabindex'), '-1')
const closeRef = firstChild && attr(firstChild, 'ref')
ok('the close button has a template ref', !!closeRef)
ok('opening the card focuses the close button after the next render',
  !!closeRef && new RegExp(`watch\\(showWelcomeModal,[\\s\\S]{0,200}?nextTick\\([\\s\\S]{0,80}?${closeRef}\\.value\\??\\.focus\\(\\)`).test(dv.script))

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
