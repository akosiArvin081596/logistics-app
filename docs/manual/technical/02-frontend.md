# Frontend

The frontend is a Vue 3 single-page application built with Vite and served by Express in production from `client/dist/`. In development, Vite runs its own dev server on port 5173 and proxies `/api` and `/socket.io` to the Express server on port 3000.

## Stack

- **Vue 3** with the Composition API throughout. No mixins, no class components.
- **Vite** for build and dev.
- **Vue Router** with role-based guards.
- **Pinia** for state. Each store is a separate module.
- **Tailwind CSS v4** for utility styling.
- **shadcn-vue** (via radix-vue / reka-ui) for primitive components: buttons, dialogs, tabs, selects, tables.
- **Vant** for mobile UI on driver and public surfaces. Reserved for those — admin views stick with shadcn-vue + Tailwind to keep desktop UX consistent.
- **Leaflet** and **Google Maps** for maps. Leaflet for the customer-facing tracker, Google Maps for everything that needs routing and geocoding.
- **Socket.IO client** for real-time updates.

## Directory layout

```
client/
├── src/
│   ├── assets/         # global CSS (shared.css)
│   ├── components/     # feature-organized
│   │   ├── ui/         # shadcn-vue primitives
│   │   ├── layout/     # AppSidebar, AppShell
│   │   ├── shared/     # cross-feature widgets
│   │   ├── dashboard/  # JobBoardTab, ActiveLoadsTab, etc.
│   │   ├── driver/     # driver-specific tabs and modals
│   │   ├── investor/   # earnings, fleet breakdown, etc.
│   │   ├── invest/     # public investor application wizard
│   │   ├── apply/      # public driver application form
│   │   ├── trucks/, trailers/, users/, drivers-db/, investors/, data-manager/
│   ├── composables/    # useApi, useSocket, useToast, useGoogleMaps, …
│   ├── stores/         # Pinia stores
│   ├── views/          # 25 route-level views
│   ├── wizard/         # JSON-driven wizard engine (used by /invest)
│   ├── router/         # route definitions + guards
│   └── main.js
└── vite.config.js      # /api and /socket.io proxy → :3000
```

## Routing

There are 25 routes. Each carries a `meta.roles` array and an optional `meta.alwaysPublic` flag.

| Route | Access | Notes |
|---|---|---|
| `/login` | public | Redirects authenticated users to their role home |
| `/apply` | public | Driver application form (no sidebar) |
| `/invest` | public | Investor application wizard |
| `/track` | public (`alwaysPublic`) | Customer search form |
| `/track/:loadId` | public (`alwaysPublic`) | Customer tracker — accessible to admins for preview |
| `/dashboard` | Super Admin, Dispatcher | |
| `/jobs/new` | Super Admin | |
| `/tracking` | Super Admin, Dispatcher | Live truck map |
| `/expenses` | Super Admin, Dispatcher | |
| `/invoices` | Super Admin | |
| `/messages` | Super Admin, Dispatcher | |
| `/notifications` | Super Admin, Dispatcher | |
| `/data` | Super Admin | Sheet data manager |
| `/driver` | Driver, Super Admin | No sidebar (mobile shell) |
| `/investor` | Super Admin, Investor | |
| `/users` | Super Admin | |
| `/trucks` | Super Admin, Dispatcher, Investor | |
| `/investors` | Super Admin | Investor records |
| `/drivers` | Super Admin | Drivers directory |
| `/trailers` | Super Admin, Dispatcher | |
| `/applications` | Super Admin | Driver applications |
| `/investor-applications` | Super Admin | Investor applications |
| `/admin/tools` | Super Admin | |
| `/admin/financials` | Super Admin | Company P&L |
| `/archive` | Super Admin | Archived sheet data |

The router runs `checkSession()` on the very first navigation and blocks until the session check resolves. Subsequent navigations use the cached `isAuthenticated` state. Routes with `meta.alwaysPublic` bypass the "authenticated → redirect to role home" rule, which is what lets logged-in dispatchers preview the public tracker without being punted back to their dashboard.

Unauthenticated users hitting a protected route get bounced to `/login`. Authenticated users hitting a route their role can't access get redirected to `auth.roleHome` (Driver → `/driver`, Dispatcher → `/dashboard`, Investor → `/investor`, Super Admin → `/dashboard`).

## Composables

Several composables behave as module-level singletons rather than per-component instances. Important to understand:

- **`useApi()`** — returns the same axios-like fetch wrapper instance every time it's called. Each Pinia store does `const api = useApi()` at module scope.
- **`useSocket()`** — maintains a single global Socket.IO connection for the whole app. Components subscribe to events; teardown happens on unmount but the connection persists.
- **`useToast()`** — single global toast queue.

Other composables are per-instance:

- **`useGoogleMaps()`** — loads the Maps JS API via `@googlemaps/js-api-loader`. Fetches the API key from `GET /api/config/maps-key` so it doesn't have to ship to the client at build time.
- **`useGeocode()`** — wrapper over the geocode-cache endpoints.
- **`usePagination()`** — generic offset/limit pagination state.
- **`useSocketRefresh()`** — used by 11 admin pages to auto-refresh their data when a relevant socket event fires.

## State management

Pinia stores by domain:

- **auth** — session, role, roleHome.
- **dashboard** — KPIs, job board, active loads, fleet data.
- **sheets** — generic sheet read/write.
- **driver** — driver-specific load list and status.
- **messages** — chat messages, optimistic appends.
- **investor** — investor dashboard data.
- **users**, **adminTools**, **dispatchNotifications**, **driversDb**, **investors**, **trucks**, **trailers**, **invoices**, **financials**.

Two stores apply optimistic updates: `driver` and `messages` both append locally before the API request completes, then reconcile on the response.

The app intentionally **does not** maintain a deep client-side cache. Most pages re-fetch on mount and rely on Socket.IO refresh events to stay current. This keeps the data model simple and the dashboard accurate.

## The app shell

A shared `appShell` Pinia store exposes `isMobile` (driven by a resize listener) and `sidebarOpen`. On mobile the `AppSidebar.vue` renders as a slide-in drawer with a backdrop overlay; on desktop it's a persistent collapsible sidebar. Any new admin view should toggle the drawer via `appShell.openSidebar()` rather than rolling its own mobile nav.

Admin pages (Dashboard, Notifications, Messages, Expenses) are responsive top-down — Phase 0–4 work collapsed multi-pane layouts into single-pane stacks below Tailwind's `md` breakpoint and swapped detail tables for card lists.

## The driver view

`/driver` is the largest single view in the app (`DriverView.vue`, ~1,700 lines). It runs without a sidebar because drivers use it on phones in the cab. It's organized as five tabs:

1. **Loads** — assigned, accepted, in-progress.
2. **Status** — current load detail and status update form.
3. **Alerts** — notifications.
4. **Kit** — truck documents the admin has marked visible, plus onboarding docs.
5. **Messages** — chat with dispatch.

A sixth screen — the **onboarding lock** — blocks the entire view if the driver hasn't completed onboarding. The lock progresses through document signing, drug test scheduling, FMCSA Clearinghouse enrollment, and driver training.

## The investor view

`/investor` is a stack of sections that compose the dashboard:

- **Hero header** — profile photo, name, "Performance overview", date-range picker, "Download Report" button.
- **Earnings section** — month selector, full P&L breakdown for the selected month, all-time totals strip.
- **Fleet breakdown** — per-truck cards with mileage, status, assigned driver.
- **Production** — miles driven, loads completed, utilization.
- **Cash flow** — revenue trend chart.
- **Asset section** — truck inventory and book value.
- **Documents portal** — signed legal docs, tax forms.
- **Chat** — direct messaging with admin.

The investor view consumes `/api/investor` which returns a pre-aggregated payload — no client-side joins.

## The wizard engine

The public investor application at `/invest` is a multi-step wizard built on a small JSON-driven framework in `client/src/wizard/`:

- `engine/WizardEngine.js` — step interpreter.
- `expressionEvaluator.js` — evaluates `show-if` and `require-if` conditions without `eval()`.
- `spotlight.js` — guided highlight overlay.
- `data/` — step schemas (the actual content of the wizard).

When adding a new multi-step form, extend this engine rather than rolling a bespoke stepper. The driver application at `/apply` is a simpler form and predates the wizard, so it lives as a single Vue component.

## Build & deploy

- Development: `npm run dev` (Express, port 3000) and `npm run dev:client` (Vite, port 5173) in separate terminals. Open `http://localhost:5173`.
- Production build: `npm run build:client` produces `client/dist/`.
- Production serve: `npm start` — Express checks if `client/dist/` exists and serves it, otherwise falls back to the legacy `public/` directory.

The SPA catch-all `app.get("*")` serves `index.html` for any unmatched route, which is what makes client-side routing work in production.
