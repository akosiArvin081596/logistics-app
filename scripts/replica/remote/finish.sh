# replica:pull, the end of the program the server runs (see begin.sh): the
# steps, each reading the live app read-only and writing only into $TMP.
# Every node step reads /dev/null, never this script's stdin. They run at a low
# CPU and I/O priority (nice, and ionice where the box has it), so the copy
# yields to the live app and the other tenants.
cd -- "$TMP"
LOW=(nice -n 10)
if command -v ionice >/dev/null 2>&1; then LOW+=(ionice -c 2 -n 7); fi
"${LOW[@]}" "$NODE" snapshot.js --app="$APP" --stamp="$STAMP" </dev/null
"${LOW[@]}" "$NODE" scrub.js --app="$APP" --db="$TMP/app.db" </dev/null | tee scrub.json
"${LOW[@]}" "$NODE" settings.js --app="$APP" --out="$TMP/settings.env" </dev/null | tee settings.json
"${LOW[@]}" "$NODE" sheets-export.js --app="$APP" --out="$TMP/sheets.json" </dev/null | tee sheets.json.summary
mv -- sheets.json.summary sheets-summary.json
"${LOW[@]}" "$NODE" manifest.js --app="$APP" --dir="$TMP" --stamp="$STAMP" </dev/null
rm -f -- "$TMP"/*.js
REPLICA_REMOTE_OK=1
echo "replica-remote: ready"
