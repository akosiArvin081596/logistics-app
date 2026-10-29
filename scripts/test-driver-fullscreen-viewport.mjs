#!/usr/bin/env node
// The driver's document-signing screen, and the driver-facing previews and popups
// that size themselves by the window, fit the part of the screen a phone shows
// (2026-10-22).
//
// WHY THIS EXISTS. DocumentSignModal.vue sized its screen width: 100vw;
// height: 100vh and centred it in a fixed overlay that does not scroll. On a
// phone, 100vh is the height with the browser's toolbars hidden; while they show,
// the visible area is shorter. With it 100 px shorter the screen stuck out ~50 px
// at the top and the bottom: the header's close (x) sat entirely above the screen
// and the Sign button stayed mostly below it, even with the form scrolled to its
// end. On the phone layout the PDF (min-height 40vh) and the form (max-height
// 50vh, never shrinking) also asked for more than the visible area, and the body
// clips what does not fit. The same bare vh sizes sit on the maintenance notice,
// the upload page's document preview and the photo zoom viewer, whose close
// buttons are 40 px with no safe-area inset.
//
//   §1 the signing screen is the overlay's size (height: 100% of a fixed inset: 0
//      overlay, or 100dvh after a 100vh fallback), never a bare 100vh, and pads
//      the safe-area insets inside its own height
//   §2 no size on the signing screen is a bare vh that wins (each has a dvh line
//      after it), and on the phone layout the form panel can shrink and scroll
//   §3 the header close (x) is a 44x44 <button type="button"> labelled "Close"
//      that emits close, in a header that never shrinks; the Sign button sits in
//      the form's own scroller
//   §4 the maintenance notice's height cap is 90dvh after a 90vh fallback
//   §5 the upload preview's image and PDF frame use dvh after a vh fallback; its
//      close sits below and inside the safe-area insets and is 44x44
//   §6 the photo zoom viewer's image cap uses dvh after a vh fallback; its close
//      sits inside the safe-area insets and is 44x44
//   §7 the investor's signing screen (InvestorSignModal.vue, the same layout) had
//      the same 100vw x 100vh: it fills its overlay, pads the safe-area insets
//      inside its own height, and on the phone layout no bare vh wins and the
//      form panel shrinks and scrolls (2026-10-22)
//
// The components' own markup and styles, parsed with the client's compiler and
// postcss. No DOM, no browser (scripts/e2e/driver-document-sign.mjs is the
// browser half).
//   node scripts/test-driver-fullscreen-viewport.mjs
//   DOCUMENT_SIGN_VUE=/tmp/base/DocumentSignModal.vue node scripts/test-driver-fullscreen-viewport.mjs   # a base copy: fails
//   MAINTENANCE_MODAL_VUE=… DOCUMENT_UPLOAD_VUE=… ZOOMABLE_IMAGE_VUE=… INVESTOR_SIGN_VUE=…               # likewise
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, '..')
const CLIENT_DIR = path.join(ROOT, 'client')
const SRC = path.join(CLIENT_DIR, 'src', 'components')
const DOCUMENT_SIGN_VUE = process.env.DOCUMENT_SIGN_VUE || path.join(SRC, 'driver', 'DocumentSignModal.vue')
const MAINTENANCE_MODAL_VUE = process.env.MAINTENANCE_MODAL_VUE || path.join(SRC, 'shared', 'MaintenanceModal.vue')
const DOCUMENT_UPLOAD_VUE = process.env.DOCUMENT_UPLOAD_VUE || path.join(SRC, 'driver', 'DocumentUpload.vue')
const ZOOMABLE_IMAGE_VUE = process.env.ZOOMABLE_IMAGE_VUE || path.join(SRC, 'shared', 'ZoomableImage.vue')
const INVESTOR_SIGN_VUE = process.env.INVESTOR_SIGN_VUE || path.join(SRC, 'invest', 'InvestorSignModal.vue')

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
  return { descriptor, root: postcss.parse(css) }
}

// The at-rule a rule sits in ('' at the top level), e.g. "media (max-width: 768px)".
function context(rule) {
  const parts = []
  for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
    if (p.type === 'atrule') parts.unshift(`${p.name} ${p.params}`.replace(/\s+/g, ' ').trim())
  }
  return parts.join(' / ')
}
// Every declaration of `prop` (a name or a RegExp) in the rules whose selector
// list names exactly `selector`, inside `ctx` ('' = top level; a RegExp matches
// the at-rule), in source order: a later one wins in the browser.
function decls(root, selector, prop, ctx = '') {
  const out = []
  root.walkRules((rule) => {
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return
    const c = context(rule)
    if (ctx instanceof RegExp ? !ctx.test(c) : c !== ctx) return
    rule.walkDecls(prop, (d) => out.push(d.value.replace(/\s+/g, ' ').trim()))
  })
  return out
}
const last = (list) => list[list.length - 1]
const PHONE = /^media \(max-width: ?768px\)$/

// A length in vh that is not dvh, svh or lvh: the toolbar-hidden height on a phone.
const bareVh = (v) => /(^|[^a-z\d.])\d*\.?\d+vh\b/.test(v || '')
const dvh = (v) => /\d*\.?\d+dvh\b/.test(v || '')
// Every rule's winning value for a vh size, as "selector prop: value" for each one
// that is still a bare vh.
function vhWinners(root) {
  const groups = new Map()
  root.walkDecls((d) => {
    if (d.parent.type !== 'rule') return
    const key = `${context(d.parent)}|${d.parent.selector}|${d.prop}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(d.value)
  })
  const leaks = []
  for (const [key, values] of groups) {
    if (!values.some(bareVh)) continue
    if (bareVh(last(values))) leaks.push(`${key.split('|').filter(Boolean).join(' ')}: ${last(values)}`)
  }
  return leaks
}
// A dvh cap with the same size in vh before it, as the fallback for browsers
// without dvh.
function dvhAfterVh(values, size) {
  const vhAt = values.findIndex((v) => new RegExp(`(^|[^a-z\\d.])${size}vh\\b`).test(v))
  const dvhAt = values.findIndex((v) => new RegExp(`(^|[^a-z\\d.])${size}dvh\\b`).test(v))
  return vhAt >= 0 && dvhAt > vhAt && dvhAt === values.length - 1
}

const px = (v) => (/^\d+(\.\d+)?px$/.test(v || '') ? parseFloat(v) : (/^\d+(\.\d+)?rem$/.test(v || '') ? parseFloat(v) * 16 : 0))

function findEl(node, pred) {
  if (node.type === 1 && pred(node)) return node
  for (const c of node.children || []) {
    const hit = findEl(c, pred)
    if (hit) return hit
  }
  return null
}
const attr = (el, name) => el?.props.find((p) => p.type === 6 && p.name === name)?.value?.content
const onClick = (el) => el?.props.find((p) => p.type === 7 && p.name === 'on' && p.arg?.content === 'click')?.exp?.content?.replace(/\s+/g, '')
const hasClass = (el, cls) => (attr(el, 'class') || '').split(/\s+/).includes(cls)

// A fixed button sits inside the safe-area insets when its top and right offsets
// add them, and is a 44x44 tap target.
function safeCorner(root, sel, label) {
  ok(`${label}: top adds the safe-area top inset`, /env\(safe-area-inset-top/.test(last(decls(root, sel, 'top')) || ''))
  ok(`${label}: right adds the safe-area right inset`, /env\(safe-area-inset-right/.test(last(decls(root, sel, 'right')) || ''))
  ok(`${label}: at least 44 px wide`, px(last(decls(root, sel, 'width'))) >= 44)
  ok(`${label}: at least 44 px tall`, px(last(decls(root, sel, 'height'))) >= 44)
}

// ══ §1-§3 the document-signing screen ════════════════════════════════════════
const ds = load(DOCUMENT_SIGN_VUE)

console.log('§1 the signing screen is the overlay\'s size and pads the safe-area insets')
eq('the overlay is position: fixed', last(decls(ds.root, '.modal-overlay', 'position')), 'fixed')
const inset0 = last(decls(ds.root, '.modal-overlay', 'inset')) === '0' ||
  ['top', 'right', 'bottom', 'left'].every((p) => last(decls(ds.root, '.modal-overlay', p)) === '0')
ok('the overlay is pinned to every edge of the window (inset: 0)', inset0)
const overlayH = decls(ds.root, '.modal-overlay', 'height')
ok('the overlay\'s height is the edges\' (none set) or 100dvh after a 100vh fallback',
  overlayH.length === 0 || dvhAfterVh(overlayH, 100))
const panelH = decls(ds.root, '.modal-fullscreen', 'height')
ok('the screen\'s height is never a bare 100vh', !bareVh(last(panelH)))
ok('the screen fills the overlay (height: 100%), or is 100dvh after a 100vh fallback',
  last(panelH) === '100%' || dvhAfterVh(panelH, 100))
ok('the screen\'s width is never a bare 100vw (it fills the overlay)', !/(^|[^a-z])100vw\b/.test(last(decls(ds.root, '.modal-fullscreen', 'width')) || ''))
eq('the screen counts its padding inside its height (box-sizing: border-box)', last(decls(ds.root, '.modal-fullscreen', 'box-sizing')), 'border-box')
ok('the screen pads the top by the safe-area inset (the header clears the notch)',
  /env\(safe-area-inset-top/.test(last(decls(ds.root, '.modal-fullscreen', 'padding-top')) || ''))
ok('the screen pads the bottom by the safe-area inset (the Sign row clears the home bar)',
  /env\(safe-area-inset-bottom/.test(last(decls(ds.root, '.modal-fullscreen', 'padding-bottom')) || ''))

console.log('§2 no bare vh wins, and on the phone layout the form panel shrinks and scrolls')
const leaks = vhWinners(ds.root)
ok(`every vh size has a dvh line after it (bare: ${leaks.join('; ') || 'none'})`, leaks.length === 0)
ok('phone layout: the form panel\'s cap is 50dvh after a 50vh fallback', dvhAfterVh(decls(ds.root, '.sign-panel', 'max-height', PHONE), 50))
ok('phone layout: the PDF\'s floor is 40dvh after a 40vh fallback', dvhAfterVh(decls(ds.root, '.pdf-panel', 'min-height', PHONE), 40))
eq('phone layout: the form panel may shrink when the PDF and the form ask for more than the screen', last(decls(ds.root, '.sign-panel', 'flex-shrink', PHONE)), '1')
eq('phone layout: the form panel may shrink below its content (min-height: 0)', last(decls(ds.root, '.sign-panel', 'min-height', PHONE)), '0')
ok('phone layout: the form panel scrolls (the signed state\'s "Back to Documents" stays reachable)',
  ['auto', 'scroll'].includes(last(decls(ds.root, '.sign-panel', /^overflow(-y)?$/, PHONE))))
ok('the form scrolls inside its panel (.sign-content overflow-y: auto)',
  ['auto', 'scroll'].includes(last(decls(ds.root, '.sign-content', /^overflow(-y)?$/))))

console.log('§3 the header close (x) and the Sign button stay reachable')
const tpl = ds.descriptor.template.ast
const close = findEl(tpl, (el) => el.tag === 'button' && hasClass(el, 'modal-close'))
ok('the header has a .modal-close button', !!close)
eq('the close button is type="button"', attr(close, 'type'), 'button')
eq('the close button\'s aria-label is "Close"', attr(close, 'aria-label'), 'Close')
eq('the close button emits close', onClick(close), "$emit('close')")
ok('the close button is at least 44 px wide', px(last(decls(ds.root, '.modal-close', 'width'))) >= 44)
ok('the close button is at least 44 px tall', px(last(decls(ds.root, '.modal-close', 'height'))) >= 44)
const header = findEl(tpl, (el) => hasClass(el, 'modal-header'))
ok('the close button sits in the header', !!header && !!findEl(header, (el) => el === close))
eq('the header never shrinks (flex-shrink: 0)', last(decls(ds.root, '.modal-header', 'flex-shrink')), '0')
const content = findEl(tpl, (el) => hasClass(el, 'sign-content'))
ok('the Sign button sits in the form\'s scroller (.sign-content)', !!content && !!findEl(content, (el) => el.tag === 'button' && hasClass(el, 'sign-btn')))

// ══ §4 the maintenance notice ════════════════════════════════════════════════
console.log('§4 the maintenance notice is capped at the visible height')
const mm = load(MAINTENANCE_MODAL_VUE)
ok('the notice\'s max-height is 90dvh after a 90vh fallback', dvhAfterVh(decls(mm.root, '.maintenance-dialog', 'max-height'), 90))
ok('the notice scrolls inside its cap', ['auto', 'scroll'].includes(last(decls(mm.root, '.maintenance-dialog', /^overflow(-y)?$/))))
const mmLeaks = vhWinners(mm.root)
ok(`no bare vh wins in the maintenance notice (bare: ${mmLeaks.join('; ') || 'none'})`, mmLeaks.length === 0)

// ══ §5 the upload page's document preview ════════════════════════════════════
console.log('§5 the upload preview fits the visible height and its close clears the insets')
const du = load(DOCUMENT_UPLOAD_VUE)
ok('the preview image\'s max-height is 92dvh after a 92vh fallback', dvhAfterVh(decls(du.root, '.dup-preview-img', 'max-height'), 92))
ok('the preview PDF frame\'s height is 92dvh after a 92vh fallback', dvhAfterVh(decls(du.root, '.dup-preview-frame', 'height'), 92))
const duLeaks = vhWinners(du.root)
ok(`no bare vh wins in the upload page (bare: ${duLeaks.join('; ') || 'none'})`, duLeaks.length === 0)
eq('the preview close is position: fixed', last(decls(du.root, '.dup-preview-close', 'position')), 'fixed')
safeCorner(du.root, '.dup-preview-close', 'the preview close')

// ══ §6 the photo zoom viewer ═════════════════════════════════════════════════
console.log('§6 the photo zoom viewer fits the visible height and its close clears the insets')
const zi = load(ZOOMABLE_IMAGE_VUE)
ok('the zoomed photo\'s max-height is 90dvh after a 90vh fallback', dvhAfterVh(decls(zi.root, '.zoom-img', 'max-height'), 90))
const ziLeaks = vhWinners(zi.root)
ok(`no bare vh wins in the zoom viewer (bare: ${ziLeaks.join('; ') || 'none'})`, ziLeaks.length === 0)
eq('the zoom close is position: fixed', last(decls(zi.root, '.zoom-close', 'position')), 'fixed')
safeCorner(zi.root, '.zoom-close', 'the zoom close')

// ══ §7 the investor's signing screen ═════════════════════════════════════════
console.log('§7 the investor\'s signing screen is the overlay\'s size and pads the safe-area insets')
const is = load(INVESTOR_SIGN_VUE)
eq('the overlay is position: fixed', last(decls(is.root, '.modal-overlay', 'position')), 'fixed')
eq('the overlay is pinned to every edge of the window (inset: 0)', last(decls(is.root, '.modal-overlay', 'inset')), '0')
eq('the overlay stays above the /invest guided tour (z-index 10000)', last(decls(is.root, '.modal-overlay', 'z-index')), '10000')
const isH = decls(is.root, '.modal-fullscreen', 'height')
ok('the screen\'s height is never a bare 100vh', !bareVh(last(isH)))
ok('the screen fills the overlay (height: 100%), or is 100dvh after a 100vh fallback',
  last(isH) === '100%' || dvhAfterVh(isH, 100))
ok('the screen\'s width is never a bare 100vw (it fills the overlay)', !/(^|[^a-z])100vw\b/.test(last(decls(is.root, '.modal-fullscreen', 'width')) || ''))
eq('the screen counts its padding inside its height (box-sizing: border-box)', last(decls(is.root, '.modal-fullscreen', 'box-sizing')), 'border-box')
// #577's safe-area padding, as the shorthand or the longhands.
const isPad = (side) => last(decls(is.root, '.modal-fullscreen', `padding-${side}`)) || last(decls(is.root, '.modal-fullscreen', 'padding')) || ''
ok('the screen pads the top by the safe-area inset (the header clears the notch)', /env\(safe-area-inset-top/.test(isPad('top')))
ok('the screen pads the bottom by the safe-area inset (the Sign row clears the home bar)', /env\(safe-area-inset-bottom/.test(isPad('bottom')))
const isLeaks = vhWinners(is.root)
ok(`every vh size has a dvh line after it (bare: ${isLeaks.join('; ') || 'none'})`, isLeaks.length === 0)
ok('phone layout: the form panel\'s cap is 45dvh after a 45vh fallback', dvhAfterVh(decls(is.root, '.sign-panel', 'max-height', PHONE), 45))
ok('phone layout: the PDF\'s floor is 40dvh after a 40vh fallback', dvhAfterVh(decls(is.root, '.pdf-panel', 'min-height', PHONE), 40))
eq('phone layout: the form panel may shrink when the PDF and the form ask for more than the screen', last(decls(is.root, '.sign-panel', 'flex-shrink', PHONE)), '1')
eq('phone layout: the form panel may shrink below its content (min-height: 0)', last(decls(is.root, '.sign-panel', 'min-height', PHONE)), '0')
ok('phone layout: the form panel scrolls', ['auto', 'scroll'].includes(last(decls(is.root, '.sign-panel', /^overflow(-y)?$/, PHONE))))
const isContent = findEl(is.descriptor.template.ast, (el) => hasClass(el, 'sign-content'))
ok('the Sign button sits in the form\'s scroller (.sign-content)', !!isContent && !!findEl(isContent, (el) => el.tag === 'button' && hasClass(el, 'sign-btn')))

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
