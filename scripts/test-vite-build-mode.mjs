#!/usr/bin/env node
// `vite build` must resolve as a PRODUCTION build even when the repo-root .env
// says NODE_ENV=development — and the dev server must still take its port and
// proxy target from that same file.
//
// WHY THIS EXISTS. client/vite.config.js reads VITE_DEV_PORT / VITE_API_TARGET
// from the repo-root .env, which is Express's file. Vite's loadEnv() is not a
// pure read: a NODE_ENV in the parsed file is copied into
// process.env.VITE_USER_NODE_ENV, and resolveConfig() then switches NODE_ENV to
// development when that says so and the shell set none. A local .env may carry
// NODE_ENV=development (harmless to Express, which only checks for
// "production"), so on a developer machine `npm run build:client` — which
// `npm run ci` and refresh-local.sh both run — emitted a development bundle:
// plugin-vue derived scoped-CSS ids from the file path alone instead of path +
// source, chunks split and named differently, and Vue devtools hooks and
// absolute __file paths were compiled in. CI has no .env and production's
// NODE_ENV=production is refused with a warning, so neither ever showed it.
//
// HOW. The shipped config is copied byte-for-byte into a mkdtemp directory whose
// parent holds a temp .env (the config finds "the repo root" as its own parent
// directory) and resolved through Vite's own resolveConfig() — the call
// `vite build` and `vite` make before they bundle or listen. The OLD shape runs
// against the same fixture first and must reproduce the bug: a fixture that
// cannot show the defect proves nothing. Every case starts with NODE_ENV unset,
// as a bare `npm run build:client` does — run-unit-tests.js exports
// NODE_ENV=test, and a NODE_ENV the shell set is exactly what masks this bug.
//
// Hermetic: writes only inside its mkdtemp, never reads or writes the real .env,
// no network, nothing listens. Needs client/node_modules (vite and the config's
// plugins), which CI installs before the unit runners.
//
//   node scripts/test-vite-build-mode.mjs      # exits 1 on any failure

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const CLIENT = path.join(ROOT, 'client')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}

// The client's own vite — the copy `npm run build:client` runs. A bare
// `import 'vite'` from scripts/ resolves against the root package, which has none.
let resolveConfig
try {
  const vitePkgPath = createRequire(path.join(CLIENT, 'package.json')).resolve('vite/package.json')
  const esm = JSON.parse(fs.readFileSync(vitePkgPath, 'utf8')).exports['.'].import
  const entry = typeof esm === 'string' ? esm : esm.default
  ;({ resolveConfig } = await import(pathToFileURL(path.join(path.dirname(vitePkgPath), entry)).href))
} catch (err) {
  console.error(`FAIL  cannot load vite from client/node_modules (installed? the root \`npm install\` installs client/ too)\n        ${err.message}`)
  process.exit(1)
}

// A developer machine's repo-root .env, reduced to what matters here: Express's
// NODE_ENV plus the two per-worktree dev-server keys (values that are not the
// defaults, so "read from the file" and "fell back" cannot look alike).
const ROOT_ENV = 'NODE_ENV=development\nVITE_DEV_PORT=5999\nVITE_API_TARGET=http://127.0.0.1:3999\n'

// The config as it shipped before the fix, reduced to the line that mattered:
// loadEnv() on the repo root for EVERY command.
const OLD_CONFIG = `import { defineConfig, loadEnv } from 'vite'
import path from 'path'
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  return { server: { port: Number(env.VITE_DEV_PORT) || 5173 } }
})
`

//   <tmp>/.env                  ROOT_ENV — the config's "repo root" is its parent
//   <tmp>/node_modules          symlink to client/node_modules, for resolution only
//   <tmp>/client/package.json   the real client package's module type
//   <tmp>/client/node_modules/  real and empty: Vite writes its bundled-config temp
//                               file into the NEAREST node_modules, so without this
//                               it would land in the real client/node_modules
//   <tmp>/client/vite.config.js the config under test
function makeFixture(configSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logisx-vite-build-mode-'))
  const client = path.join(dir, 'client')
  fs.writeFileSync(path.join(dir, '.env'), ROOT_ENV)
  fs.symlinkSync(path.join(CLIENT, 'node_modules'), path.join(dir, 'node_modules'), 'junction')
  fs.mkdirSync(path.join(client, 'node_modules'), { recursive: true })
  const { type } = JSON.parse(read('client/package.json'))
  fs.writeFileSync(path.join(client, 'package.json'), JSON.stringify({ private: true, type }))
  fs.writeFileSync(path.join(client, 'vite.config.js'), configSource)
  return { dir, client }
}

function removeFixture({ dir }) {
  // Unlink FIRST, so the recursive delete below is never what decides whether to
  // descend into the real client/node_modules.
  const link = path.join(dir, 'node_modules')
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link)
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true })
}

// Process-global state Vite reads or writes while resolving: resolveConfig()
// WRITES NODE_ENV and loadEnv() writes VITE_USER_NODE_ENV, so each case clears
// them first (and restores them after) or one case's result leaks into the next.
// The two dev-server keys are here because loadEnv(…, '') lets the shell's
// values win over the file's.
const VOLATILE = ['NODE_ENV', 'VITE_USER_NODE_ENV', 'VITE_DEV_PORT', 'VITE_API_TARGET']

async function resolveIn(fx, command) {
  const saved = Object.fromEntries(VOLATILE.map((k) => [k, process.env[k]]))
  for (const k of VOLATILE) delete process.env[k]
  try {
    const inline = { root: fx.client, configFile: path.join(fx.client, 'vite.config.js'), logLevel: 'silent' }
    // The mode/NODE_ENV defaults each CLI command passes: `vite build` resolves
    // with production/production, `vite` (createServer) with the development ones.
    const config =
      command === 'build'
        ? await resolveConfig(inline, 'build', 'production', 'production')
        : await resolveConfig(inline, 'serve', 'development', 'development')
    return {
      config,
      nodeEnv: process.env.NODE_ENV,
      userNodeEnv: process.env.VITE_USER_NODE_ENV ?? '(unset)',
    }
  } finally {
    for (const k of VOLATILE) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

// ══ Control — the fixture reproduces the bug on this Vite ════════════════════
{
  const fx = makeFixture(OLD_CONFIG)
  try {
    const r = await resolveIn(fx, 'build')
    check(
      'control: (the OLD config, loadEnv on the repo root for every command, builds in DEVELOPMENT mode — the bug)',
      [r.config.isProduction, r.nodeEnv, r.userNodeEnv],
      [false, 'development', 'development'],
    )
  } finally {
    removeFixture(fx)
  }
}

// ══ The shipped config ═══════════════════════════════════════════════════════
{
  const fx = makeFixture(read('client/vite.config.js'))
  try {
    const b = await resolveIn(fx, 'build')
    check('build: resolves as production despite NODE_ENV=development in the repo-root .env', b.config.isProduction, true)
    check('build: process.env.NODE_ENV is still production once the config has loaded', b.nodeEnv, 'production')
    check("build: the repo-root .env's NODE_ENV never reaches Vite (VITE_USER_NODE_ENV stays unset)", b.userNodeEnv, '(unset)')

    const s = await resolveIn(fx, 'serve')
    check('serve: the dev server still takes VITE_DEV_PORT from the repo-root .env', s.config.server.port, 5999)
    check(
      'serve: /api, /socket.io and /uploads still proxy to VITE_API_TARGET from the repo-root .env',
      ['/api', '/socket.io', '/uploads'].map((p) => s.config.server.proxy?.[p]?.target),
      ['http://127.0.0.1:3999', 'http://127.0.0.1:3999', 'http://127.0.0.1:3999'],
    )
  } finally {
    removeFixture(fx)
  }
}

console.log(`\nvite-build-mode: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
