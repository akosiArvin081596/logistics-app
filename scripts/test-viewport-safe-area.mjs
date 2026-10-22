#!/usr/bin/env node
// Notched iPhones: the page runs edge to edge (viewport-fit=cover) and the app
// shell and every fixed bar pad themselves clear of the notch, the rounded
// corners and the home bar (2026-10-22).
//
// WHY THIS EXISTS. client/index.html's viewport meta had no viewport-fit=cover,
// so on an iPhone every env(safe-area-inset-*) in the app was 0: the padding the
// driver welcome card (#569) and the document-signing screen (#571) rely on did
// nothing. Turning it on lets the page run under the notch in landscape and
// under the home bar, so the admin shell (sidebar, content column, hamburger),
// the driver shell (header, banners, drive mode) and the fixed bars, toasts and
// full-screen viewers had to pad themselves for the insets too.
//
//   §1 the viewport meta has viewport-fit=cover
//   §2 every env(safe-area-inset-*) in client/src and index.html has a length
//      fallback (", 0px"): a bare or unitless one makes max()/calc() invalid
//      wherever the browser has no inset to give
//   §3 each shell part and fixed bar listed below uses the insets on the sides
//      it touches, through max(<its old value>, env(...)) where it had one
//   §4 with every inset 0 (desktop, Android, any non-notched screen) each of
//      those values works out to exactly its old value: nothing moves there
//   §5 the investor guide's bottom sheet counts the home-bar inset once (its
//      footer), not three times (sheet offset, sheet padding, footer)
//   §5b the phone Notifications footer and the Messages input bar end at the
//      content column's padded bottom, so they add no bottom inset of their own
//   §6 shadcn dialogs are narrowed by the side insets (w-full at 0)
//
// The files' own styles, parsed with the client's compiler and postcss. No DOM,
// no browser.
//   node scripts/test-viewport-safe-area.mjs
//   CLIENT_ROOT=/tmp/base/client node scripts/test-viewport-safe-area.mjs   # a copy of main's client/: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const CLIENT_DIR = path.join(ROOT, 'client')
const CLIENT_ROOT = process.env.CLIENT_ROOT || CLIENT_DIR
const SRC = path.join(CLIENT_ROOT, 'src')

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

const norm = (v) => String(v).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim()

// Every <style> block of a .vue file (or a whole .css file) as postcss roots.
const rootCache = new Map()
function roots(rel) {
  if (rootCache.has(rel)) return rootCache.get(rel)
  const file = path.join(SRC, rel)
  const text = fs.readFileSync(file, 'utf8')
  let out
  if (rel.endsWith('.css')) {
    out = [postcss.parse(text)]
  } else {
    const { descriptor } = parse(text, { filename: file })
    out = descriptor.styles.map((s) => postcss.parse(s.content))
  }
  rootCache.set(rel, out)
  return out
}

// The last value `prop` gets on `selector` (exact selector in the list), at the
// top level (media null) or inside a @media whose params match `media`.
// Shorthand-only lookups: a padding-left after a padding counts as well.
function value(rel, selector, prop, media = null) {
  let found
  for (const root of roots(rel)) {
    root.walkRules((rule) => {
      if (!rule.selectors.map((s) => s.trim()).includes(selector)) return
      const parent = rule.parent
      const inMedia = parent && parent.type === 'atrule' && parent.name === 'media'
      if (media === null ? inMedia : !(inMedia && media.test(parent.params))) return
      rule.walkDecls(prop, (d) => { found = norm(d.value) })
    })
  }
  return found
}

// A value with every safe-area inset set to 0, simplified the way a browser
// would compute it for the forms this codebase uses.
function atZero(v) {
  let s = norm(v).replace(/env\(safe-area-inset-[a-z]+(?:,\s*[^()]*)?\)/g, '0px')
  const num = (x) => x.match(/^(-?[\d.]+)(rem|px|%)$/)
  for (let i = 0; i < 20; i++) {
    const before = s
    s = s.replace(/ [+-] 0px/g, '').replace(/0px \+ /g, '')
    s = s.replace(/max\(([^(),]+), 0px\)/g, '$1').replace(/max\(0px, ([^(),]+)\)/g, '$1')
    s = s.replace(/max\(([^(),]+), ([^(),]+)\)/g, (m, a, b) => {
      const [x, y] = [num(a.trim()), num(b.trim())]
      if (!x || !y || x[2] !== y[2]) return m
      return Number(x[1]) >= Number(y[1]) ? a.trim() : b.trim()
    })
    s = s.replace(/calc\(([^()]+) \+ ([^()]+)\)/g, (m, a, b) => {
      const [x, y] = [num(a.trim()), num(b.trim())]
      if (!x || !y || x[2] !== y[2]) return m
      return `${Number((Number(x[1]) + Number(y[1])).toFixed(4))}${x[2]}`
    })
    s = s.replace(/calc\(([^()]+|var\([^()]*\))\)/g, '$1')
    if (s === before) break
  }
  return s === '0px' ? '0' : s
}

// padding shorthand -> its four sides, 0px written 0.
function sides(v) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of norm(v)) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ' ' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) parts.push(cur)
  const p = parts.map((x) => (x === '0px' ? '0' : x))
  const [t, r = t, b = t, l = r] = p
  return [t, r, b, l].join(' ')
}

// ---------------------------------------------------------------- §1
console.log('§1 viewport meta')
{
  const html = fs.readFileSync(path.join(CLIENT_ROOT, 'index.html'), 'utf8')
  const meta = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/)
  ok('index.html has a viewport meta', !!meta)
  const content = meta ? meta[1].split(',').map((x) => x.trim()) : []
  ok('viewport meta has viewport-fit=cover', content.includes('viewport-fit=cover'))
  ok('viewport meta keeps width=device-width', content.includes('width=device-width'))
}

// ---------------------------------------------------------------- §2
console.log('§2 every env(safe-area-inset-*) has a length fallback')
{
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(vue|css|js|ts)$/.test(e.name)) files.push(p)
    }
  }
  walk(SRC)
  files.push(path.join(CLIENT_ROOT, 'index.html'))
  let uses = 0
  const bad = []
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/env\(\s*safe-area-inset-[a-z]+\s*(,[^)]*)?\)/g)) {
      uses++
      const fallback = (m[1] || '').replace(/^,/, '').trim()
      if (!/^-?[\d.]+(px|rem|em)$/.test(fallback)) bad.push(`${path.relative(CLIENT_ROOT, f)}: ${m[0]}`)
    }
  }
  ok('the client uses safe-area insets', uses > 0)
  for (const b of bad) console.log(`        ${b}`)
  eq('env(safe-area-inset-*) without a length fallback', bad.length, 0)
}

// ---------------------------------------------------------------- §3, §4
// [file, selector, property, media, the value on main, insets it must use, max() wrappers it must use]
const MOBILE = /max-width:\s*767px/
const W768 = /max-width:\s*768px/
const W1024 = /max-width:\s*1024px/
const ITEMS = [
  // Admin and investor shell
  ['assets/shared.css', '.sidebar', 'width', null, 'var(--sidebar-w)', ['left'], []],
  ['assets/shared.css', '.sidebar', 'padding', null, undefined, ['top', 'bottom', 'left'], []],
  ['assets/shared.css', '.main', 'margin-left', null, 'var(--sidebar-w)', ['left'], []],
  ['assets/shared.css', '.main', 'width', null, 'calc(100% - var(--sidebar-w))', ['left'], []],
  ['assets/shared.css', '.main', 'padding', null, '1.5rem 2rem', ['top', 'right', 'bottom'], ['max(2rem, env(safe-area-inset-right', 'max(1.5rem, env(safe-area-inset-bottom']],
  ['assets/shared.css', '.main', 'padding', MOBILE, '3rem 0.75rem 1.25rem', ['top', 'right', 'bottom', 'left'],
    ['max(0.75rem, env(safe-area-inset-right', 'max(1.25rem, env(safe-area-inset-bottom', 'max(0.75rem, env(safe-area-inset-left']],
  ['assets/shared.css', '.toast-container', 'bottom', null, '2rem', ['bottom'], ['max(2rem, env(safe-area-inset-bottom']],
  ['components/layout/AppSidebar.vue', '.sidebar.collapsed', 'width', null, '64px', ['left'], []],
  ['App.vue', '.main.no-sidebar', 'padding', null, '0', ['right', 'left'], []],
  ['App.vue', '.mobile-menu-btn', 'top', null, '0.6rem', ['top'], ['max(0.6rem, env(safe-area-inset-top']],
  ['App.vue', '.mobile-menu-btn', 'left', null, '0.6rem', ['left'], ['max(0.6rem, env(safe-area-inset-left']],
  // Driver shell and bars
  ['components/driver/DriverHeader.vue', '.app-header', 'padding', null, '0.75rem 1rem', ['right', 'left'], ['max(1rem, env(safe-area-inset-right', 'max(1rem, env(safe-area-inset-left']],
  ['views/DriverView.vue', '.distance-warning', 'padding', null, '0.75rem 1rem', ['right', 'left'], ['max(1rem, env(safe-area-inset-right', 'max(1rem, env(safe-area-inset-left']],
  ['components/driver/LoadAssignedBanner.vue', '.load-assigned-banner', 'padding', null, '1rem 1rem 0', ['top', 'right', 'left'], ['max(1rem, env(safe-area-inset-right', 'max(1rem, env(safe-area-inset-left']],
  ['components/driver/DriveModeOverlay.vue', '.drive-banner', 'left', null, '0.75rem', ['left'], ['max(0.75rem, env(safe-area-inset-left']],
  ['components/driver/DriveModeOverlay.vue', '.drive-banner', 'right', null, '0.75rem', ['right'], ['max(0.75rem, env(safe-area-inset-right']],
  ['components/driver/DriveModeOverlay.vue', '.drive-status-strip', 'left', null, '0.75rem', ['left'], ['max(0.75rem, env(safe-area-inset-left']],
  ['components/driver/DriveModeOverlay.vue', '.drive-status-strip', 'right', null, '4.5rem', ['right'], ['max(0.85rem, env(safe-area-inset-right']],
  ['components/driver/DriveModeOverlay.vue', '.drive-controls', 'right', null, '0.85rem', ['right'], ['max(0.85rem, env(safe-area-inset-right']],
  ['components/driver/DriveModeOverlay.vue', '.drive-speed', 'left', null, '0.85rem', ['left'], ['max(0.85rem, env(safe-area-inset-left']],
  ['components/driver/DriveModeOverlay.vue', '.drive-footer', 'padding', null, '0.85rem 1rem 1rem', ['right', 'bottom', 'left'], ['max(1rem, env(safe-area-inset-right', 'max(1rem, env(safe-area-inset-left']],
  // Full-screen viewers and their controls
  ['components/shared/ZoomableImage.vue', '.zoom-controls', 'bottom', null, '1.25rem', ['bottom'], ['max(1.25rem, env(safe-area-inset-bottom']],
  ['components/shared/ZoomableImage.vue', '.zoom-prev', 'left', null, '0.75rem', ['left'], ['max(0.75rem, env(safe-area-inset-left']],
  ['components/shared/ZoomableImage.vue', '.zoom-next', 'right', null, '0.75rem', ['right'], ['max(0.75rem, env(safe-area-inset-right']],
  ['components/shared/ZoomableImage.vue', '.zoom-position', 'top', null, '1.6rem', ['top'], ['max(1.6rem, env(safe-area-inset-top']],
  ['components/shared/RateConViewer.vue', '.rcv-expanded', 'padding', null, undefined, ['top', 'right', 'bottom', 'left'], []],
  ['components/invest/InvestorSignModal.vue', '.modal-fullscreen', 'padding', null, undefined, ['top', 'right', 'bottom', 'left'], []],
  ['views/InvestorApplyView.vue', '.photo-overlay-close', 'top', null, '1rem', ['top'], ['max(1rem, env(safe-area-inset-top']],
  ['views/InvestorApplyView.vue', '.photo-overlay-close', 'right', null, '1.5rem', ['right'], ['max(1.5rem, env(safe-area-inset-right']],
  // Sticky / fixed bars
  ['wizard/components/WizardPanel.vue', '.wizard-panel', 'right', null, '24px', ['right'], ['max(24px, env(safe-area-inset-right']],
  ['wizard/components/WizardResumeBanner.vue', '.wizard-resume', 'right', null, '24px', ['right'], ['max(24px, env(safe-area-inset-right']],
  ['wizard/components/WizardFaqDrawer.vue', '.faq-drawer', 'right', W1024, '24px', ['right'], ['max(24px, env(safe-area-inset-right']],
  ['wizard/components/WizardFaqDrawer.vue', '.faq-drawer', 'padding-bottom', W768, undefined, ['bottom'], []],
  ['wizard/components/WizardFab.vue', '.wizard-fab', 'left', null, '314px', ['left'], []],
  ['wizard/components/WizardFab.vue', '.wizard-fab', 'bottom', null, '24px', ['bottom'], ['max(24px, env(safe-area-inset-bottom']],
]

const PADDING = /^padding$/
console.log('§3 shell parts and fixed bars use the insets')
console.log('§4 with every inset 0 they keep their old values')
for (const [rel, sel, prop, media, base, insets, wrappers] of ITEMS) {
  const where = `${rel} ${media ? `@media(${media.source}) ` : ''}${sel} ${prop}`
  const v = value(rel, sel, prop, media)
  ok(`${where} is set`, v !== undefined)
  if (v === undefined) continue
  for (const side of insets) ok(`${where} uses env(safe-area-inset-${side}, 0px)`, v.includes(`env(safe-area-inset-${side}, 0px)`))
  for (const w of wrappers) ok(`${where} uses ${w}, ...)`, v.includes(w))
  const zero = PADDING.test(prop) ? sides(atZero(v)) : atZero(v)
  const old = base === undefined ? '0' : base
  eq(`${where} at zero insets`, zero, PADDING.test(prop) ? sides(old) : old)
}

// ---------------------------------------------------------------- §5
console.log('§5 the guide sheet counts the home-bar inset once')
{
  const rel = 'wizard/components/WizardPanel.vue'
  const bottom = value(rel, '.wizard-panel', 'bottom', W768)
  const sheetPad = value(rel, '.wizard-panel', 'padding-bottom', W768)
  const tabPad = value(rel, '.minimized-tab', 'padding', W768)
  const footerPad = value(rel, '.panel-footer', 'padding', W768)
  const hasInset = (v) => !!v && v.includes('safe-area-inset-bottom')
  ok('phone sheet sits on the screen edge (bottom has no inset)', !hasInset(bottom))
  eq('phone sheet bottom at zero insets', bottom && atZero(bottom), 'var(--wizard-kb-offset, 0px)')
  ok('phone sheet has no inset padding of its own', !hasInset(sheetPad))
  ok('minimized strip has no inset padding (it would squeeze the 56px pill)', !hasInset(tabPad))
  ok('footer clears the home bar', hasInset(footerPad))
}

// ---------------------------------------------------------------- §5b
console.log('§5b bars inside the padded content column add no bottom inset of their own')
{
  const footer = value('views/NotificationsView.vue', '.notif-mobile-footer', 'padding', MOBILE)
  ok('phone Notifications footer has no safe-area-inset-bottom', !!footer && !footer.includes('safe-area-inset-bottom'))
  eq('phone Notifications footer padding (as on main)', footer, '0.75rem')
  const inputPads = []
  for (const root of roots('views/MessagesView.vue')) {
    root.walkRules((rule) => {
      if (!rule.selector.includes('.msg-chat-input')) return
      rule.walkDecls(/^padding/, (d) => inputPads.push(norm(d.value)))
    })
  }
  ok('Messages input bar has a padding rule', inputPads.length > 0)
  ok('Messages input bar carries no bottom inset (the page padding clears the home bar)',
    inputPads.every((v) => !v.includes('safe-area-inset-bottom')))
}

// ---------------------------------------------------------------- §6
console.log('§6 shadcn dialogs are narrowed by the side insets')
{
  const text = fs.readFileSync(path.join(SRC, 'components', 'ui', 'dialog', 'DialogContent.vue'), 'utf8')
  const base = text.match(/'fixed left-1\/2 top-1\/2[^']*'/)
  ok('DialogContent base classes found', !!base)
  const cls = base ? base[0].slice(1, -1).split(/\s+/) : []
  ok('DialogContent width leaves the side insets',
    cls.includes('w-[calc(100%-env(safe-area-inset-left,0px)-env(safe-area-inset-right,0px))]'))
  ok('DialogContent has no plain w-full left over', !cls.includes('w-full'))
}

if (failures.length) {
  console.log(`\n${failures.length} failed, ${pass} passed`)
  process.exit(1)
}
console.log(`\nAll ${pass} checks passed`)
