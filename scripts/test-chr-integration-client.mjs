#!/usr/bin/env node
// client/src/lib/chrIntegration.js: the C.H. Robinson page's and badge's words
// and rules (R5 PR 2, plan 4.18), and their parity with the server's codes.
//
//   §1 PARITY: every status, hold reason, skip reason, verify value, event, mode
//      and Live reason the server can send has words, and nothing else does; the
//      Live reasons read as the server's own sentences
//   §2 showChrBadge(): Super Admin only (never a Dispatcher, Driver or Investor)
//   §3 the badge asks for a load's summary only when GET /status says the feature
//      is on: shouldAskLoadSummary(), and the component's order, read from its file
//   §4 the chips, the badge text, a row's status line, the stop, the ladder, the
//      send log's query and the page link
//   §5 the words are plain sentences: no markup, no address
//   §6 the module is plain: no imports, no network, no Vue
//   §7 the route is Super Admin only, the sidebar item is in the Super Admin list
//      only, and both load-detail tabs mount the badge for a Super Admin only
//   §8 nothing on the page or the badge reads a driver field
//   §9 the page and the badge compile (the client's own vue/compiler-sfc)
//
// No network, no DOM, no database.
//   node scripts/test-chr-integration-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const S = require(path.join(ROOT, 'lib', 'chr-store.js'))
const E = require(path.join(ROOT, 'lib', 'chr-events.js'))
const R = require(path.join(ROOT, 'lib', 'chr-routes.js'))
const CLIENT = path.join(ROOT, 'client', 'src', 'lib', 'chrIntegration.js')
const C = await import(pathToFileURL(CLIENT).href)
const read = (...p) => fs.readFileSync(path.join(ROOT, 'client', 'src', ...p), 'utf8')

let pass = 0
const failures = []
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  failures.push(`${label}\n      expected ${e}\n      actual   ${a}`)
}
function ok(cond, label) { eq(Boolean(cond), true, label) }
function section(t) { console.log(`\n${t}`) }
const sorted = (o) => Object.keys(o).sort()

// ------------------------------------------------------------------ §1
section('§1  parity with the server')
eq(sorted(C.CHR_STATUS_WORDS), [...S.STATUSES].sort(), '§1 every row status the store allows has words, and nothing else')
eq(sorted(C.CHR_HOLD_WORDS), [...S.HOLD_REASONS].sort(), '§1 every hold reason')
eq(sorted(C.CHR_SKIP_WORDS), [...S.SKIP_REASONS].sort(), '§1 every skip reason')
eq(sorted(C.CHR_VERIFY_WORDS), [...S.VERIFY_VALUES].sort(), '§1 every verify value')
eq(sorted(C.CHR_EVENT_WORDS), [...E.MILESTONE_EVENTS, 'location'].sort(), '§1 every event (the milestones and location)')
eq(sorted(C.CHR_MODE_LABELS), [...S.MODES].sort(), '§1 every mode')
eq(C.CHR_LIVE_REASONS, { ...R.LIVE_REFUSED }, '§1 the Live reasons are the server\'s own sentences')
eq(C.CHR_PILOT_REASONS, { ...R.PILOT_REFUSED }, '§1 the pilot\'s reasons are the server\'s own sentences')
const Tr = require(path.join(ROOT, 'lib', 'chr-transport.js'))
eq(sorted(C.CHR_RESULT_SENTENCES), [...Tr.RESULT_CODES].sort(), '§1 every result code the transport can give has its fixed sentence, and nothing else')
eq(sorted(C.CHR_PAUSE_WORDS), [...S.PAUSE_REASONS].sort(), '§1 every pause reason')
eq([C.lastPositionText('2026-11-02T15:30:00Z', (v) => `<${v}>`), C.lastPositionText('')], ['Last position sent or recorded: <2026-11-02T15:30:00Z>', 'No fresh RouteMate position'],
  '§1 a load\'s last position line (PR 4-shell)')
eq([C.kindChip({ enabled: true, locationEnabled: true, location: 'dry_run' }, 'location').label, C.kindChip({ enabled: true, locationEnabled: false, location: 'dry_run' }, 'location').label],
  ['Dry run', 'Off: server setting'], '§1 the Location chip: its mode, or "Off: server setting" while the server says no')
eq([C.kindChip({ enabled: true, milestones: 'pilot' }, 'milestones').label, C.kindChip({ enabled: true, milestones: 'live', paused: { reason: 'AUTH_FAILED' } }, 'milestones').label,
  C.kindChip({ enabled: true, milestones: 'pilot', paused: { reason: 'CHR_UNAVAILABLE' } }, 'milestones').label, C.kindChip({ enabled: true, milestones: 'dry_run', paused: { reason: 'AUTH_FAILED' } }, 'milestones').label],
['Pilot: one load Live', 'Paused: credentials', 'Paused: CHR unavailable', 'Dry run'], '§1 the chips for the pilot and the two pauses (a pause shows only where something could be sent)')
eq([{ mode: 'live', status: 'failed' }, { mode: 'live', status: 'gave_up' }, { mode: 'live', status: 'outcome_unknown' }, { mode: 'dry_run', status: 'failed' }, { mode: 'live', status: 'sent' }].map(C.isRetryable),
  [true, true, true, false, false], '§1 Retry is offered for failed, given-up and unknown live updates only (the server\'s rule)')

// ------------------------------------------------------------------ §2
section('§2  who sees the badge')
eq(['Super Admin', 'Dispatcher', 'Driver', 'Investor', '', undefined, 'super admin'].map(C.showChrBadge), [true, false, false, false, false, false, false],
  '§2 showChrBadge(): a Super Admin only')

// ------------------------------------------------------------------ §3
section('§3  a load summary only while the feature is on')
eq([{ enabled: true }, { enabled: false }, { enabled: 'true' }, null, undefined, {}].map(C.shouldAskLoadSummary), [true, false, false, false, false, false],
  '§3 shouldAskLoadSummary(): only an answer saying enabled: true')
const BADGE = read('components', 'integrations', 'ChrSendBadge.vue')
const askAt = BADGE.indexOf('shouldAskLoadSummary(status)')
const fetchAt = BADGE.indexOf('api.get(loadSummaryUrl(')
ok(askAt > 0 && fetchAt > askAt, '§3 the badge reads /status, then asks for the summary only after shouldAskLoadSummary()')
eq((BADGE.match(/api\.get\(/g) || []).length, 2, '§3 ...and makes no other request (one status read, one summary)')
ok(/let statusOnce = null/.test(BADGE) && /if \(!statusOnce\)/.test(BADGE), '§3 the status read is shared for the session (one per session, not one per load)')
ok(/if \(!visible\.value \|\| !id\) return/.test(BADGE), '§3 nothing is read for a role that sees no badge')

// ------------------------------------------------------------------ §4
section('§4  chips, badge, rows, ladder, links')
eq(C.kindChip({ enabled: false }, 'milestones'), { label: 'Off: server setting', tone: 'muted' }, '§4 the switch off: "Off: server setting"')
eq(C.kindChip({ enabled: true, locationEnabled: false, location: 'off' }, 'location'), { label: 'Off: server setting', tone: 'muted' }, '§4 location with its server setting off: "Off: server setting"')
eq(['off', 'dry_run', 'live'].map((m) => C.kindChip({ enabled: true, milestones: m }, 'milestones').label), ['Off', 'Dry run', 'Live'], '§4 milestones: Off, Dry run, Live')
eq([
  C.badgeFor({ counts: { sent: 3, dry_run: 2 } }),
  C.badgeFor({ counts: { sent: 3, failed: 1 } }),
  C.badgeFor({ counts: { dry_run: 4 } }),
  C.badgeFor({ counts: { held: 1, sent: 2 } }),
  C.badgeFor({ counts: { dry_run: 1 }, load: { hold: true } }),
  C.badgeFor({ counts: { pending: 1 } }),
  C.badgeFor({ counts: { skipped_not_chr: 2 } }),
  C.badgeFor(null),
], [
  { text: 'CHR: 3 sent', tone: 'live' }, { text: 'CHR: 1 failed', tone: 'bad' }, { text: 'CHR: dry run (4)', tone: 'dry' },
  { text: 'CHR: held', tone: 'warn' }, { text: 'CHR: held', tone: 'warn' }, { text: 'CHR: waiting', tone: 'muted' }, null, null,
], '§4 the badge: failed first, then held, then sent, then dry run; nothing for skipped-only or no summary')
const fmt = (v) => `<${v}>`
eq(C.rowStatusText({ status: 'dry_run', sentAt: '2026-11-02T15:14:00Z' }, fmt), 'Dry run: would have been sent at <2026-11-02T15:14:00Z>', '§4 a dry-run row: "would have been sent at"')
eq(C.rowStatusText({ status: 'held', holdReason: 'tap_away_from_stop' }), `Held: ${C.CHR_HOLD_WORDS.tap_away_from_stop}`, '§4 a held row: why, and what to post in Navisphere')
eq(C.rowStatusText({ status: 'skipped_not_chr', skipReason: 'other_broker' }), 'Skipped: not a CHR load now. The load belongs to another broker now.', '§4 a skipped row: why')
eq(C.rowStatusText({ status: 'sent', sentAt: 'x', reverted: true }, fmt), 'Sent at <x>. Sent, then the status went back: check it in Navisphere.', '§4 a sent row whose status went back')
eq(C.rowStatusText({ status: 'failed', resultCode: 'REJECTED' }), 'Failed: C.H. Robinson refused this update. Post it in Navisphere.', '§4 a result code as its fixed sentence, never CHR\'s text')
eq([C.stopText({ event: 'departed_pickup', stop: { kind: 'pickup', index: 1 } }), C.stopText({ event: 'delivered', stop: { kind: 'delivery', index: 1 } }),
  C.stopText({ event: 'arrived_delivery', stop: { kind: 'delivery', index: 2 } })], ['Pickup 1', 'Final delivery', 'Delivery 2'], '§4 the stop')
const ladder = C.ladderOf([
  { id: 5, event: 'departed_pickup', status: 'dry_run' },
  { id: 3, event: 'departed_pickup', status: 'skipped_backwards' },
  { id: 4, event: 'arrived_delivery', status: 'skipped_backwards' },
  { id: 2, event: 'arrived_pickup', status: 'skipped_off' },
])
eq(ladder.map((s) => [s.event, s.row && s.row.id]), [['arrived_pickup', 2], ['departed_pickup', 5], ['arrived_delivery', null], ['delivered', null]],
  '§4 the ladder: each milestone once, in trip order, its newest row, a voided row left out')
eq([C.eventsQuery({}), C.eventsQuery({ status: 'held' }), C.eventsQuery({ loadId: ' #123456789 ', before: 41 })],
  ['/api/integrations/chr/events', '/api/integrations/chr/events?status=held', '/api/integrations/chr/events?loadId=%23123456789&before=41'], '§4 the send log\'s query')
eq([C.pageLinkForLoad('#123456789'), C.loadSummaryUrl('#123456789')], ['/admin/integrations/chr?load=%23123456789', '/api/integrations/chr/loads/%23123456789'], '§4 the page link and the summary URL, encoded')

// ------------------------------------------------------------------ §5
section('§5  plain sentences')
const sentences = [C.CHR_HOLD_WORDS, C.CHR_SKIP_WORDS, C.CHR_RESULT_SENTENCES, C.CHR_LIVE_REASONS, C.CHR_PILOT_REASONS].flatMap((o) => Object.values(o))
eq(sentences.filter((s) => /[<>]|@|https?:/.test(s)), [], '§5 no markup, no address, no link')
eq(sentences.filter((s) => !/[.]$/.test(s)), [], '§5 each ends with a full stop')

// ------------------------------------------------------------------ §6
section('§6  a plain module')
const MOD = fs.readFileSync(CLIENT, 'utf8')
ok(!/^\s*import\b/m.test(MOD) && !/\bfetch\(|XMLHttpRequest|from 'vue'/.test(MOD), '§6 no imports, no network, no Vue')

// ------------------------------------------------------------------ §7
section('§7  the route, the sidebar and the tabs')
const ROUTER = read('router', 'index.js')
ok(/path: '\/admin\/integrations\/chr',\s*name: 'chr-integration',\s*component: \(\) => import\('\.\.\/views\/ChrIntegrationView\.vue'\),\s*meta: \{ roles: \['Super Admin'\] \},/.test(ROUTER),
  '§7 /admin/integrations/chr: Super Admin only')
const SIDEBAR = read('components', 'layout', 'AppSidebar.vue')
const listOf = (role) => {
  const at = SIDEBAR.indexOf(`${role.includes(' ') ? `'${role}'` : role}: [`)
  return at < 0 ? '' : SIDEBAR.slice(at, SIDEBAR.indexOf('],', at))
}
ok(/\{ divider: true, label: 'Integrations' \},\s*\{ to: '\/admin\/integrations\/chr', icon: '[^']+', label: 'C\.H\. Robinson' \},/.test(listOf('Super Admin')),
  '§7 the Super Admin list: an "Integrations" divider, then "C.H. Robinson"')
for (const role of ['Dispatcher', 'Driver', 'Investor']) ok(!listOf(role).includes('integrations/chr'), `§7 the ${role} list has no CHR item`)
for (const tab of ['ActiveLoadsTab.vue', 'CompletedLoadsTab.vue']) {
  const src = read('components', 'dashboard', tab)
  eq((src.match(/<ChrSendBadge v-if="auth\.isSuperAdmin" :load-id="loadIdValue" :open="!!selectedJob" \/>/g) || []).length, 1, `§7 ${tab}: the badge, for a Super Admin only`)
  eq((src.match(/<ChrSendBadge\b/g) || []).length, 1, `§7 ${tab}: ...and nowhere else`)
}
ok(/showChrBadge\(auth\.user\?\.role\)/.test(BADGE), '§7 the badge checks the role itself too')

// ------------------------------------------------------------------ §8
section('§8  no driver field')
const VIEW = read('views', 'ChrIntegrationView.vue')
for (const [name, src] of [['ChrIntegrationView.vue', VIEW], ['ChrSendBadge.vue', BADGE], ['chrIntegration.js', MOD]]) {
  eq(src.match(/\.driver\w*\b|driverName|\.phone\w*\b/gi) || [], [], `§8 ${name} reads no driver name or phone field`)
}

// ------------------------------------------------------------------ §9
section('§9  the two components compile')
const clientRequire = createRequire(path.join(ROOT, 'client', 'package.json'))
const sfc = clientRequire('vue/compiler-sfc')
for (const [name, src] of [['ChrIntegrationView.vue', VIEW], ['ChrSendBadge.vue', BADGE]]) {
  let problem = ''
  try {
    const { descriptor, errors } = sfc.parse(src, { filename: name })
    if (errors.length) problem = errors.map((e) => e.message).join('; ')
    else sfc.compileScript(descriptor, { id: `chr-${name}`, inlineTemplate: true })
  } catch (err) {
    problem = err.message
  }
  eq(problem, '', `§9 ${name}: its script and template compile`)
}

console.log(`\n${'='.repeat(64)}`)
if (failures.length) {
  console.log(`FAILURES (${failures.length}):`)
  failures.forEach((f) => console.log(`  ✗ ${f}`))
  console.log(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`✓ ${pass} assertions passed`)
