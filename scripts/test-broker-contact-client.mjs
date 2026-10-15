#!/usr/bin/env node
// The screens' side of the broker contact redaction (display only; the server
// redacts and refuses, lib/broker-contact.js):
//   - Active Loads editor: a cell the API served with contact details withheld
//     (the row's `_withheldCells`) is shown as served and read-only, never sent
//     as an edit, so a save never meets 409 CONTACT_CELL_READ_ONLY;
//   - rate-con review: a non-Super-Admin gets no Broker section (the extract
//     serves those fields empty) and a note saying the details are kept with
//     the load; a Super Admin's review is unchanged.
//
//   §1 client/src/lib/brokerContactView.js on a case table.
//   §2 the two components' source.
//
// No network, no DOM, no build.
//   node scripts/test-broker-contact-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', 'client', 'src')

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}

const lib = await import(pathToFileURL(path.join(SRC, 'lib', 'brokerContactView.js')).href)
const { contactReadOnlyCells, rateConSectionsFor, BROKER_KEPT_NOTE, CONTACT_CELL_HINT } = lib

// ---------------------------------------------------------------------------
console.log('§1 lib/brokerContactView.js')
// ---------------------------------------------------------------------------
const EDITABLE = ['Contract ID', 'Details', 'Trailer Number', 'Pickup Info', 'Email']
const job = { 'Contract ID': '', Details: 'call [contact withheld]', _withheldCells: ['Details', 'Contract ID', 'Not Editable'] }
check('read-only cells: the listed cells the editor shows, in the editor\'s order',
  contactReadOnlyCells(job, EDITABLE, false), ['Contract ID', 'Details'])
check('read-only cells: none for a Super Admin', contactReadOnlyCells(job, EDITABLE, true), [])
check('read-only cells: none for a row without the list, or no row',
  [contactReadOnlyCells({ Details: 'x' }, EDITABLE, false), contactReadOnlyCells(null, EDITABLE, false),
    contactReadOnlyCells({ _withheldCells: 'Details' }, EDITABLE, false)], [[], [], []])
const SECTIONS = [{ title: 'Load', fields: [] }, { title: 'Broker', fields: [{ key: 'Broker Name', important: true }] }, { title: 'Pickup', fields: [] }]
check('rate-con review: a non-Super-Admin gets no Broker section', rateConSectionsFor(SECTIONS, false).map(s => s.title), ['Load', 'Pickup'])
check('rate-con review: a Super Admin gets every section, the same array', rateConSectionsFor(SECTIONS, true) === SECTIONS, true)
check('the texts', [BROKER_KEPT_NOTE, CONTACT_CELL_HINT], [
  "The broker's contact details are kept with the load. Only a Super Admin can see them.",
  'Holds broker contact details. Only a Super Admin can change this.',
])

// ---------------------------------------------------------------------------
console.log('§2 the components')
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const fnBody = (src, head) => { const at = src.indexOf(head); const end = at < 0 ? -1 : src.indexOf('\n}\n', at); return end < 0 ? '' : src.slice(at, end) }
{
  const vue = read(path.join('components', 'dashboard', 'ActiveLoadsTab.vue'))
  check('ActiveLoadsTab: the read-only set comes from contactReadOnlyCells() over the open row, apart from withheld columns',
    vue.includes('contactReadOnlyCells(selectedJob.value, editableHeaders.value, auth.isSuperAdmin).filter(h => !withheldCols.value.has(h))'), true)
  check('ActiveLoadsTab: the field renders read-only with the served value and the hint',
    [/<template v-else-if="contactCells\.has\(col\)">[\s\S]*?readonly[\s\S]*?CONTACT_CELL_HINT[\s\S]*?<\/template>/.test(vue),
      (vue.match(/:value="selectedJob\[col\] \|\| ''"/g) || []).length], [true, 2])
  check('ActiveLoadsTab: openEdit() gives such a cell no form key, so it is sent as opened',
    fnBody(vue, 'function openEdit() {').includes('if (withheldCols.value.has(col) || contactCells.value.has(col)) { delete editForm[col]; continue }'), true)
  check('ActiveLoadsTab: submitEdit() does not patch it',
    fnBody(vue, 'async function submitEdit() {').includes('if (withheldCols.value.has(col) || contactCells.value.has(col)) continue'), true)
}
{
  const vue = read(path.join('components', 'shared', 'RateConReviewModal.vue'))
  check('RateConReviewModal: the shown sections, the missing count and the flags all read the role\'s sections',
    [vue.includes('const roleSections = computed(() => rateConSectionsFor(SECTIONS, auth.isSuperAdmin))'),
      vue.includes('const visibleSections = computed(() => roleSections.value.filter('),
      /const missingCount = computed\(\(\) => roleFields\.value\.filter\(/.test(vue),
      vue.includes('for (const f of roleFields.value) {'),
      /\bALL_FIELDS\b|\bIMPORTANT_KEYS\b/.test(vue)], [true, true, true, true, false])
  check('RateConReviewModal: a non-Super-Admin sees the note',
    vue.includes('<p v-if="!auth.isSuperAdmin" class="rc-note">{{ BROKER_KEPT_NOTE }}</p>'), true)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
