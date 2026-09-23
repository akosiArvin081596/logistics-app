<!-- Moved verbatim from the root CLAUDE.md on 2026-09-23. Claude Code loads a nested CLAUDE.md
     on demand, when it reads files under this directory; the root CLAUDE.md keeps the house
     invariants and the deep-dive index. Only pinned counts were dropped and verified errors corrected. -->

# Frontend (`client/`)
Vue 3 + Vite SPA with Vue Router, Pinia stores, Tailwind CSS v4, shadcn-vue components (via radix-vue/reka-ui), Vant mobile UI, **Google Maps** for maps, and Socket.IO client for real-time updates. (**Leaflet is not a dependency** — earlier revisions of this file said "Leaflet + Google Maps"; there is zero Leaflet in `client/`.)

Key directories:
- `stores/` — auth, dashboard, sheets, driver, messages, investor, users, adminTools, dispatchNotifications, driversDb, investors, trucks, trailers, invoices, financials, **appShell**, **maintenance**
- `composables/` — useApi, useSocket, useSocketRefresh, useToast, usePagination, useGeocode, useGoogleMaps, useUpload, useFileDrop, useDocumentScan, useDriverPosition, useVoiceGuidance, useScreenWakeLock, useViewport
- `lib/` and `utils/` — **shared client logic, and the first place to look before writing a helper.** `routeProgress.js`, `voiceLadder.js`, `payoutPeriod.js`, `monthLabel.js`, `duration.js`, `fileValidation.js`, `imageUtils.js`, `asyncPool.js`, `gallonsRecovery.js`, `fuelReview.js`, `loadReview.js`, `dataIssues.js`, `formDraft.js`, `signingConsent.js`, `address.js`, `datetime.js`, `format.js`, `usStates.js`, `cn()` in `lib/utils.js`. Several have a matching `scripts/test-*.mjs` runner (`test-route-progress.mjs`, `test-voice-ladder.mjs`, `test-payout-card-period.mjs`). `utils/` holds `routeProgress.js`, `voiceLadder.js`, `datetime.js`, `format.js` and `usStates.js`; the rest are in `lib/`, which also holds `chatAttachment.js`, `emailAddress.js`, `expenseWindow.js`, `fonts.js`, `fuelStops.js`, `loadId.js`, `receiptPhoto.js`, `saveOutcome.js`, `sessionCheck.js` and `uploadFailure.js` — with runners `test-fuel-reserve-line.mjs`, `test-email-address-client.mjs`, `test-session-check.mjs`, `test-upload-failure.mjs`, `test-expense-load-window-client.mjs` and `test-driver-receipt-flow.mjs` (which compiles `ExpenseForm.vue`, so it needs the client's dependencies installed).
- `components/ui/` — shadcn-vue primitives (badge, button, card, dialog, input, select, skeleton, table, tabs)
- `components/` — feature-organized dirs: `analytics`, `apply`, `dashboard`, `data-manager`, `driver`, `drivers-db`, `financials`, `invest`, `investor`, `investors`, `invoices`, `layout`, `shared`, `trucks`, `ui`, `users`
- `views/` — the route components (includes the public `TrackLoadView.vue`)
- `wizard/` — JSON-driven framework for the multi-step Invest flow. `engine/WizardEngine.js` interprets a step schema from `data/`, `expressionEvaluator.js` evaluates `show-if`/`require-if` without `eval()`, `spotlight.js` drives the highlight overlay. Extend this engine for new multi-step forms instead of a bespoke stepper.

**Vite proxy** (`client/vite.config.js`): `/api`, `/socket.io` (with `ws: true`) and `/uploads` proxy to `VITE_API_TARGET` (default `http://localhost:3000`); the dev port is `VITE_DEV_PORT` (default 5173). Both are read from the repo-root `.env`.

**Composable singletons**: `useSocket()` and `useToast()` are module-level singletons (not per-component) — `useSocket` keeps one global socket connection, `useToast` one reactive toast state. `useApi()` is **not**: it is a stateless factory, each call returning fresh `get`/`post`/`put`/`patch`/`del` closures over `fetch` (20 s default timeout, `X-Requested-With` on every call, errors carry `status`/`code`/`data`), so a store's module-scope `const api = useApi()` is a convenience, not shared state. `useSocketRefresh(event, reload, room = 'dispatch')` joins a room on mount and re-runs `reload` (debounced 300 ms) on the server's `<domain>:changed` events from `notifyChange()`. Since 2026-09-23 the server ends a socket together with its session, and socket.io never reconnects after a server-side close by itself, so on `io server disconnect` `useSocket` asks `GET /api/auth/session` after 1, 3 and 10 s and reopens only on a signed-in answer (a signed-out answer stays down; no answer asks again within the same budget; a socket up for 30 s resets the ladder). Listeners added with `on()` are re-attached to every socket it opens, so a mounted page keeps receiving after a reconnect; `disconnect()` — called by `auth.js` login and setup once the POST succeeds, and by logout — drops the socket, the registered room name, the listener list and any pending reconnect. `resume()` brings the socket back after a password change. `scripts/test-socket-session-client.mjs`.

**Phone GPS retired**: As of 2026-05-13 the ELD feeds are the only location source for tracking, pay and the geofence (Routemate, and Linxup since 2026-07-25). `useGeolocation` was deleted, the driver app reports no pings, and the "Location Access Required" gate was removed from `DriverView`. The phone's position came back for **display only**: `composables/useDriverPosition.js` (a module singleton) starts `watchPosition` when a driver taps Navigate on their own route map (any load, never in dispatch mode) or LoadDetail's "Try Again" — the browser asks for permission at that tap. Its fixes are tagged `source:'phone'` and win while under 15 s old; otherwise the ELD fix is shown (`GET /api/driver/position` every 30 s, falling back to `/api/locations/latest`, plus the `location-update` socket event). It never writes anything. `POST /api/location` is a 410 Gone stub so cached old clients get a clear error, not a 404. See `routemateSyncTelemetry()` for the live-position pipeline.

⚠️ **"Retired" does NOT mean `navigator.geolocation` is gone — it is still called in four places, and a `Permissions-Policy: geolocation=()` header would break all of them.** Verified 2026-08-08 while scoping a CSP; the plain-English summary above reads as if the API were unused, and acting on that reading breaks the driver app.
- `composables/useDriverPosition.js` — the Drive Mode `watchPosition` described above (display only; `DriverView.vue`'s `enablePhoneGps` is now a thin wrapper over it). It is why the retirement is true for tracking and pay and false for the API surface.
- `StepPersonalInfo.vue`, `LocationPickerModal.vue`, `InvestorApplyView.vue` — one-shot `getCurrentPosition` for **address autofill**, unrelated to load tracking and never retired.

**useGoogleMaps**: fetches the API key from `GET /api/config/maps-key` and injects the Maps JavaScript API `<script>` itself, with a callback. It does **not** use `@googlemaps/js-api-loader`, which is still a dependency and a `vendor-maps` chunk entry but imported nowhere; `StepPersonalInfo.vue` and `InvestorApplyView.vue` fetch the key and inject their own script.

**Optimistic updates**: Both `driver` and `messages` stores append messages locally before the API request completes.

**Mobile / admin drawer**: A shared `appShell` Pinia store exposes `isMobile` (resize-driven) and `sidebarOpen`. On mobile, `AppSidebar.vue` is a slide-in drawer with backdrop (`v-if="isMobile && appShell.sidebarOpen"`); on desktop, the persistent collapsible sidebar. New admin views should toggle it via `appShell.openSidebar()` rather than rolling their own mobile nav. Admin pages (Dashboard, Notifications, Messages, Expenses) are responsive top-down — commits `dbe9d4e`…`8e1a62d` collapse multi-pane layouts into single-pane stacks below the `md` breakpoint and swap detail tables for card lists. Vant is reserved for driver/public surfaces; admin uses shadcn-vue + Tailwind.

**Routing** (the user-facing routes below, plus the `/` redirect and the SPA catch-all, all in `client/src/router/index.js`; every route that is not public is role-guarded):

| Route | Access | Notes |
|-------|--------|-------|
| `/login` | Public | Redirects authenticated users to role home |
| `/apply` | Public | Driver application form (no sidebar) |
| `/invest` | Public | Investor application form (no sidebar) |
| `/track` | Public (`alwaysPublic`) | Customer search form — enter Load ID to track |
| `/track/:loadId` | Public (`alwaysPublic`) | Customer tracker view with stages, ETA, live map. Accessible to logged-in admins too (so dispatchers can preview what a customer sees). |
| `/dashboard` | Super Admin, Dispatcher | |
| `/jobs/new` | Super Admin | Create new job |
| `/tracking` | Super Admin, Dispatcher | |
| `/expenses` | Super Admin, Dispatcher | |
| `/invoices` | Super Admin | Invoice workflow |
| `/messages` | Super Admin, Dispatcher | |
| `/notifications` | Super Admin, Dispatcher | |
| `/data` | Super Admin | Sheet data manager |
| `/driver` | Driver, Super Admin | Driver app (no sidebar) |
| `/investor` | Super Admin, Investor | Investor dashboard |
| `/users` | Super Admin | |
| `/trucks` | Super Admin, Dispatcher, Investor | |
| `/investors` | Super Admin | Investor records management |
| `/investor-portals` | Super Admin | Index of investors — opens a read-only replica of each one's portal |
| `/investor-portals/:userId` | Super Admin | Read-only preview of a single investor's `/investor` view (banner + same components, scoped via `?as_user_id=`). The component is **`InvestorPortalPreviewView.vue`**: it calls `store.setPreview(id)` at setup, then renders a banner plus `<InvestorView :key="userId">` — so it is, literally, a read-only wrapper around `InvestorView.vue`. |
| `/drivers` | Super Admin | Drivers directory |
| `/trailers` | Super Admin, Dispatcher | |
| `/applications` | Super Admin | Driver applications review |
| `/investor-applications` | Super Admin | Investor applications review |
| `/admin/tools` | Super Admin | Admin data tools |
| `/analytics` | Super Admin, Dispatcher | Mileage analytics (`AnalyticsView.vue`) — miles per truck/driver by Sat–Fri week, month and total |
| `/admin/financials` | Super Admin | Company P&L view |
| `/admin/fleet-health` | Super Admin, Dispatcher | Routemate ELD fleet health — fault codes, DVIR, telemetry status |
| `/archive` | Super Admin | Archived data viewer |
| `/payouts` | Super Admin | Investor payout ledger — the settlement layer. **Money surface**; read the payout-ledger section of [`backend-server.md`](../docs/claude/backend-server.md) first |
| `/my-payouts` | Super Admin, Investor | The investor's own side of the same ledger (`MyPayoutsView.vue`) |
| `/admin/driver-pay-overrides` | Super Admin | Per-driver-day pay overrides (`excluded_driver_days`) — edits the driver-pay "active days" basis, so it moves invoice *and* investor math |
| `/admin/data-issues` | Super Admin | Data-issue triage (`DataIssuesView.vue`, backed by `client/src/lib/dataIssues.js`) |
| `/account/change-password` | Signed-in users who must change their password | The **forced**-change screen (`meta.forcedPasswordChange`): the guard sends anyone whose `mustChangePassword` is false to their role home. The voluntary change UI is the driver's `ChangePasswordModal`. The server route is limited by `changePasswordLimiter` (5/15 min). |

Auth guard calls `checkSession()` on first navigation only (blocks until resolved); later navigations use cached `isAuthenticated`. Unauthorized users redirect to `auth.roleHome` (Driver → `/driver`, Dispatcher → `/dashboard`, Investor → `/investor`). The order after that: a public route sends a signed-in user to `roleHome` unless `alwaysPublic`; no session → `/login`; `mustChangePassword` → `/account/change-password`; then the role check. The server enforces the forced change on its own (403 `PASSWORD_CHANGE_REQUIRED`); the client routes on `auth.user.mustChangePassword` from `GET /api/auth/session`, and after a change `auth.afterPasswordChange()` re-reads the session rather than editing it locally. Since 2026-09-23 a session check that gets no answer does not sign anyone out: only a 401, or a 2xx saying `authenticated:false`, does. A user this tab already knew stays in the app marked "reconnecting" while `client/src/lib/sessionCheck.js` retries in the background, and `onSessionResolved` re-runs the guard when the user, role or `mustChangePassword` changes (a different person reloads the page). Runner: `scripts/test-session-check.mjs`.

Routes flagged `meta: { alwaysPublic: true }` (only `/track`, `/track/:loadId`) bypass the "authenticated → roleHome" redirect that applies to `/login`/`/apply` — so a logged-in dispatcher can preview the tracker.

## The `pdfjs-dist` security pin

**⚠️ `client/package.json` pins `pdfjs-dist` through an `overrides` block, and it is a security fix, not a preference.** `vue-pdf-embed@2.1.5` (the latest release) depends on `pdfjs-dist ^5.7.284`, which sits inside the **CVE-2026-16633** range (`>=5.6.83 <6.2.108`, arbitrary JS execution from a malicious PDF) and has no 5.x backport — the only forward fix is forcing `6.2.108`. **The override is load-bearing only because `PdfZoomViewer.vue` imports `vue-pdf-embed/dist/index.essential.mjs`**; the package's *default* entry inlines pdf.js and would ignore the override entirely. Changing either half without the other silently reintroduces the CVE. Both files carry the explanation — read them before bumping `vue-pdf-embed`. `pdfjs-dist@6.2.108` declares `node >=22.13.0 || >=24`, which **used to** print an EBADENGINE warning on the old Node 20. The move to 22.23.2 satisfies it and the warning is gone (0 occurrences in CI, verified 2026-08-25) — it was never a real problem anyway, since Vite bundles pdfjs for the BROWSER and Node's version never applied to it.

## Driver receipts and upload refusals (2026-09-23)

- **Picker:** `ExpenseForm` offers "Take photo" (`capture="camera"`) and "Choose from gallery" (no `capture`), into one attach path (HEIC→JPEG, 1024 px); the Load field is required. Each photo is a job (`createPhotoJobs()`, `lib/receiptPhoto.js`), so a slow scan or OCR result can never refill a photo that was replaced or deleted. Before this the picker was camera-only, which drivers reported as "receipts not uploading".
- **Saving:** `POST /api/expenses` is not idempotent, so the save waits 90 s, tries once and never retries. A reply that never came (a timeout, a dropped connection, a 502/504 with no body — `replyLost()` in `lib/saveOutcome.js`) shows "Not confirmed — your entry is still here" and the store re-reads the driver's data. `expensesForLoad()` (`lib/loadId.js`) matches a load's expenses on the server's key (trimmed, lowercased, one `#` dropped).
- **The 7-day receipt window** is the server's decision (`lib/expense-window.js`), shipped per load as `_expenseWindow` (`{ eligible, state, deliveredAt, closesAt }`). `lib/expenseWindow.js` here only re-checks `closesAt` against the phone's clock — it can close a window, never reopen one — and writes the note and hint copy; `LoadDetail`'s clock ticks every 60 s and on return to the foreground. When `_expenseWindow` is missing (the history read failed), the form shows on active loads only.
- **Upload refusals:** `lib/uploadFailure.js` treats every 4xx except 408/429 as final and shows the server's own message; a 413, a 415 or a file-related 400 adds a retake hint unless the message already says so. `ExpenseForm` uses `withRetakeHint`, `DocumentUpload` uses `uploadFailureToast`. Runner: `scripts/test-upload-failure.mjs`.
