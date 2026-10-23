#!/usr/bin/env node
// The verdict on one e2e.mjs run, for CI (ci-run.sh runs it after each part).
//
//   node scripts/e2e/ci-gate.cjs <results-<tag>.md> [--allow-skip ID,ID,...] [--label NAME]
//
// e2e.mjs exits 0 when its run completed, FAIL rows included (a BEFORE baseline is
// expected to fail; README "Verdicts and exit code"), so CI reads its results table
// instead. The part passes only when:
//   - the file holds e2e.mjs's results table, stamped finished;
//   - no row is FAIL (an aborted block is recorded as a FAIL row too);
//   - every SKIP row is on the part's --allow-skip list: steps that can't run on the
//     made-up seed by design, named in ci-run.sh (a step id, matched without case);
//   - at least one row is PASS;
//   - every verdict is one e2e.mjs writes (PASS, PASS (vacuous), FAIL, SKIP, INFO).
// It prints the totals and each FAIL or unexpected SKIP row (made-up data only), and
// appends the same to $GITHUB_STEP_SUMMARY when that is set. An allowed step that
// no longer SKIPs is noted, so its entry can come off the list.
// Exit: 0 passed, 1 failed, 2 usage or an unreadable file.
'use strict'
const fs = require('fs')
const path = require('path')

const KINDS = new Set(['PASS', 'FAIL', 'SKIP', 'INFO'])

// One table line's cells. e2e.mjs's cell() writes a backslash as \\ and a pipe as \|.
function splitRow(line) {
  const cells = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) { cur += line[i + 1]; i++; continue }
    if (ch === '|') { cells.push(cur); cur = ''; continue }
    cur += ch
  }
  cells.push(cur)
  return cells.slice(1, -1).map((c) => c.trim())
}

function parseResults(text) {
  const lines = String(text).split('\n')
  const head = lines.findIndex((l) => /^\| Step \| What \| Expected/.test(l))
  if (head < 0 || !/^\|---/.test(lines[head + 1] || '')) throw new Error('no e2e.mjs results table in the file')
  const rows = []
  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith('|')) break
    const c = splitRow(line)
    if (c.length !== 6) throw new Error(`a results row with ${c.length} cells, not 6: ${line.slice(0, 80)}`)
    rows.push({ step: c[0], title: c[1], observed: c[3], verdict: c[4] })
  }
  return { rows, finished: lines.some((l) => /^- Started: .* · finished \S+/.test(l)) }
}

// PASS, FAIL, SKIP or INFO; PASS (vacuous) counts as PASS; anything else is null.
const kindOf = (verdict) => {
  if (verdict === 'PASS (vacuous)') return 'PASS'
  return KINDS.has(verdict) ? verdict : null
}

function judge(parsed, allowSkip = []) {
  const allow = new Set(allowSkip.map((s) => s.trim().toUpperCase()).filter(Boolean))
  const counts = {}
  const fails = []
  const unexpectedSkips = []
  const unknown = []
  for (const r of parsed.rows) {
    const k = kindOf(r.verdict)
    if (!k) { unknown.push(r); continue }
    counts[k] = (counts[k] || 0) + 1
    if (k === 'FAIL') fails.push(r)
    if (k === 'SKIP' && !allow.has(r.step.toUpperCase())) unexpectedSkips.push(r)
  }
  const problems = []
  if (!parsed.finished) problems.push('the run never finished (its results are not stamped finished)')
  if (!counts.PASS) problems.push('no step passed')
  if (unknown.length) problems.push(`verdicts e2e.mjs does not write: ${unknown.map((r) => `${r.step} "${r.verdict}"`).join(', ')}`)
  if (fails.length) problems.push(`${fails.length} FAIL row(s)`)
  if (unexpectedSkips.length) problems.push(`${unexpectedSkips.length} SKIP row(s) not on this part's allow list`)
  const skipped = new Set(parsed.rows.filter((r) => kindOf(r.verdict) === 'SKIP').map((r) => r.step.toUpperCase()))
  const notes = [...allow].filter((id) => !skipped.has(id)).map((id) => `${id} is on the allow list but did not SKIP (take it off the list once it passes in CI)`)
  return { ok: problems.length === 0, counts, fails, unexpectedSkips, problems, notes }
}

const short = (s, n = 300) => {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
// A backslash first, then a pipe, as e2e.mjs's cell() does, so neither can end a cell early.
const mdCell = (s) => short(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')

function report(label, v) {
  const totals = Object.entries(v.counts).map(([k, n]) => `${k} ${n}`).join(' · ') || 'no rows'
  const head = `e2e part ${label}: ${v.ok ? 'passed' : 'FAILED'} (${totals})`
  const text = [head]
  for (const p of v.problems) text.push(`  - ${p}`)
  for (const r of v.fails) text.push(`  FAIL ${r.step} ${short(r.title, 120)}: ${short(r.observed)}`)
  for (const r of v.unexpectedSkips) text.push(`  SKIP ${r.step} ${short(r.title, 120)}: ${short(r.observed)}`)
  for (const n of v.notes) text.push(`  note: ${n}`)
  const md = [`### ${head}`, '']
  if (v.fails.length || v.unexpectedSkips.length) {
    md.push('| Step | What | Observed | Verdict |', '|---|---|---|---|')
    for (const r of [...v.fails, ...v.unexpectedSkips]) md.push(`| ${mdCell(r.step)} | ${mdCell(r.title)} | ${mdCell(r.observed)} | ${mdCell(r.verdict)} |`)
    md.push('')
  }
  for (const p of v.problems) md.push(`- ${p}`)
  for (const n of v.notes) md.push(`- note: ${n}`)
  md.push('')
  return { text: text.join('\n'), md: md.join('\n') }
}

// <file> [--allow-skip ID,ID,...] [--label NAME]; null when the arguments are not that.
function parseArgs(argv) {
  const o = { file: null, allowSkip: [], label: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--allow-skip') o.allowSkip = String(argv[++i] ?? '').split(',').filter((s) => s.trim() && s.trim() !== '-')
    else if (a === '--label') o.label = String(argv[++i] ?? '')
    else if (a.startsWith('--') || o.file) return null
    else o.file = a
  }
  return o.file ? o : null
}

function main(argv) {
  const args = parseArgs(argv)
  if (!args) {
    console.error('usage: node scripts/e2e/ci-gate.cjs <results-<tag>.md> [--allow-skip ID,ID,...] [--label NAME]')
    return 2
  }
  const { file } = args
  const label = args.label || path.basename(file, '.md')
  let parsed
  try {
    parsed = parseResults(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`ci-gate: ${label}: ${e.code === 'ENOENT' ? `no results file at ${file} (the run never wrote one)` : e.message}`)
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### e2e part ${label}: FAILED (no readable results)\n\n`)
    return 2
  }
  const v = judge(parsed, args.allowSkip)
  const out = report(label, v)
  console.log(out.text)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out.md}\n`)
  return v.ok ? 0 : 1
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { splitRow, parseResults, judge, report, parseArgs, main }
