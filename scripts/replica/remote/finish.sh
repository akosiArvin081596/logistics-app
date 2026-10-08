# replica:pull, the end of the program the server runs (see begin.sh): the
# steps, each reading the live app read-only and writing only into $TMP.
# Every node step reads /dev/null, never this script's stdin.
cd -- "$TMP"
"$NODE" snapshot.js --app="$APP" --stamp="$STAMP" </dev/null
"$NODE" scrub.js --app="$APP" --db="$TMP/app.db" </dev/null | tee scrub.json
"$NODE" settings.js --app="$APP" --out="$TMP/settings.env" </dev/null | tee settings.json
"$NODE" sheets-export.js --app="$APP" --out="$TMP/sheets.json" </dev/null | tee sheets.json.summary
mv -- sheets.json.summary sheets-summary.json
"$NODE" manifest.js --app="$APP" --dir="$TMP" --stamp="$STAMP" </dev/null
rm -f -- "$TMP"/*.js
REPLICA_REMOTE_OK=1
echo "replica-remote: ready"
