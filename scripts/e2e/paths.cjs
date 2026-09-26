// Where the browser harness finds things, and where it keeps its output.
//
// Every script in scripts/e2e resolves through this one file, so a rule changed
// here holds everywhere: the .cjs/.mjs scripts require it, and the .sh scripts
// call the command line at the bottom. Built-in modules only, because it has to
// load before any install exists.
//
//   REPO            the checkout this harness lives in (<REPO>/scripts/e2e)
//   mainCheckout()  the checkout that owns app.db, .env, the Google key and the
//                   installs a worktree lacks: the parent of git's common dir
//                   (MAIN_CHECKOUT overrides)
//   appDir()        the checkout whose node_modules (better-sqlite3, bcryptjs,
//                   puppeteer, dotenv) and scripts/ are used: APP_DIR, else REPO
//                   once it has installs (its own, or prep-worktree.sh's links),
//                   else the main checkout
//   workDir()       E2E_WORK_DIR, default $TMPDIR/logisx-e2e: the DB copies,
//                   creds, screenshots, results, logs and pid files. The copies
//                   are real, unsanitized production data, so the directory is
//                   created 0700, must stay private, and must lie OUTSIDE every
//                   checkout (and contain none: it is the harness's own).
//   workFile(p)     p made canonical, refused unless it is a real file (not a
//                   symlink) inside the work dir
//
// Command line (for the shell scripts):
//   node paths.cjs work-dir           print the work dir (created if missing)
//   node paths.cjs work-file <file>   print <file> canonical, or exit 2 with why
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { createRequire } = require('module')

const REPO = path.resolve(__dirname, '..', '..')

const realOrSelf = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep)

let mainCache = null
function mainCheckout() {
  if (mainCache) return mainCache
  if (process.env.MAIN_CHECKOUT) return (mainCache = path.resolve(process.env.MAIN_CHECKOUT))
  try {
    const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    mainCache = path.dirname(common)
  } catch {
    mainCache = REPO // not a git checkout: nothing else to find
  }
  return mainCache
}

const hasInstalls = (root) => fs.existsSync(path.join(root, 'node_modules', 'better-sqlite3', 'package.json'))
function appDir() {
  if (process.env.APP_DIR) return path.resolve(process.env.APP_DIR)
  if (hasInstalls(REPO)) return REPO
  const main = mainCheckout()
  return hasInstalls(main) ? main : REPO
}

// The version .nvmrc pins; better-sqlite3 is a native module built for its ABI.
function wantedNode() {
  try { return `v${fs.readFileSync(path.join(REPO, '.nvmrc'), 'utf8').trim().replace(/^v/, '')}` } catch { return null }
}
function warnNodeVersion(tag) {
  const want = wantedNode()
  if (want && process.version !== want) {
    console.warn(`${tag}: WARNING: running Node ${process.version}, but .nvmrc pins ${want}, the ABI better-sqlite3 is built for. ` +
      `Run under it: fnm exec --using=${want.slice(1)} <command>`)
  }
}

function appRequire(name) {
  const dir = appDir()
  try {
    return createRequire(path.join(dir, 'package.json'))(name)
  } catch (e) {
    if (/NODE_MODULE_VERSION/.test(e.message)) {
      throw new Error(`${name} is built for another Node ABI (running ${process.version}; .nvmrc pins ${wantedNode() || '?'}). ` +
        `Run under that version: fnm exec --using=${(wantedNode() || 'v22.23.2').slice(1)} <command>`)
    }
    if (e.code === 'MODULE_NOT_FOUND') {
      throw new Error(`cannot load ${name} from ${dir}: install the app in the main checkout (npm ci there), or set APP_DIR`)
    }
    throw e
  }
}

// The canonical form of a path that may not exist yet: the realpath of its
// deepest existing ancestor, plus the rest. Lets a path be judged BEFORE it is created.
function plannedPath(p) {
  let head = path.resolve(p)
  const rest = []
  while (!fs.existsSync(head)) {
    const up = path.dirname(head)
    if (up === head) break
    rest.unshift(path.basename(head))
    head = up
  }
  return path.join(realOrSelf(head), ...rest)
}

let workCache = null
function workDir() {
  if (workCache) return workCache
  const dir = path.resolve(process.env.E2E_WORK_DIR || path.join(os.tmpdir(), 'logisx-e2e'))
  const planned = plannedPath(dir)
  for (const checkout of new Set([REPO, mainCheckout()].map(realOrSelf))) {
    if (isInside(planned, checkout)) {
      throw new Error(`refusing: the work dir ${planned} is inside the checkout ${checkout}. ` +
        'It holds copies of real production data: set E2E_WORK_DIR to a directory outside every checkout.')
    }
    if (isInside(checkout, planned)) {
      throw new Error(`refusing: the work dir ${planned} contains the checkout ${checkout}. ` +
        'Point E2E_WORK_DIR at a directory of its own.')
    }
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const real = fs.realpathSync(dir)
  const st = fs.statSync(real)
  if (!st.isDirectory()) throw new Error(`refusing: the work dir ${real} is not a directory`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`refusing: the work dir ${real} belongs to another user`)
  }
  if (st.mode & 0o077) {
    throw new Error(`refusing: the work dir ${real} is open to other users (mode ${(st.mode & 0o777).toString(8)}). ` +
      'chmod 700 it, or point E2E_WORK_DIR at a private directory.')
  }
  return (workCache = real)
}

function workFile(p, { mustExist = true } = {}) {
  if (!p) throw new Error('no file given')
  const work = workDir()
  const abs = path.resolve(p)
  let st = null
  try { st = fs.lstatSync(abs) } catch { /* does not exist */ }
  if (st && st.isSymbolicLink()) throw new Error(`refusing: ${abs} is a symlink; the harness only uses real files inside the work dir`)
  if (!st && mustExist) throw new Error(`no such file: ${abs}`)
  let parent
  try { parent = fs.realpathSync(path.dirname(abs)) } catch { throw new Error(`no such directory: ${path.dirname(abs)}`) }
  const real = path.join(parent, path.basename(abs))
  if (!real.startsWith(work + path.sep)) {
    throw new Error(`refusing: ${abs} is not inside the work dir ${work} (E2E_WORK_DIR)`)
  }
  return real
}

// CHROME_PATH, else the Chrome for Testing the app's own puppeteer dependency
// downloaded (to ~/.cache/puppeteer).
async function chromePath() {
  if (process.env.CHROME_PATH) {
    if (!fs.existsSync(process.env.CHROME_PATH)) throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`)
    return process.env.CHROME_PATH
  }
  let puppeteer
  try { puppeteer = appRequire('puppeteer') } catch (e) {
    throw new Error(`no CHROME_PATH, and the app's puppeteer could not be loaded (${e.message})`)
  }
  const api = typeof puppeteer.executablePath === 'function' ? puppeteer : puppeteer.default
  const exe = await api.executablePath() // a Promise in puppeteer 25, a string in older ones
  if (!exe || !fs.existsSync(exe)) {
    throw new Error(`puppeteer's Chrome for Testing is not downloaded (${exe || 'no path'}): ` +
      `run \`npx puppeteer browsers install chrome\` in ${appDir()}, or set CHROME_PATH`)
  }
  return exe
}

module.exports = { REPO, mainCheckout, appDir, appRequire, wantedNode, warnNodeVersion, workDir, workFile, chromePath }

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2)
  try {
    if (cmd === 'work-dir') console.log(workDir())
    else if (cmd === 'work-file') console.log(workFile(arg))
    else {
      console.error('usage: node paths.cjs work-dir | work-file <file>')
      process.exit(2)
    }
  } catch (e) {
    console.error(`paths: ${e.message}`)
    process.exit(2)
  }
}
