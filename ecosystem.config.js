// pm2 process definition for the production app.
//
// ⚠️ THIS FILE IS NOT THE LIVE SOURCE OF TRUTH. /root/.pm2/dump.pm2 is.
// `pm2 restart logistics-app` (step 4 of the deploy) re-reads the DUMP, not this
// file, so editing it changes nothing by itself — apply a change with
// `pm2 restart ecosystem.config.js --update-env && pm2 save`, then confirm with
// `pm2 jlist`. Its value is that it is the only human-readable record of WHY
// these numbers exist, and the only thing that stops a `pm2 delete && pm2 start`
// silently reverting to the 2 GB heap that was OOM'ing.
//
// Verified against the live process 2026-08-12: all five settings below match
// `pm2 jlist` for `logistics-app`, and dump.pm2 carries the 4096 heap. Note the
// sibling `logisx-staging` process has NONE of them (NODE_OPTIONS unset), so it
// still runs at the 2 GB default — this config has only ever applied to prod.
module.exports = {
  apps: [{
    name: 'logistics-app',
    script: 'server.js',
    cwd: '/var/www/logistics-app',
    env: {
      // 4 GB heap (was OOM'ing at the 2 GB default). heapsnapshot-near-heap-limit=1
      // writes a single .heapsnapshot to cwd if the process ever approaches 4 GB,
      // so the next OOM (if any) is diagnosable instead of a mystery.
      //
      // Disk: 18 GB available, 82% used (96 GB volume, measured 2026-08-12). An
      // earlier revision of this comment said "~41 GB free" — stale, and the
      // direction that matters, because a near-limit snapshot is written to cwd
      // and is on the order of the heap size. One fits; a repeated crash loop
      // writing several does not, and cwd is the app root, not a scratch mount.
      // As of 2026-08-12 no .heapsnapshot has ever been written anywhere on the
      // box, i.e. the 4 GB ceiling has not been approached since this was set.
      NODE_OPTIONS: '--max-old-space-size=4096 --heapsnapshot-near-heap-limit=1',
    },
    kill_timeout: 5000,
    wait_ready: false,
    restart_delay: 1000,
    max_restarts: 10,
    min_uptime: '10s',
  }]
}
