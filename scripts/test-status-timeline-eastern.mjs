#!/usr/bin/env node
// The load-detail Status Timeline shows US Eastern only (B14). Every phase used
// to add a second, smaller line in the VIEWER's own zone ("(PH Time: Oct 12,
// 12:17 PM)" in Manila, "(Your time: ...)" elsewhere), 12 hours off the Eastern
// time above it. The product rule is one clock for everyone: APP_TIMEZONE
// (America/New_York, EDT/EST), so that line is gone.
//
//   §1 StatusTimeline.vue, rendered on machines set to New York, Chicago, Manila
//      and UTC: the same text in all four, each phase in Eastern with its label,
//      and no "PH Time" / "Your time" line anywhere
//   §2 the viewer-zone helper is gone from client/src/utils/datetime.js and
//      nothing in client/src reads the browser's own zone for a time on screen
//      (resolvedOptions().timeZone)
//
// StatusTimeline renders on the dispatch load detail (Active and Completed), the
// driver app's load detail and the public tracker, so all four lose the line.
//
// No DOM, no server. Vue comes from this checkout's client/node_modules; the
// files under test come from LOGISX_ROOT (default: this checkout).
//   node scripts/test-status-timeline-eastern.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-status-timeline-eastern.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const SELF = fileURLToPath(import.meta.url)
const HERE = path.join(path.dirname(SELF), '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const SRC = path.join(ROOT, 'client', 'src')
const CHILD_FLAG = 'STATUS_TIMELINE_EASTERN_CHILD'

// Made-up phases (no real load): true instants, as GET
// /api/loads/:loadId/status-history serves them.
//   2026-10-10T17:30:00Z = Oct 10, 1:30 PM EDT
//   2026-10-12T04:17:10Z = Oct 12, 12:17 AM EDT (Oct 11, 11:17 PM CDT; Oct 12, 12:17 PM in Manila)
const PHASES = [
  { status: 'In Transit', startedAt: '2026-10-10T17:30:00Z', endedAt: '2026-10-12T04:17:10Z', durationMs: 125830000, source: 'manual' },
  { status: 'Delivered', startedAt: '2026-10-12T04:17:10Z', endedAt: null, durationMs: null, inProgress: true, source: 'manual' },
]

// ══ The child: compile and render the component in this machine's zone ═══════
async function renderHere() {
  const clientRequire = createRequire(path.join(HERE, 'client', 'package.json'))
  const Vue = clientRequire('vue')
  const { parse, compileScript } = clientRequire('vue/compiler-sfc')
  const { renderToString } = clientRequire('vue/server-renderer')
  const file = path.join(SRC, 'components', 'shared', 'StatusTimeline.vue')
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: 'StatusTimeline.vue' })
  let body = compileScript(descriptor, { id: 'StatusTimeline.vue', inlineTemplate: true }).content
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error('StatusTimeline.vue: an import/export this harness cannot map')
  const datetime = await import(pathToFileURL(path.join(SRC, 'utils', 'datetime.js')).href)
  const deps = {
    vue: Vue,
    '@/composables/useApi': { useApi: () => ({ get: async () => { throw new Error('the timeline must not fetch when phases are passed') } }) },
    '@/utils/datetime': datetime,
  }
  for (const spec of specs) if (!(spec in deps)) throw new Error(`StatusTimeline.vue imports ${spec}, which this harness does not provide`)
  const Comp = new Function('__deps', body)(deps)
  const html = await renderToString(Vue.createSSRApp(Comp, { phases: PHASES }))
  let out = ''
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) { out += html.slice(i); break }
    out += html.slice(i, lt)
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? html.length : end + 3
    } else {
      const end = html.indexOf('>', lt + 1)
      out += ' '
      i = end === -1 ? html.length : end + 1
    }
  }
  return {
    offset: new Date('2026-10-12T04:17:10Z').getTimezoneOffset(),
    text: out.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(),
  }
}

if (process.env[CHILD_FLAG]) {
  try {
    process.stdout.write(JSON.stringify(await renderHere()))
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String((err && err.message) || err) }))
  }
  process.exit(0)
}

// ══ The parent ═══════════════════════════════════════════════════════════════
let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}

// §1 one clock in every machine zone. Offsets on 2026-10-12 (getTimezoneOffset's
// sign), so a child that silently ran in another zone is caught.
const ZONES = [['America/New_York', 240], ['America/Chicago', 300], ['Asia/Manila', -480], ['UTC', 0]]
const EXPECTED = 'In Transit 1d 10h Started Oct 10, 2026, 1:30 PM EDT · Ended Oct 12, 2026, 12:17 AM EDT Delivered In progress Started Oct 12, 2026, 12:17 AM EDT'
const texts = []
for (const [tz, offset] of ZONES) {
  let r
  try {
    r = JSON.parse(execFileSync(process.execPath, [SELF], { env: { ...process.env, TZ: tz, [CHILD_FLAG]: '1' }, encoding: 'utf8' }))
  } catch (err) {
    r = { error: String((err && (err.stderr || err.message)) || err) }
  }
  if (r.error) {
    ok(`§1 TZ=${tz}: the timeline renders (${r.error})`, false)
    continue
  }
  ok(`§1 TZ=${tz}: the child ran in that zone`, r.offset === offset)
  ok(`§1 TZ=${tz}: no viewer-zone line ("${r.text}")`, !/PH Time|Your time/.test(r.text))
  ok(`§1 TZ=${tz}: each phase in Eastern with its label, nothing else ("${r.text}")`, r.text === EXPECTED)
  texts.push(r.text)
}
ok('§1 the same timeline text on all four machines', texts.length === ZONES.length && texts.every((t) => t === texts[0]))

// §2 the helper and its styling are gone; nothing on screen reads the browser zone.
// Code only: comments (/* */, whole-line //, <!-- -->) may say why it went.
const code = (src) => src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const DATETIME = code(fs.readFileSync(path.join(SRC, 'utils', 'datetime.js'), 'utf8'))
ok('§2 datetime.js no longer has viewerZoneNote()', !/\bviewerZoneNote\b/.test(DATETIME))
const TIMELINE = code(fs.readFileSync(path.join(SRC, 'components', 'shared', 'StatusTimeline.vue'), 'utf8'))
ok('§2 StatusTimeline.vue has no viewer-zone line, note or style', !/viewerZoneNote|startedNote|endedNote|st-viewer-tz|PH Time|Your time/.test(TIMELINE))
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.(vue|js|mjs|ts)$/.test(e.name) ? [p] : []
  })
}
const readsViewerZone = walk(SRC).filter((p) => /resolvedOptions\(\)\.timeZone/.test(fs.readFileSync(p, 'utf8'))).map((p) => path.relative(ROOT, p))
ok(`§2 nothing in client/src reads the browser's own zone (${readsViewerZone.join(', ') || 'none'})`, readsViewerZone.length === 0)

console.log(`\nstatus-timeline-eastern: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
