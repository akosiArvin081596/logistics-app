#!/usr/bin/env node
// On the driver app the toast clears the bottom tab bar; on every other page it
// keeps its place (2026-10-22).
//
// WHY THIS EXISTS. DriverView.vue lifted the toast above its tab bar with a scoped
// `:deep(.toast-container) { bottom: 80px }`. A scoped :deep rule compiles to
// `[data-v-<DriverView>] .toast-container`: it only reaches a .toast-container
// inside the driver page. The toast container is <AppToast /> in App.vue, a
// sibling of <main>, outside every page, so the rule never matched and the toast
// sat on the tab bar (Vant's 50 px bar, padded further by the home-bar inset).
//
//   §1 the shared toast rule (shared.css) is unchanged for every page: fixed,
//      centred, bottom max(2rem, the home-bar inset + 0.5rem)
//   §2 a global rule keyed to the driver page (.driver-app) lifts the toast to
//      80 px plus the home-bar inset, and outranks the shared rule
//   §3 the toast renders in App.vue outside the routed page, the driver page's
//      root is .driver-app and it renders the tab bar, and it holds no scoped
//      .toast-container rule (one that can never match)
//
// The files' own markup and styles, parsed with the client's compiler and
// postcss. No DOM, no browser.
//   node scripts/test-driver-toast-position.mjs
//   SHARED_CSS=/tmp/base/shared.css DRIVER_VIEW_VUE=/tmp/base/DriverView.vue node scripts/test-driver-toast-position.mjs   # a base copy: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, '..')
const CLIENT_DIR = path.join(ROOT, 'client')
const SRC = path.join(CLIENT_DIR, 'src')
const SHARED_CSS = process.env.SHARED_CSS || path.join(SRC, 'assets', 'shared.css')
const DRIVER_VIEW_VUE = process.env.DRIVER_VIEW_VUE || path.join(SRC, 'views', 'DriverView.vue')
const APP_VUE = process.env.APP_VUE || path.join(SRC, 'App.vue')

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

const norm = (v) => (v || '').replace(/\s+/g, ' ').trim()
const last = (list) => list[list.length - 1]

// Top-level rules whose selector list names `match` (a string or a RegExp on a
// single selector), with each selector that matched.
function rulesFor(root, match) {
  const out = []
  root.walkRules((rule) => {
    if (rule.parent.type !== 'root') return
    for (const s of rule.selectors.map(norm)) {
      if (match instanceof RegExp ? match.test(s) : s === match) out.push({ rule, selector: s })
    }
  })
  return out
}
function declsOf(entries, prop) {
  const out = []
  for (const { rule } of entries) rule.walkDecls(prop, (d) => out.push(norm(d.value)))
  return out
}
// [ids, classes and pseudo-classes, elements] for a selector, :has() counting as
// its argument (enough for the selectors this runner reads).
function specificity(sel) {
  const s = sel.replace(/:has\(([^)]*)\)/g, ' $1 ')
  const ids = (s.match(/#[\w-]+/g) || []).length
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length
  const elements = (s.replace(/[#.][\w-]+|\[[^\]]+\]|:[\w-]+/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length
  return [ids, classes, elements]
}
const outranks = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false }

function findEl(node, pred) {
  if (node.type === 1 && pred(node)) return node
  for (const c of node.children || []) {
    const hit = findEl(c, pred)
    if (hit) return hit
  }
  return null
}
const attr = (el, name) => el?.props.find((p) => p.type === 6 && p.name === name)?.value?.content
const hasClass = (el, cls) => (attr(el, 'class') || '').split(/\s+/).includes(cls)

const shared = postcss.parse(fs.readFileSync(SHARED_CSS, 'utf8'))

// ══ §1 every page ════════════════════════════════════════════════════════════
console.log('§1 the shared toast rule is unchanged for every page')
const base = rulesFor(shared, '.toast-container')
ok('shared.css has a .toast-container rule', base.length > 0)
eq('the toast is position: fixed', last(declsOf(base, 'position')), 'fixed')
eq('the toast sits 2rem up, or above the home bar', last(declsOf(base, 'bottom')), 'max(2rem, env(safe-area-inset-bottom, 0px) + 0.5rem)')
eq('the toast is centred (left: 50%)', last(declsOf(base, 'left')), '50%')
eq('the toast is centred (translateX(-50%))', last(declsOf(base, 'transform')), 'translateX(-50%)')

// ══ §2 the driver app ════════════════════════════════════════════════════════
console.log('§2 on the driver app the toast clears the tab bar')
const driver = rulesFor(shared, /\.driver-app\b.*\.toast-container$/)
ok('a global rule keyed to the driver page (.driver-app) places .toast-container', driver.length > 0)
const driverBottom = last(declsOf(driver, 'bottom')) || ''
const lift = Number((driverBottom.match(/(\d+(?:\.\d+)?)px/) || [])[1] || 0)
ok(`the toast sits at least 80 px up, above Vant's 50 px tab bar (got "${driverBottom}")`, lift >= 80)
ok('the lift adds the home-bar inset, as the tab bar pads by it', /env\(safe-area-inset-bottom/.test(driverBottom))
ok('the driver rule outranks the shared rule',
  driver.length > 0 && base.length > 0 && driver.every(({ selector }) => base.every((b) => outranks(specificity(selector), specificity(b.selector)))))
ok('the driver rule sets only the toast\'s bottom (left, centring and layering stay shared)',
  driver.every(({ rule }) => rule.nodes.filter((n) => n.type === 'decl').every((d) => d.prop === 'bottom')))

// ══ §3 where the toast and the tab bar render ════════════════════════════════
console.log('§3 the toast renders outside the page, so a scoped page rule cannot reach it')
const app = parse(fs.readFileSync(APP_VUE, 'utf8'), { filename: APP_VUE }).descriptor
const appTpl = app.template.ast
const routerView = findEl(appTpl, (el) => el.tag === 'router-view' || el.tag === 'RouterView')
const toast = findEl(appTpl, (el) => el.tag === 'AppToast')
ok('App.vue renders <AppToast />', !!toast)
ok('the toast is not inside the routed page', !!routerView && !!toast && !findEl(routerView, (el) => el === toast))

const dv = parse(fs.readFileSync(DRIVER_VIEW_VUE, 'utf8'), { filename: DRIVER_VIEW_VUE }).descriptor
const dvRoot = dv.template.ast.children.find((c) => c.type === 1)
ok('the driver page\'s root element is .driver-app', !!dvRoot && hasClass(dvRoot, 'driver-app'))
ok('the driver page renders the bottom tab bar', !!findEl(dv.template.ast, (el) => el.tag === 'BottomNav'))
const scopedToast = dv.styles.filter((s) => s.scoped && /toast-container/.test(s.content))
eq('the driver page\'s scoped styles hold no .toast-container rule (one could never match)', scopedToast.length, 0)

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
