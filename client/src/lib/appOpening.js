// "The app opens": this page has loaded from scratch and the screen asking is the first it has shown.
// A reload counts. A tab shown again, a page back from the browser's page cache and any move inside a
// running page start no new page, so they never get here afresh; the driver app reached through the
// login page or a forced password change is a later screen, not an opening. The router counts screens.
// Pinned by scripts/test-driver-release-notices-client.mjs.

let screensShown = 0

export function noteScreenShown() {
  screensShown++
}

export function isFirstScreen() {
  return screensShown === 1
}
