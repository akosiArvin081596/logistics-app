#!/usr/bin/env bash
# The browser E2E harness on made-up data, as CI runs it (.github/workflows/e2e.yml).
#
#   E2E_WORK_DIR=<a new, empty directory outside every checkout> bash scripts/e2e/ci-run.sh
#
# The same command runs on a Mac (under `fnm exec --using=<.nvmrc's version>`), so a CI
# run can be rehearsed exactly. It never uses real data, a settings file, a key or the
# Keychain:
#   - the database is setup-db.cjs's made-up seed (SOURCE_DB set is refused), the loads
#     are the made-up Sheets fixture, and every server is boot-server.sh's (made-up
#     settings on its command line, the Google stand-in, every outbound effect off);
#   - the logins' passwords are generated for this run by setup-db.cjs and kept by
#     ci-keychain.cjs, a stand-in for macOS's `security` (service logisx-e2e-ci), in a
#     0600 file inside the 0700 work dir. Nothing is printed but ids and verdicts.
#
# Each part boots a fresh server on the run's database (the sign-in limiter allows 20
# per server process), runs e2e.mjs on its sections, stops that server by its recorded
# PID (stop-server.sh), and hands the results table to ci-gate.cjs. e2e.mjs exits 0 with
# FAIL rows, so the gate is what fails a part: a FAIL row, a SKIP that is not on the
# part's allow list (below), no PASS at all, or a run that never finished. Every part
# runs even after one failed; the script exits 1 when any part failed, 2 when it refused
# to start.
#
# Env:
#   E2E_WORK_DIR   required: the run's work dir, new or empty (paths.cjs creates it 0700
#                  and refuses one inside a checkout). CI: under runner.temp. Locally:
#                  e.g. a new folder under ~/LogisX-replica/screens/<task>/.
#   E2E_CI_PARTS   a comma-separated list of the parts below (default: all of them)
#   E2E_PORT       the servers' port (default 3181; boot-server.sh refuses 3000, 5173 and
#                  any port in use)
#   E2E_BROWSER=playwright  drive playwright-core's own Chromium (CI); unset: the app's
#                  puppeteer Chrome for Testing, or CHROME_PATH (paths.cjs chromePath())
#   NODE_BIN       the node binary (default: node on PATH; .nvmrc's version)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd -P)"
NODE_BIN="${NODE_BIN:-node}"
export NODE_BIN
refuse() { echo "ci-run: refusing: $*" >&2; exit 2; }

# The parts, in the order they run (the README's "Local run" order), and what no part runs:
# the sections and steps the made-up seed cannot hold what they need for, and E2, whose
# page no longer has the table it reads (README "CI").
ALL_PARTS="trucks-dispatcher signout maintenance moneypath terms-t0 terms investorfixes lease instructions"
NOT_RUN="names, and the money path's F1 and RC1: SKIPPED in every run (they read sheet formulas and formats with the Google API, which the stand-in does not model) · eldlink: the seed has no ELD device and no finalized month · invoice: needs a delivered load's POD files on disk and a Bison load, which the seed and fixture do not hold · report: the seed has no Investor who owns a truck · the money path's E2: it waits for the Financials month table that the current Fleet P&L replaced, so it fails on any data"

# ---------------------------------------------------------------- refusals
[ -z "${SOURCE_DB:-}" ] || refuse "SOURCE_DB is set; this run builds the made-up database and never copies one"
[ -n "${E2E_WORK_DIR:-}" ] || refuse "set E2E_WORK_DIR to a new directory outside every checkout (CI: under runner.temp)"
if [ -e "$E2E_WORK_DIR" ] && [ -n "$(ls -A "$E2E_WORK_DIR")" ]; then
  refuse "E2E_WORK_DIR $E2E_WORK_DIR is not empty; this run starts from an empty one"
fi
for tool in lsof curl; do
  command -v "$tool" >/dev/null 2>&1 || refuse "$tool is missing; boot-server.sh and stop-server.sh need it"
done
PICKED="${E2E_CI_PARTS:-all}"
if [ "$PICKED" != all ]; then
  for p in ${PICKED//,/ }; do
    case " $ALL_PARTS " in *" $p "*) ;; *) refuse "E2E_CI_PARTS names \"$p\"; the parts are: $ALL_PARTS";; esac
  done
fi
picked() { [ "$PICKED" = all ] || case ",$PICKED," in *",$1,"*) return 0;; *) return 1;; esac; }

# Whatever the caller exported, each part sets these itself.
unset LOGINS_FILE ONLY STEPS DB_PATH BASE_URL PHASE OUT_TAG HEADED \
  E2E_MAINTENANCE_NOTICE E2E_FAKE_GMAIL E2E_DRIVER_INSTRUCTIONS_DENY INVESTOR_LEASE_PAYOUTS_ENABLED

PORT="${E2E_PORT:-3181}"
WORK="$("$NODE_BIN" "$HERE/paths.cjs" work-dir)"
export E2E_WORK_DIR="$WORK"
export E2E_KEYCHAIN_SERVICE=logisx-e2e-ci
export E2E_SECURITY_BIN="$HERE/ci-keychain.cjs"
export E2E_CI_KEYCHAIN_FILE="$WORK/ci-keychain.json"
DB="$WORK/ci.db"
LOG="$WORK/server-$PORT.log"
PIDFILE="$WORK/server-$PORT.pid"

echo "ci-run: node $("$NODE_BIN" -v), work dir $WORK, port $PORT, browser ${CHROME_PATH:+CHROME_PATH}${CHROME_PATH:-${E2E_BROWSER:-puppeteer Chrome for Testing}}"
echo "ci-run: parts: ${PICKED}"
echo "ci-run: not run on the made-up seed: $NOT_RUN"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '## Browser e2e on made-up data\n\nNot run (the made-up seed cannot hold what they need): %s\n\n' "$NOT_RUN" >>"$GITHUB_STEP_SUMMARY"
fi

stop_server() {
  if [ -f "$PIDFILE" ]; then bash "$HERE/stop-server.sh" "$PORT" || echo "ci-run: warning: stop-server.sh could not stop the server on $PORT" >&2; fi
}
trap stop_server EXIT

server_log_tail() {
  [ -f "$LOG" ] || return 0
  echo "---- last 40 lines of the server log (made-up data) ----"
  tail -40 "$LOG"
  echo "----"
}

# ---------------------------------------------------------------- the made-up database
"$NODE_BIN" "$HERE/setup-db.cjs" "$DB"
"$NODE_BIN" "$HERE/verify-creds.cjs" "$DB"

# ---------------------------------------------------------------- the parts
PASSED=""
FAILED=""
# part <tag> <ONLY> <STEPS or ""> <allowed SKIPs or ""> [VAR=value ...]
# The VAR=value settings go to both the server's boot and the run.
part() {
  local tag="$1" only="$2" steps="$3" allow="$4"
  shift 4
  picked "$tag" || return 0
  local start=$SECONDS rc=0 gate=0 out="ci-$tag"
  echo
  echo "==== part $tag: ONLY=$only${steps:+ STEPS=$steps}${*:+ ($*)}"
  if ! env "$@" bash "$HERE/boot-server.sh" "$REPO" "$PORT" "$DB"; then
    echo "::error::e2e part $tag: the server did not boot"
    server_log_tail
    stop_server
    FAILED="$FAILED $tag"
    return 0
  fi
  env "$@" BASE_URL="http://127.0.0.1:$PORT" PHASE=after OUT_TAG="$out" ONLY="$only" STEPS="$steps" DB_PATH="$DB" \
    "$NODE_BIN" "$HERE/e2e.mjs" || rc=$?
  stop_server
  "$NODE_BIN" "$HERE/ci-gate.cjs" "$WORK/results-$out.md" --label "$tag" --allow-skip "${allow:--}" || gate=$?
  if [ "$rc" -ne 0 ]; then
    echo "::error::e2e part $tag: e2e.mjs exited $rc (1: a block aborted, 2: the run refused to start)"
  fi
  if [ "$rc" -ne 0 ] || [ "$gate" -ne 0 ]; then
    [ "$gate" -eq 0 ] || echo "::error::e2e part $tag: the results gate failed (see above)"
    server_log_tail
    FAILED="$FAILED $tag"
  else
    PASSED="$PASSED $tag"
  fi
  echo "==== part $tag: $((SECONDS - start)) s"
}

part trucks-dispatcher trucks,dispatcher "" ""
part signout signout "" ""
part maintenance maintenance "" "" E2E_MAINTENANCE_NOTICE=1
if picked moneypath; then
  # B1's expense goes in before the boot: the startup backfill it shows runs once, as the server starts.
  "$NODE_BIN" "$HERE/plant-before-boot.cjs" "$DB" || FAILED="$FAILED moneypath-plant"
fi
# P1, E1, N1 (with N1b) and B1: F1 and RC1 always SKIP, and E2 reads a table the page no longer has.
part moneypath moneypath P1,E1,N1,B1 ""
# T0 and T1-T11 render more previews together than the preview limiter allows one server.
part terms-t0 terms T0 ""
part terms terms T1,T2,T3,T4,T5,T6,T7,T8,T9,T10,T11 ""
part investorfixes investorfixes "" ""
# LV and LY need a finalized month, and LG a second investor with ledger rows: the seed has neither.
part lease lease "" "LV,LG,LY"
# An invented deny value (README "Local run", part 10), never a real one.
part instructions instructions "" "" E2E_DRIVER_INSTRUCTIONS_DENY=T8273641

echo
echo "ci-run: passed:${PASSED:- none}"
echo "ci-run: failed:${FAILED:- none}"
echo "ci-run: $SECONDS s in all"
[ -z "$FAILED" ] || exit 1
