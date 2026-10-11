// The page every page request gets while the app's build is missing.
//
// server.js serves the Vue SPA from client/dist. When client/dist/index.html
// is not there (a build that failed, has not run yet, or is running now), the
// SPA catch-all answers every page request with this page instead: a 503, so
// a browser, a proxy or a monitor reads "not now" rather than a page to keep,
// with Retry-After and Cache-Control: no-store so nothing holds on to it once
// the build is back. It reloads itself after the same minute (a meta refresh,
// no script), so nobody is left on it. It loads nothing else (no script,
// stylesheet, font or image): there is nothing else to serve beside it.
//
// ⚠️ It must never carry id="app". Every deploy check tells the app from this
// page by the SPA's mount point in client/index.html (scripts/deploy/
// remote-smoke.sh, remote-rollback.sh and staging-smoke.sh), so a deploy or a
// rollback that ends up serving this page fails its check instead of passing.
// scripts/test-app-updating-page.js pins both.
"use strict";

const APP_UPDATING_RETRY_AFTER_S = 60;

const APP_UPDATING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${APP_UPDATING_RETRY_AFTER_S}">
<title>LogisX is being updated</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
main{padding:24px;max-width:28rem}
h1{margin:0 0 8px;font-size:1.25rem}
p{margin:0;color:#94a3b8;line-height:1.5}
</style>
</head>
<body>
<main>
<h1>LogisX is being updated</h1>
<p>Please try again in a minute.</p>
</main>
</body>
</html>
`;

function sendAppUpdating(res) {
	res.status(503)
		.set({ "Cache-Control": "no-store", "Retry-After": String(APP_UPDATING_RETRY_AFTER_S) })
		.type("html")
		.send(APP_UPDATING_HTML);
}

module.exports = { APP_UPDATING_HTML, APP_UPDATING_RETRY_AFTER_S, sendAppUpdating };
