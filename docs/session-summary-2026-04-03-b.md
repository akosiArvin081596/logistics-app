# LogisX Development Session Summary — April 3, 2026 (Session B)

## Session Overview

Extended session covering bug fixes, UI polish, Google API cleanup, staging environment setup, per-truck business configuration, driver-to-sheet auto-sync, investor dashboard improvements, multi-driver truck support, active load guard, dispatcher truck management, and system documentation.

---

## 1. Vant Chinese Locale Fix

### Problem
Driver app Vant UI components (pickers, popups) showed Chinese text ("取消" / "确认") instead of English.

### Root Cause
Vant defaults to `zh-CN` locale. No English locale was configured anywhere in the app.

### Fix
- Added `Locale.use('en-US', enUS)` in `client/src/main.js`
- All Vant components across the app now show English text

---

## 2. Google API Cleanup

### Audit Results
All 4 Google APIs confirmed fully migrated (Maps, Routes, Geocoding, Places). Cleaned up remnants:

| Item | Action |
|------|--------|
| `ORS_API_KEY` in server.js | Removed unused variable |
| `ORS_API_KEY` in CLAUDE.md | Replaced with `GOOGLE_MAPS_API_KEY` |
| `scripts/geocode-loads.js` | Migrated from Nominatim to Google Geocoding API |
| `loading=async` parameter | Added to Google Maps script tag to fix console warning |
| `addListener('click')` on markers | Changed to `addEventListener('gmp-click')` for AdvancedMarkerElement |

---

## 3. Route Map Expand Button

### Feature
Added an expand button (↔ icon) to the route map in load detail modals that opens a fullscreen map overlay.

### Implementation
- **DriverRouteMap.vue**: Added `<Teleport to="body">` overlay with full map, markers, route, and info badges
- Separate `expandedMap` instance with its own markers and animated polyline
- Map type toggle (Map/Satellite) on expanded view
- `@pointerdown.stop` on overlay to prevent reka-ui Dialog's outside-click detection from closing the parent modal
- `@click.stop` on panel to prevent backdrop close when interacting with map

### Route Polyline Improvements
- Restored animated marching-ants effect (lost during Leaflet → Google Maps migration)
- Changed colors: white base line with blue animated dashes
- Extended polyline to connect exactly to origin and destination markers (was ending at nearest road point)

---

## 4. Dashboard Modal Fixes

### Dialog Stacking Bug
**Problem**: When closing a load detail dialog, a second "Load Details" dialog appeared behind it.

**Root Cause**: reka-ui `TabsContent` keeps children mounted when inactive (CSS `data-state`, not `v-if`). The `Dialog` inside each tab uses `DialogPortal` to teleport to `<body>`. Dialogs from inactive tabs stayed visible.

**Fix**: Added `active` boolean prop to each tab component (JobBoardTab, ActiveLoadsTab, CompletedLoadsTab). When tab becomes inactive, `selectedJob = null` closes the dialog.

### Dialog Crash on Close
**Problem**: `TypeError: Cannot read properties of null (reading 'Dest Lat')` — DriverRouteMap computed properties crashed when `props.load` became null during dialog close animation.

**Fix**: Added `!props.load` null guards to all computed properties in DriverRouteMap.

### Dialog Backdrop
- Removed black backdrop entirely (`bg-black/80` → removed)
- Added `pointer-events-none` to DialogOverlay to prevent invisible overlay from blocking sidebar navigation
- Added `pointer-events-auto` to DialogContent so modal itself still receives clicks

---

## 5. Pagination Bar Repositioned

Moved pagination bar from below table to above table header, inline with search input — on all three dashboard tabs (Job Board, Active Loads, Completed).

---

## 6. Revenue Cards Restored (Super Admin Only)

### Problem
Revenue cards (Total Revenue, Paid, Pending) were removed entirely in a previous session, but should only be hidden from Dispatchers.

### Fix
- Re-added `RevenueGrid` component in `DashboardView.vue` with `v-if="auth.isSuperAdmin"`
- Restyled to match KPI cards (shadcn Card component, same border `#e8edf2`)
- Added 1rem spacing between KPI row and revenue row

---

## 7. Dashboard Table Scroll Fix

**Problem**: Table couldn't scroll in dashboard tabs.

**Root Cause**: Flex layout chain broken — `Card` (flex-col) → `Tabs` (no flex) → `CardContent` (overflow-y-auto). `Tabs` didn't participate in flex chain.

**Fix**: Added `class="flex-1 flex flex-col min-h-0"` to the `Tabs` component.

---

## 8. ETA Format Change

Changed ETA display from raw minutes ("201 min ETA") to hours and minutes format ("3h 21m ETA"). Applied to both small modal map and expanded fullscreen map via `etaFormatted` computed property.

---

## 9. Driver App — Accept/Reject Load Buttons

### Feature
Added Accept Load / Reject Load buttons to the driver's load detail page for dispatched loads.

### Implementation
- Buttons appear below the Documents section when load status is "Dispatched" and not yet accepted
- "Accept Load" (blue filled) and "Reject Load" (red outline) side by side
- Once accepted, buttons replaced with green "Load Accepted" banner
- Wired to existing `respondToLoad` store method → `POST /api/driver/respond`
- Updates Google Sheet status, logs to Status Logs, emits socket events

---

## 10. Truck Details in Driver App

- Moved Truck Details accordion from bottom to top of the accordion list (above Pickup Details)
- Changed to always show the accordion even when no truck is assigned — displays "No truck assigned to this driver" empty state

---

## 11. Per-Truck Business Configuration

### Major Architecture Change
Moved business configuration from global `investor_config` table to per-truck columns on `trucks` table.

### New Truck Columns
```sql
ALTER TABLE trucks ADD COLUMN purchase_price REAL DEFAULT 0;
ALTER TABLE trucks ADD COLUMN title_status TEXT DEFAULT 'Clean';
ALTER TABLE trucks ADD COLUMN maintenance_fund_monthly REAL DEFAULT 0;
```

### Changes
| Area | Change |
|------|--------|
| **Database** | 3 new columns on trucks table |
| **Server CRUD** | POST/PUT /api/trucks accept new fields |
| **Investor API** | Reads purchase_price, title_status, maintenance_fund from each truck; aggregates for fleet totals |
| **AddTruckForm.vue** | "Business Configuration" section with Purchase Price, Title Status, Maintenance Fund |
| **TruckTable.vue** | Same fields in edit modal |
| **ConfigPanel.vue** | Simplified to fleet-wide only: Fuel Savings Target %, Blue Chip Brokers |
| **AdminToolsView.vue** | ConfigPanel moved here from InvestorView |

### Net Cash Flow Fix
Updated investor API to include all expense sources in totalExpenses:
- Driver-uploaded expenses
- Maintenance fund service costs
- Paid compliance fees
- **NEW**: Insurance, ELD, HVUT/12, IRP/12, driver pay × 30, maintenance fund (all per-truck × months of operation)

---

## 12. Staging Environment Setup

### Infrastructure
| Item | Value |
|------|-------|
| **URL** | https://staging-logisx.abedubas.dev |
| **VPS path** | /var/www/logisx-staging |
| **Branch** | `development` |
| **Port** | 3003 |
| **PM2 process** | logisx-staging (id: 8) |
| **Google Sheet** | logisx-staging (ID: `1IG3yTknz91EesmyMog-d63UT5LkmpBYxHFEWSuDlgn8`) |
| **SSL** | Let's Encrypt via Certbot |

### Setup Steps
1. Cloned repo to `/var/www/logisx-staging`
2. Created separate `.env` with `PORT=3003` and staging spreadsheet ID
3. Changed `SPREADSHEET_ID` in server.js to staging sheet
4. npm install + vite build
5. nginx config for subdomain → port 3003
6. DNS A record + Certbot SSL
7. PM2 process started

### Test Data (staging)

**Users** (all passwords shown):

| ID | Username | Password | Role | Full Name | Company |
|----|----------|----------|------|-----------|---------|
| 1 | super_admin | *(set during setup)* | Super Admin | — | — |
| 2 | kevin | investor123 | Investor | Kevin Canunayon | KC Trucking LLC |
| 3 | deshorn | investor123 | Investor | Deshorn King | ABC Inc |
| 4 | lesline | driver123 | Driver | Lesline Johnson | — |
| 5 | kenrick | driver123 | Driver | Kenrick Davis | — |
| 6 | andrew | driver123 | Driver | Andrew Raczkowski | — |
| 7 | marcus | driver123 | Driver | Marcus Williams | — |
| 8 | dispatch1 | dispatcher123 | Dispatcher | Azure Estelle | — |

**Trucks:**

| Truck | Make/Model | Year | Driver | Owner | Purchase Price |
|-------|-----------|------|--------|-------|---------------|
| TRK-101 | Freightliner Cascadia | 2022 | Lesline Johnson | Kevin (KC Trucking) | $58,000 |
| TRK-102 | Kenworth T680 | 2023 | Kenrick Davis | Kevin (KC Trucking) | $65,000 |
| TRK-201 | Peterbilt 579 | 2021 | Andrew Raczkowski | Deshorn (ABC Inc) | $52,000 |
| TRK-202 | Volvo VNL 760 | 2024 | Marcus Williams | Deshorn (ABC Inc) | $72,000 |

---

## 13. Auto-Sync: Driver Users ↔ Carrier Database Sheet

### Feature
When a Driver user is created/updated/deleted in User Management, the "Carrier Database" Google Sheet tab is automatically updated.

### Implementation
New `syncDriverToCarrierSheet()` helper function in server.js with three actions:
- **add**: Appends new row with Driver, Carrier Name, Email, Trucks
- **update**: Finds existing row by driver name, updates managed fields, preserves other columns
- **delete**: Finds and removes the row using `deleteDimension`

### Hooks
| Endpoint | Trigger |
|----------|---------|
| `POST /api/users` | If role=Driver, adds row to sheet |
| `PUT /api/users/:id` | If driver name/email/company changed, updates sheet row |
| `DELETE /api/users/:id` | If role=Driver, removes sheet row |
| `PUT /api/trucks/:id` | If assignedDriver changed, updates Trucks column for affected drivers |

---

## 14. New Job Form Simplified

- Removed driver assignment dropdown (Assignment section) from `/jobs/new`
- Jobs always created as "Unassigned" with empty driver
- Removed auto-dispatch on job creation
- Kept Details/Notes field
- Workflow: Create job → appears in Job Board → dispatcher assigns driver from dashboard

---

## 15. Responsive Design Fixes

### Investor View
- Added responsive breakpoints at 900px and 600px
- Header actions and date inputs wrap on smaller screens
- Stats scale down on mobile
- KPI tiles changed from `auto-fit` to `repeat(2, 1fr)` — 2 per row, stacks to 1 on mobile

### User Management
- `.form-row` stacks to single column on ≤600px

### Trucks Page
- Made scrollable (`overflow-y:auto; flex:none`) instead of viewport-height constrained

---

## 16. Investor View Updates

### Business Configuration
- Removed from Investor View (investors can't see it)
- Moved to Admin Tools page for Super Admin
- Renamed to "Fleet Configuration" with only global settings

### Email Button Labels
- `info@logisx.com` → "Contact Operations"
- `dev@logisx.com` → "Contact Tech Support"

### Legal Document Upload
- Fixed disabled Upload button visibility (changed from 35% to 50% opacity with gray background)
- Added yellow hint text: "Select a doc type to upload" when file chosen but no doc type selected

---

## 17. GPS & Geofence Improvements

### GPS Accuracy Filter
- Low-accuracy readings (>100m) now filtered out to prevent map marker jumping
- Only affects displayed position; first reading always accepted

### Geofence Notifications — Human-Readable
**Before:**
- `"Geofence: At Shipper"` / `"Load LD-MNINC1W5 — auto-triggered by geofence"`

**After:**
- Driver: `"At Shipper — Load LD-MNINC1W5"` / `"You have arrived at the pickup location"`
- Dispatch: `"Lesline Johnson has arrived at the pickup location (Load LD-MNINC1W5)"`

---

## 18. Column Regex Pattern Fixes

Widened regex patterns in LoadCard.vue and LoadDetail.vue to match staging sheet headers:
- `/pickup.*city/` → `/pickup.*(city|info|address)/`
- `/drop.*city/` → `/drop.*(city|info|address)/`

This fixes the driver app not showing pickup/drop-off route details when sheet uses "Pickup Info" / "Drop-off Info" headers.

---

## 19. Other Bug Fixes

| Bug | Fix |
|-----|-----|
| TDZ error on /trucks page | Moved `computed`/`watch` after `form` reactive declaration in AddTruckForm.vue |
| Location picker blank on reopen | Always create fresh map instance (container destroyed between modal opens) |
| `google is not defined` in picker | Set `mapTypeControlOptions` via `map.setOptions()` after map creation |
| Map/Hybrid toggle missing on picker | Added `mapTypeControl: true` to LocationPickerModal createMap call |
| Stale chunk 404 on /notifications | Rebuilt production client to match deployed assets |

---

## Files Modified

### Server
- `server.js` — Per-truck business config, auto-sync to Carrier DB, geofence messages, GPS filter, ORS cleanup, net cash flow fix

### Frontend — New Files
- `scripts/seed-staging.js` — Staging test data seed script

### Frontend — Modified Files
- `client/src/main.js` — Vant English locale
- `client/src/composables/useGoogleMaps.js` — `loading=async` parameter
- `client/src/composables/useGeolocation.js` — GPS accuracy filter
- `client/src/views/DashboardView.vue` — Revenue cards, Tabs flex, active props
- `client/src/views/InvestorView.vue` — Responsive breakpoints, email labels, ConfigPanel removed
- `client/src/views/NewJobView.vue` — Removed driver assignment
- `client/src/views/AdminToolsView.vue` — Added ConfigPanel
- `client/src/views/TrucksView.vue` — Scrollable layout
- `client/src/components/driver/DriverRouteMap.vue` — Expand button, null guards, animated polyline, route extension, colors
- `client/src/components/driver/LoadDetail.vue` — Accept/Reject buttons, truck accordion, regex fix
- `client/src/components/driver/LoadCard.vue` — Regex fix for column matching
- `client/src/components/dashboard/JobBoardTab.vue` — Active prop, pagination position
- `client/src/components/dashboard/ActiveLoadsTab.vue` — Active prop, pagination position
- `client/src/components/dashboard/CompletedLoadsTab.vue` — Active prop, pagination position
- `client/src/components/dashboard/TrackingMap.vue` — gmp-click events
- `client/src/components/dashboard/LoadsMapView.vue` — gmp-click events
- `client/src/components/dashboard/RevenueGrid.vue` — Restyled to match KPI cards
- `client/src/components/data-manager/LocationPickerModal.vue` — Map type toggle, fresh map on reopen
- `client/src/components/investor/ConfigPanel.vue` — Simplified to fleet-wide settings
- `client/src/components/investor/ProductionSection.vue` — 2-col grid, responsive
- `client/src/components/investor/TrendSection.vue` — 2-col grid, responsive
- `client/src/components/investor/LegalDocumentPortal.vue` — Upload button visibility
- `client/src/components/trucks/AddTruckForm.vue` — Business config fields, TDZ fix
- `client/src/components/trucks/TruckTable.vue` — Business config fields in edit modal
- `client/src/components/ui/dialog/DialogContent.vue` — Backdrop removed, pointer-events fix
- `client/src/assets/shared.css` — Form row responsive, GOOGLE_MAPS_API_KEY docs
- `CLAUDE.md` — Updated env docs
- `scripts/geocode-loads.js` — Migrated to Google Geocoding API

---

## Deployment Info

### Production
- **URL**: https://logistics-app.abedubas.dev
- **Branch**: `main`
- **VPS path**: `/var/www/logistics-app`
- **PM2**: logistics-app (id: 7, port 3000)

### Staging
- **URL**: https://staging-logisx.abedubas.dev
- **Branch**: `development`
- **VPS path**: `/var/www/logisx-staging`
- **PM2**: logisx-staging (id: 8, port 3003)
- **Google Sheet**: logisx-staging (`1IG3yTknz91EesmyMog-d63UT5LkmpBYxHFEWSuDlgn8`)

### Deploy Commands
```bash
# Production (main branch)
ssh root@76.13.22.110 "cd /var/www/logistics-app && git pull && cd client && npx vite build && pm2 restart 7"

# Staging (development branch)
ssh root@76.13.22.110 "cd /var/www/logisx-staging && git pull origin development && cd client && npx vite build && pm2 restart logisx-staging"
```

Note: Staging has a local modification to server.js (different SPREADSHEET_ID). Use `git stash && git pull && git stash pop` if pull conflicts.

---

## 20. Truck-Driver Assignment — Clarification & Rework

### Client Clarification
> "Yes a truck can have multiple drivers. The dispatch both super admin and sub dispatch can assign driver to truck."

### Analysis of Current vs Requested

| Feature | Was | Now |
|---------|-----|-----|
| Drivers per truck | 1:1 strict (auto-unassign) | 1:1 with active load guard |
| Reassignment | Instant, no checks | Blocked if driver has active load |
| Who can assign | Super Admin only | Super Admin + Dispatcher |
| Driver dropdown | Only unassigned drivers | Only unassigned drivers |

### Final Behavior
The 1:1 auto-unassign is **preserved** (driver moves from old truck to new truck), but with a safety guard:

1. Dispatcher wants to move Lesline from TRK-101 to TRK-201
2. System checks: does Lesline have an active load? (dispatched, in transit, etc.)
3. **If YES** → 409 error: "Lesline Johnson has an active load (LD-XXX, status: In Transit). Complete or cancel the load before reassigning."
4. **If NO** → Lesline is removed from TRK-101, assigned to TRK-201. TRK-101 is now available for another driver.

### Implementation
- `checkDriverActiveLoad()` helper — queries Google Sheet "Job Tracking" for active statuses
- POST/PUT `/api/trucks` — check active load before unassign+reassign
- Dispatcher role added to POST/PUT `/api/trucks` (DELETE remains Super Admin only)
- `availableDriverNames` filter restored — dropdown shows only unassigned drivers

---

## 21. Dispatcher Truck Management Access

### Changes
| Endpoint | Before | After |
|----------|--------|-------|
| `POST /api/trucks` (create) | Super Admin only | Super Admin + Dispatcher |
| `PUT /api/trucks/:id` (edit) | Super Admin only | Super Admin + Dispatcher |
| `DELETE /api/trucks/:id` (delete) | Super Admin only | Super Admin only (unchanged) |

### Frontend Changes
- `TrucksView.vue` — AddTruckForm and TruckTable edit enabled for Dispatcher
- `TrucksView.vue` — Investor users loaded for Dispatcher (owner dropdown works)
- `AppSidebar.vue` — Truck Database link already existed for Dispatcher (no change needed)

---

## 22. System Documentation Created

### Flow Diagram
**File:** `docs/logisx-flow-diagram.html`

Self-contained HTML page with 9 sections:
1. User Roles & Access — 4 roles with visual badges
2. Initial Setup Flow — from fresh app to operations-ready
3. Load Lifecycle — complete flow with status changes, geofence triggers, role labels
4. Data Flow Diagram — where each data type lives, who writes/reads
5. Entity Relationships — Investor → Trucks → Drivers with rules
6. Real-Time Events — all Socket.IO events with triggers and recipients
7. Investor Financial Flow — revenue sources, expense components, Net Cash Flow formula
8. Load Status Progression — visual status chain with geofence markers
9. Technology Stack — full stack overview

### Complete Application Workflow Documented
Full step-by-step process from fresh install through daily operations:
- Phase 1: Initial Setup (create investors, dispatchers, drivers, trucks)
- Phase 2: Daily Operations (create loads, dispatch, accept/reject)
- Phase 3: Load Lifecycle (pickup → transit → delivery → POD)
- Phase 4: Financial Tracking (expenses, investor dashboard, net cash flow)

---

## Updated Files Summary (additions to earlier list)

### Server
- `server.js` — `checkDriverActiveLoad()` helper, active load guard on truck assignment, Dispatcher role on truck endpoints

### Frontend
- `client/src/stores/trucks.js` — restored available drivers filter
- `client/src/views/TrucksView.vue` — Dispatcher can add/edit trucks

### Documentation
- `docs/logisx-flow-diagram.html` — complete system flow diagram (new)
- `docs/session-summary-2026-04-03-b.md` — this file (updated)

---

## Role Access Summary (Final)

| Feature | Super Admin | Dispatcher | Driver | Investor |
|---------|:-----------:|:----------:|:------:|:--------:|
| Create users | ✓ | | | |
| Create/edit trucks | ✓ | ✓ | | |
| Delete trucks | ✓ | | | |
| View trucks | ✓ | ✓ | | View own |
| Assign drivers to trucks | ✓ | ✓ | | |
| Create loads | ✓ | | | |
| Assign drivers to loads | ✓ | ✓ | | |
| Accept/Reject loads | | | ✓ | |
| Update load status | | | ✓ | |
| Upload POD/expenses | | | ✓ | |
| View tracking map | ✓ | ✓ | | |
| View investor dashboard | ✓ | | | ✓ (own) |
| Fleet Configuration | ✓ | | | |
| Data Tools | ✓ | | | |
