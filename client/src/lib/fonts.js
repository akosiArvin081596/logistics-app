/**
 * Applies the Google Fonts stylesheet that index.html preloads.
 *
 * index.html ships the link as `rel="preload" as="style"`, which fetches it
 * early at high priority *without* blocking first paint. A preload does not
 * apply anything on its own, so flipping `rel` to "stylesheet" here is what
 * actually puts DM Sans / Dancing Script / JetBrains Mono on the page. The
 * element is reused rather than recreated so the browser serves the already
 * preloaded response instead of issuing a second request.
 *
 * This is the same end state as the `media="print" onload="this.media='all'"`
 * attribute it replaces. The handler had to go because an inline `on*` handler
 * is the one thing a CSP cannot whitelist — nonces and hashes apply to <script>
 * elements, not to event-handler attributes — so it alone forced
 * `script-src 'unsafe-inline'`, which is a policy that does not stop XSS.
 *
 * Measured on the production build (see index.html for the full note): a plain
 * render-blocking <link> instead costs 284-1096 ms of first contentful paint
 * warm, and 3344 ms when fonts.googleapis.com is slow. The trick was load
 * bearing; only the inline handler had to go.
 *
 * Failure mode is deliberately soft: if the element is missing the fonts simply
 * never apply and every surface falls back (body is 'DM Sans', sans-serif).
 * Nothing here should ever throw during boot.
 */
export function applyWebFonts() {
  const link = document.getElementById('app-fonts')
  if (link && link.rel !== 'stylesheet') link.rel = 'stylesheet'
}
