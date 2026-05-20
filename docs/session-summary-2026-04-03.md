# LogisX Development Session Summary — April 3, 2026

## Session Overview

Full session covering dashboard visual redesign, Google Maps migration, Google API integrations, shadcn-vue installation, and component library migration for the LogisX logistics management application.

---

## 1. Dashboard Visual Redesign — Corporate Polish

### KPI Cards
- Removed colored left-border accents and tinted gradient backgrounds
- Replaced with clean white cards (`#ffffff`) with uniform neutral border (`#e8edf2`)
- Compact layout: padding `1rem 1.25rem`, icon `42px`, value font `1.75rem`, min-height `88px`
- Color identity carried by icon containers only (blue, amber, emerald, violet backgrounds)
- Hover lift animation preserved (`translateY(-2px)` + shadow intensification)

### Revenue Cards
- Removed from dashboard per client request (Total Revenue, Paid, Pending)
- `RevenueGrid` component no longer rendered in `DashboardView.vue`

### Completed KPI Card Fix
- Changed from `completedThisMonth` (date-filtered, showed 0) to actual total count
- Added `completedTotal` prop to `KpiGrid.vue`, passed `store.completedJobs.length` from `DashboardView.vue`

### Active Loads Actions Column
- Redesigned from stacked/wrapping layout to horizontal row
- Status select + Go button and Driver select + Go button side by side
- Added small uppercase labels ("STATUS", "DRIVER") above each dropdown
- Cancel button as compact `✕` at the end
- Both selects use `flex:1` to fill available column width

### Spacing & Layout Fixes
- **Root cause identified**: `* { padding: 0 }` in `shared.css` was unlayered CSS that silently overrode all Tailwind utility padding classes (`px-4`, `py-2`, etc.)
- **Fix**: Changed global reset from `* { margin: 0; padding: 0; box-sizing: border-box; }` to `*, *::before, *::after { box-sizing: border-box; margin: 0; }` — removed `padding: 0`
- Dashboard layout uses fixed viewport height (app-shell pattern) — KPI cards pinned at top, table scrolls independently
- Created CSS classes (`kpi-grid`, `dash-header`, `dash-wrapper margin-top`) to bypass Tailwind v4 layering issues

### Status Badge Rewrite
- Replaced broken Tailwind v4 `ring-1 ring-inset ring-blue-600/20` classes with pure CSS `.status-badge-pill .sb-*` classes
- Later migrated to shadcn-vue `<Badge>` component with color classes

---

## 2. Google APIs — Full Migration

### APIs Confirmed Active
| API | Purpose | Status |
|-----|---------|--------|
| Google Places API (New) | Address search/autocomplete | ✅ Already enabled |
| Google Geocoding API | Reverse geocode (click → address) | ✅ Enabled this session |
| Google Routes API | Driving directions/polylines | ✅ Already working |
| Google Maps JavaScript API | Map rendering | ✅ Enabled this session |
| Google Weather API | Weather at driver location | ✅ Uses same key |

### Reverse Geocode Switch
- **Before**: `/api/geocode` endpoint used OpenStreetMap Nominatim (free, rate-limited)
- **After**: Switched to Google Geocoding API for faster, more accurate US addresses
- Response format preserved for client compatibility (formatted_address + address_components)

### Server Endpoint Added
- `GET /api/config/maps-key` — exposes `GOOGLE_MAPS_API_KEY` to authenticated clients for Google Maps JS API initialization

---

## 3. Google Maps Migration — Leaflet Removal

### Components Migrated (4 files)
| Component | Location | Features |
|-----------|----------|----------|
| `LocationPickerModal.vue` | `/jobs/new` map picker | Click-to-place, address search, geolocation |
| `DriverRouteMap.vue` | Dashboard modals + driver app | Origin/dest markers, route polyline, driver position |
| `LoadsMapView.vue` | Dashboard loads map | Multiple markers, polylines, info windows |
| `TrackingMap.vue` | `/tracking` page | Real-time GPS, route snapping, driver panel, animations |

### New Composable
- **`client/src/composables/useGoogleMaps.js`**
  - `useGoogleMaps()` → `{ load, createMap }` — singleton loader, creates map instances
  - `createDotPin(color, size)` — helper for `AdvancedMarkerElement` dot icons
  - Loads API via callback parameter (`&callback=`) to ensure `google.maps.Map` is ready
  - All maps use `mapId: 'DEMO_MAP_ID'` (required for AdvancedMarkerElement)

### Packages Removed
- `leaflet` (149KB + 167KB chunks = ~316KB eliminated from bundle)
- `@vue-leaflet/vue-leaflet`

### Packages Added
- `@googlemaps/js-api-loader` (tiny, used initially then replaced with direct script tag)

### Key Technical Decisions
- **Script loading**: Replaced deprecated `new Loader()` class with direct `<script>` tag injection using `callback=` parameter
- **Markers**: Used `google.maps.marker.AdvancedMarkerElement` (not deprecated `google.maps.Marker`)
- **Custom pins**: DOM elements via `createDotPin()` instead of SVG symbol paths
- **Map reuse**: `LocationPickerModal` reuses the same map instance on re-open instead of creating new ones (prevented DOM stacking)
- **Default view**: Tracking map defaults to `roadmap` (street names visible) with satellite toggle in top-left

### Bugs Fixed During Migration
1. **Tracking map blank**: Chicken-and-egg — `initMap()` needed `mapContainer` ref which was hidden behind `v-if`. Fix: decouple `fetchLocations()` from `initMap()`, use watcher for container mount
2. **`google is not defined`**: Map options referenced `google.maps.MapTypeControlStyle` before API loaded. Fix: `await loadGoogleMaps()` before building options
3. **`Loader class deprecated`**: `@googlemaps/js-api-loader` v4 removed `Loader`. Fix: direct script tag with callback
4. **`c.Map is not a constructor`**: `loading=async` parameter caused `google.maps.Map` to be undefined on script load. Fix: use `callback=` parameter instead
5. **Map stacking**: LocationPickerModal created new map on every open. Fix: reuse existing map instance

---

## 4. New Job Page (`/jobs/new`) Enhancements

### Pickup & Drop-off Redesign
- **Location cards**: Blue header with dot for Origin/Pickup, red header with dot for Destination/Drop-off
- **Inline address search**: Type in address field → Google Places autocomplete suggestions dropdown
- **Coordinate bar**: Shows lat/lng + resolved address text
- **"Pick on Map" button**: Opens enlarged modal (900px wide, 480px tall map)

### Map Picker Improvements
- Browser geolocation on open: zooms to user's current area at street level (zoom 15)
- `flyTo()` animation when geolocation resolves
- Hybrid satellite+labels map type
- Google Geocoding API for reverse geocode (click → address)

---

## 5. shadcn-vue Installation & Dashboard Migration

### Setup
- **Dependencies installed**: `radix-vue`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-vue-next`, `typescript` (dev)
- **Configuration files created**:
  - `client/jsconfig.json` — `@/` path alias
  - `client/components.json` — shadcn-vue config
  - `client/src/lib/utils.js` — `cn()` class merge utility
  - `client/vite.config.js` — added `resolve.alias` for `@/`
- **Theme variables**: Added `@theme inline` block in `shared.css` with all shadcn color variables (primary = sky blue hsl(199 89% 48%))

### Components Installed (40 files)
| Component | Files | Used For |
|-----------|-------|----------|
| Tabs | 5 | Dashboard tab navigation |
| Badge | 2 | Status badges, tab counts |
| Button | 2 | Actions, pagination, assign |
| Dialog | 9 | Detail modals |
| Table | 9 | Load/job tables |
| Input | 2 | Search fields |
| Skeleton | 2 | Loading placeholders |
| Card | 6 | KPI cards, content wrapper, fleet cards |

### Dashboard Components Migrated (9 files)
| File | Changes |
|------|---------|
| `DashboardView.vue` | Card wrapper, Tabs/TabsList/TabsTrigger/TabsContent, Badge for counts |
| `KpiGrid.vue` | Card + CardContent wrapper |
| `JobBoardTab.vue` | Table, Input, Button, Dialog |
| `ActiveLoadsTab.vue` | Table, Input, Button (default + destructive), Dialog |
| `CompletedLoadsTab.vue` | Table, Input, Dialog |
| `FleetTab.vue` | Card, Dialog |
| `StatusBadge.vue` | Badge with color classes |
| `PaginationBar.vue` | Button (outline + default variants) |
| `SkeletonLoader.vue` | Skeleton component |

### shadcn Component Customizations
| Component | Customization |
|-----------|--------------|
| `TableHead.vue` | `text-[0.625rem] font-bold uppercase tracking-[0.08em] bg-muted/40`, padding `0.75rem 1.25rem` |
| `TableCell.vue` | `px-5 py-3.5 text-sm` |
| `TableRow.vue` | `border-border/50 hover:bg-muted/30` |
| `Badge (index.ts)` | `text-[0.6875rem] font-bold uppercase tracking-wide` |
| `Button (index.ts)` | Added `icon-xs: "size-8 text-xs"` size variant for pagination |

### Visual Consistency Fixes
- Tabs/table Card: `border-radius: 14px`, `border: 1px solid #e8edf2`, layered shadow matching KPI cards
- Tab divider: `border-bottom: 1px solid #e8edf2` matching card borders
- Active tab underline: Inline style `border-bottom: 2px solid hsl(199 89% 48%)` on text label only (not full tab button)
- Used inline styles for borders/padding where Tailwind v4 class conflicts occurred

---

## 6. Tracking Page Updates

### Map Controls
- Default map type changed from `hybrid` to `roadmap` — street names visible by default
- Added map type toggle (top-left): switch between "Map" (roadmap) and "Satellite" (hybrid)
- Uses `google.maps.MapTypeControlStyle.HORIZONTAL_BAR` control

---

## Files Modified

### Server
- `server.js` — Added `/api/config/maps-key` endpoint, switched `/api/geocode` from Nominatim to Google Geocoding API

### Frontend — New Files
- `client/jsconfig.json` — Path alias config
- `client/components.json` — shadcn-vue config
- `client/src/lib/utils.js` — cn() utility
- `client/src/composables/useGoogleMaps.js` — Google Maps loader + helpers
- `client/src/components/ui/` — 40 shadcn-vue component files (tabs, badge, button, dialog, table, input, skeleton, card)

### Frontend — Modified Files
- `client/vite.config.js` — Added `@/` resolve alias
- `client/package.json` — Added shadcn deps, removed leaflet
- `client/src/assets/shared.css` — Theme variables, removed `padding: 0` from global reset
- `client/src/views/DashboardView.vue` — Tabs, Card, Badge, styling
- `client/src/views/NewJobView.vue` — Location cards, inline address search
- `client/src/components/dashboard/KpiGrid.vue` — Card component
- `client/src/components/dashboard/JobBoardTab.vue` — Table, Input, Button, Dialog
- `client/src/components/dashboard/ActiveLoadsTab.vue` — Table, Button, Dialog, actions layout
- `client/src/components/dashboard/CompletedLoadsTab.vue` — Table, Input, Dialog
- `client/src/components/dashboard/FleetTab.vue` — Card, Dialog
- `client/src/components/dashboard/TrackingMap.vue` — Google Maps, AdvancedMarkerElement, roadmap default, toggle
- `client/src/components/dashboard/LoadsMapView.vue` — Google Maps migration
- `client/src/components/driver/DriverRouteMap.vue` — Google Maps migration
- `client/src/components/data-manager/LocationPickerModal.vue` — Google Maps, enlarged modal, geolocation, reuse map
- `client/src/components/shared/StatusBadge.vue` — shadcn Badge
- `client/src/components/shared/PaginationBar.vue` — shadcn Button
- `client/src/components/shared/SkeletonLoader.vue` — shadcn Skeleton

### Frontend — Removed Dependencies
- `leaflet` — Map rendering library
- `@vue-leaflet/vue-leaflet` — Vue 3 leaflet wrapper

---

## Technical Lessons Learned

### Tailwind CSS v4 Specificity
- Unlayered CSS (`* { padding: 0 }`) beats `@layer utilities` — Tailwind margin/padding classes silently fail
- Solution: Remove aggressive global resets, or use inline styles for critical spacing
- `border-transparent` + `border-primary` conflict in same layer — source order wins, not HTML class order
- Solution: Use inline styles for dynamic border colors

### Google Maps JS API
- `@googlemaps/js-api-loader` `Loader` class is deprecated — use `importLibrary()` or direct script tag
- `loading=async` parameter makes script.onload fire before `google.maps.Map` exists — use `callback=` parameter instead
- `AdvancedMarkerElement` requires `mapId` on the map instance
- Map instances should be reused, not recreated (prevents DOM stacking)

### shadcn-vue + Tailwind v4
- Works well together once theme variables are defined via `@theme inline`
- Component `.ts` files work in JS projects — Vite handles TypeScript transparently
- `components.json` schema doesn't accept `framework` key
- Custom sizing variants can be added to `cva` definitions (e.g., `icon-xs` for pagination)

---

## Deployment Info

- **VPS**: 76.13.22.110 (Hostinger)
- **App path**: `/var/www/logistics-app`
- **PM2 process**: `logistics-app` (id: 7)
- **Domain**: `logistics-app.abedubas.dev`
- **Deploy workflow**: `git push` → SSH: `git pull && cd client && npx vite build && pm2 restart 7`
- **Auto-deploy**: All changes committed, pushed, and deployed to VPS automatically (established in previous session)
