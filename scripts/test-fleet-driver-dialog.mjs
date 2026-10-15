#!/usr/bin/env node
// The dashboard's Fleet & Drivers driver dialog (R11), where a Dispatcher
// records a driver's time off (the Drivers page is Super Admin only). The
// replica browser check (2026-10-16) found it had no height limit: at 375 px
// "Add time off" sat below the screen, and at 1280 px the close button sat above
// it. And after a time-off change it kept showing what it opened with, with
// "Available" beside "Off until".
//
//   §1 the dialog has the Edit Load dialog's layout (ActiveLoadsTab.vue): a
//      height limit, the header fixed at the top (so the close button stays in
//      view) and the body scrolling inside it
//   §2 the dialog reads its driver from the current fleet list by name, so the
//      dashboard's refresh after a time-off change shows the new figures
//   §3 it shows one status: "Off until Oct 20" for a driver off today (the
//      Fleet pill's own text, fleetPillText()), else his load status
//
// No DOM: the component's own source, checked the way the other client runners
// check theirs. Files under test come from LOGISX_ROOT (default: this checkout).
//   node scripts/test-fleet-driver-dialog.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; return }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

const fleet = read('client/src/components/dashboard/FleetTab.vue')
const loads = read('client/src/components/dashboard/ActiveLoadsTab.vue')
const template = fleet.slice(0, fleet.indexOf('</template>\n\n<script'))
const script = fleet.slice(fleet.indexOf('<script setup>'))

// The Edit Load dialog's content classes, as the reference layout.
// (Attribute values hold "=>", so a tag is read to its closing `">`.)
const editLoad = /<Dialog :open="showEdit"[\s\S]*?">\s*<DialogContent class="([^"]+)"/.exec(loads)
ok('§1 the Edit Load dialog (ActiveLoadsTab.vue) is found as the reference', !!editLoad)
const ref = editLoad ? editLoad[1].split(/\s+/) : []
const layout = ref.filter((c) => /^max-h-|^flex$|^flex-col$|^overflow-hidden$/.test(c))
ok('§1 ...and carries a height limit, a column layout and hidden overflow', layout.length === 4, layout.join(' '))

const driverDialog = /<Dialog :open="[^"]*"[\s\S]*?">\s*<DialogContent class="([^"]+)"[^>]*>([\s\S]*?)<\/DialogContent>/.exec(template)
ok('§1 the driver dialog is found', !!driverDialog)
const classes = driverDialog ? driverDialog[1].split(/\s+/) : []
for (const c of layout) ok(`§1 the driver dialog has the Edit Load layout class ${c}`, classes.includes(c), classes.join(' '))
const inner = driverDialog ? driverDialog[2] : ''
const header = /<DialogHeader[\s\S]*?<\/DialogHeader>\s*<div style="([^"]*)"/.exec(inner)
ok('§1 the header comes first, outside the scrolling body (the close button stays in view)', !!header)
const bodyStyle = header ? header[1] : ''
ok('§1 the body scrolls inside the dialog (overflow-y:auto; flex:1)', /overflow-y:\s*auto/.test(bodyStyle) && /flex:\s*1\b/.test(bodyStyle), bodyStyle)
ok('§1 the time-off section sits inside the scrolling body', /<DriverAvailabilityPanel/.test(inner))

ok('§2 the dialog keeps the driver\'s name, not a copy of his fleet entry',
  /const selectedName = ref\(/.test(script) && /function openDetail\(f\) \{ selectedName\.value = f\.Driver/.test(script))
ok('§2 ...and reads the entry from the current fleet list, so a refresh shows the new figures',
  /const selected = computed\(\(\) => [^\n]*props\.fleet[^\n]*\.find\(\(f\) => f\.Driver === selectedName\.value\)/.test(script))
ok('§2 ...opening and closing follow the name', /:open="!!selectedName"/.test(template) && /selectedName = null/.test(template))
ok('§2 a time-off change still asks the dashboard to refresh', /@changed="emit\('availability-changed'\)"/.test(template))

const statusRow = /Availability<\/span>([\s\S]*?)<\/div>/.exec(inner)
const statusHtml = statusRow ? statusRow[1] : ''
ok('§3 the status row shows the Fleet pill\'s text (Off until …, else the load status)', /fleetPillText\(selected\)/.test(statusHtml), statusHtml.trim().slice(0, 160))
ok('§3 ...as one status pill, never "Available" beside "Off until"', !/selected\?\.Status \}\}/.test(statusHtml) && (statusHtml.match(/<span[^>]*fleet-status/g) || []).length === 1)

// §3, the text itself, from the shipped helper.
const text = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'availabilityText.js')).href)
ok('§3 a driver off today reads "Off until Oct 20"', text.fleetPillText({ Status: 'Available', offUntil: '2026-10-20' }) === 'Off until Oct 20')
ok('§3 a driver not off reads his load status', text.fleetPillText({ Status: 'Queued', offUntil: null }) === 'Queued')

console.log(`\ntest-fleet-driver-dialog: ${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
