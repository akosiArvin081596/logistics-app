#!/usr/bin/env node
// useApi()'s request headers — the merge a caller's own headers go through.
//
// WHY THIS EXISTS. Every write the app makes carries X-Requested-With, and the
// server refuses a state-changing request without it (the same-site CSRF check
// in requireAuth/requireRole). client/src/composables/useApi.js adds it, with
// Content-Type, to every call. It used to spread the caller's options AFTER the
// merged headers, so a caller that passed any `headers` replaced both defaults:
// its request went out without X-Requested-With, and the server would refuse
// every write that call made. The merged headers now come after the spread.
//
//   §1 a call with its own headers still carries X-Requested-With and Content-Type
//   §2 the caller's header wins on its own key, and only there
//   §3 a call without headers is what it always was
//   §4 the rest of the caller's options still reach fetch; the signal is useApi's
//
// Plain node: the module is imported as it ships, and globalThis.fetch is a stub
// that records the init it was given. No network, no DOM, no Vue runtime.
//
//   node scripts/test-useapi-headers.mjs      # exits 1 on any failure

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODULE = pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'composables', 'useApi.js')).href

let failed = 0
function ok(name, cond) {
  if (cond) console.log(`ok    ${name}`)
  else { console.log(`FAIL  ${name}`); failed++ }
}

const calls = []
globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  return { ok: true, status: 200, json: async () => ({ fine: true }) }
}
async function initOf(run) {
  calls.length = 0
  await run()
  return calls.length === 1 ? calls[0].init : null
}
const DEFAULTS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const { useApi } = await import(MODULE)
const api = useApi()

// ══ §1 — a caller's headers are added, never a replacement ═════════════════
console.log('\n§1  a call with its own headers keeps the defaults')
const TOKEN = 'QA-TEST-token'
{
  const init = await initOf(() => api.get('/api/qa-test', { headers: { 'X-Invite-Token': TOKEN } }))
  ok('GET with a custom header: X-Requested-With is sent', init?.headers?.['X-Requested-With'] === 'XMLHttpRequest')
  ok('GET with a custom header: Content-Type is sent', init?.headers?.['Content-Type'] === 'application/json')
  ok('GET with a custom header: the custom header is sent', init?.headers?.['X-Invite-Token'] === TOKEN)
}
const WRITES = [
  ['post', (h) => api.post('/api/qa-test', { a: 1 }, { headers: h })],
  ['put', (h) => api.put('/api/qa-test', { a: 1 }, { headers: h })],
  ['patch', (h) => api.patch('/api/qa-test', { a: 1 }, { headers: h })],
  ['del', (h) => api.del('/api/qa-test', { headers: h })],
]
for (const [verb, call] of WRITES) {
  const init = await initOf(() => call({ 'X-QA-Test': 'yes' }))
  ok(`${verb} with a custom header: X-Requested-With, Content-Type and the custom header are all sent`,
    same(init?.headers, { ...DEFAULTS, 'X-QA-Test': 'yes' }))
}

// ══ §2 — the caller wins on its own key ═══════════════════════════════════
console.log('\n§2  the caller\'s header wins on its own key')
{
  const init = await initOf(() => api.post('/api/qa-test', { a: 1 }, { headers: { 'Content-Type': 'text/plain' } }))
  ok('a caller\'s Content-Type replaces the default Content-Type', init?.headers?.['Content-Type'] === 'text/plain')
  ok('…and X-Requested-With is still sent', init?.headers?.['X-Requested-With'] === 'XMLHttpRequest')
  ok('…and nothing else is added', Object.keys(init?.headers || {}).length === 2)
}

// ══ §3 — no headers, no change ═════════════════════════════════════════════
console.log('\n§3  a call without headers is unchanged')
{
  const init = await initOf(() => api.get('/api/qa-test'))
  ok('GET: exactly the two default headers', same(init?.headers, DEFAULTS))
  ok('GET: no method or body is added', init && !('method' in init) && !('body' in init))
}
{
  const init = await initOf(() => api.post('/api/qa-test', { a: 1 }))
  ok('POST: exactly the two default headers', same(init?.headers, DEFAULTS))
  ok('POST: the method and the JSON body', init?.method === 'POST' && init?.body === '{"a":1}')
}
{
  const init = await initOf(() => api.del('/api/qa-test'))
  ok('DELETE: exactly the two default headers and the method', same(init?.headers, DEFAULTS) && init?.method === 'DELETE')
}
{
  const init = await initOf(() => api.get('/api/qa-test', { headers: undefined }))
  ok('headers: undefined is the same as no headers', same(init?.headers, DEFAULTS))
}

// ══ §4 — the other options and the signal ══════════════════════════════════
console.log('\n§4  the other options still reach fetch; the signal is useApi\'s')
{
  const caller = new AbortController()
  const init = await initOf(() => api.post('/api/qa-test', { a: 1 }, { headers: { 'X-QA-Test': 'yes' }, credentials: 'same-origin', signal: caller.signal, timeout: 5000 }))
  ok('other fetch options pass through (credentials)', init?.credentials === 'same-origin')
  ok('timeout is useApi\'s own option and never reaches fetch', init && !('timeout' in init))
  ok('the signal is useApi\'s composed one, not the caller\'s', init?.signal instanceof AbortSignal && init.signal !== caller.signal)
}
{
  const res = await api.get('/api/qa-test', { headers: { 'X-QA-Test': 'yes' } })
  ok('the parsed body is still returned', res?.fine === true)
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
