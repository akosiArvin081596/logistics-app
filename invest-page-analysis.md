# /invest Page — Full Codebase Analysis

**Project:** LogisX
**Route:** `/invest`
**Type:** Public investor/truck-owner onboarding wizard
**Analysis date:** 2026-04-15
**Scope:** Full vertical slice — frontend components, composables, router, backend endpoint, SQLite schema, PDF generation, email flows, admin review, and auto-provisioning.

---

## 1. Overview

`/invest` is the public entry point for prospective investor/truck-owner acquisition. It is one of only two unauthenticated surfaces in the app (the other being `/apply` for driver applications). The page is a three-step onboarding wizard that collects company information, fleet details, three legally-signed documents (Master Participation & Management Agreement, Commercial Vehicle Lease, W-9), and banking information in a single atomic submission.

On submit, the backend inserts records into five SQLite tables within a transaction, generates three signed PDFs (with embedded signatures), writes them to `/uploads/investor-onboarding-signed/`, and fires confirmation + admin notification emails asynchronously. When a Super Admin later accepts the application, the system auto-provisions an Investor user account (bcrypt-hashed temp password), an `investors` record, and one truck record per vehicle in the fleet — then sends a welcome email with login credentials.

The page has NO sidebar (`meta.noSidebar: true`), uses zero Pinia stores, persists wizard state to `localStorage` (`logisx_invest_state`) on every change, and redirects authenticated users to their role home via the router guard.

---

## 2. File Structure

### Frontend files (Vue 3 SPA)

| Path | Lines | Responsibility |
|---|---|---|
| `client/src/router/index.js` | 187 | Route definition (lines 19-24) + auth guard |
| `client/src/views/InvestorApplyView.vue` | 1,610 | Main three-step wizard view |
| `client/src/components/invest/InvestorSignModal.vue` | 291 | PDF viewer + canvas signature capture modal |
| `client/src/components/data-manager/LocationPickerModal.vue` | 288 | Google Maps address picker modal |
| `client/src/composables/useApi.js` | 18 | Fetch wrapper (get/post/put/del) — singleton |
| `client/src/composables/useToast.js` | 16 | Toast notification singleton |
| `client/src/composables/useGoogleMaps.js` | ~50 | Google Maps JS API loader |
| `client/src/composables/useGeocode.js` | 42 | Reverse geocoding + address search |
| `client/src/App.vue` | — | Conditionally renders `AppSidebar` based on `meta.noSidebar` |

**No Pinia stores are imported or used in `InvestorApplyView`.** All state is local.

### Backend files (Express)

| Path | Lines | Responsibility |
|---|---|---|
| `server.js` | ~10,500 | Single-file Express server. Relevant ranges below. |
| `lib/policy-renderer.js` | — | Renders Master Agreement + Vehicle Lease PDFs from templates |

**Relevant `server.js` ranges:**

| Range | Purpose |
|---|---|
| `879-991` | `investor_*` table CREATE TABLE statements |
| `1036-1040` | `INVESTOR_ONBOARDING_DOCS` constant (3 documents) |
| `1129-1138` | `sendEmail()` nodemailer helper |
| `1526` | `POST /api/investors/:id/profile-picture` |
| `1592` | `publicFormLimiter` rate limiter (10/15min) |
| `2054-2304` | `POST /api/public/investor-apply` — main submission endpoint |
| `2413-2538` | Public token-based onboarding endpoints |
| `2604-2657` | Public vehicles + banking + preview-pdf endpoints |
| `2710-2876` | Admin review endpoints (list, get, accept/reject) |
| `2881-3024` | Investor outreach email endpoints |
| `7180-7335` | Investor dashboard endpoints (documents, reports, tax CSV) |

### Assets

| Path | Usage |
|---|---|
| `client/public/logo.png` | Displayed in sidebar (64px) and mobile top-bar (48px) |

### Database tables written by `/invest` submission

1. `investor_applications` — main application record
2. `investor_payment_info` — banking details (1:1 FK)
3. `investor_onboarding` — onboarding status tracking (1:1 FK)
4. `investor_onboarding_documents` — 3 rows (one per signed document)

Tables created later during admin approval:

5. `users` — new Investor role user with bcrypt-hashed temp password
6. `investors` — approved investor record with business info
7. `trucks` — one truck per vehicle in the fleet (unit `INV-{appId}-{A,B,C...}`)

---

## 3. Component Tree

```
InvestorApplyView.vue  (main view — route target)
│
├── <aside class="invest-sidebar">            (290px dark sidebar — desktop only)
│   ├── <img src="/logo.png">                 (logo 64px)
│   ├── Step navigation (3 steps)
│   └── Copyright footer
│
├── <div class="mobile-topbar">               (≤768px only)
│   ├── <img src="/logo.png">                 (logo 48px)
│   ├── Mobile step dots
│   └── Step label
│
├── <main class="invest-content">             (scrollable content panel)
│   │
│   ├── Success screen                        (v-if="completed")
│   │   ├── Checkmark animation (popIn 0.5s cubic-bezier)
│   │   └── "What happens next" 3-step list
│   │
│   ├── Step 0: Application                   (v-if="step === 0")
│   │   ├── General Information section
│   │   ├── Business Profile section
│   │   └── Financial & Tax section
│   │
│   ├── Step 1: Fleet & Documents             (v-if="step === 1")
│   │   ├── Accordion: Fleet Information
│   │   │   └── Vehicle tabs (1 to N vehicles)
│   │   └── Accordion: Onboarding Documents
│   │       └── 3 document cards (opens InvestorSignModal)
│   │
│   └── Step 2: Banking                       (v-if="step === 2")
│       └── Review & Complete modal trigger
│
├── InvestorSignModal.vue                     (modal — signing)
│   ├── Props: show, doc, pdfUrl, suggestedNames
│   ├── Emits: close, signed({docKey, text, image})
│   ├── Left panel: <iframe :src="pdfUrl">    (PDF preview)
│   └── Right panel: signature capture
│       ├── Agreement checkbox
│       ├── Name input + autocomplete
│       ├── <canvas> signature drawing (pointer events)
│       └── Sign button → emit 'signed' with PNG data URL
│
├── LocationPickerModal.vue                   (modal — address selection)
│   ├── Props: open, label, initialLat, initialLng
│   ├── Emits: confirm({displayName}), close
│   ├── Uses useGoogleMaps() to load Maps JS API
│   ├── Uses useGeocode() for reverse geocoding + search
│   └── Current location button (navigator.geolocation)
│
└── Review & Complete modal                   (inline in InvestorApplyView)
    ├── Two-column summary grid
    ├── Account number masked with eye-toggle
    └── "Confirm & Complete Onboarding" → submitOnboarding()
```

### Prop/emit contracts

**`InvestorSignModal.vue`**
```
Props:
  show: Boolean               — visibility
  doc: Object                  — { doc_key, doc_name, signed, signatureText }
  pdfUrl: String               — blob URL of preview PDF
  suggestedNames: Array<String> — autocomplete source (legal_name, contact_person)

Emits:
  close                        — user closes modal without signing
  signed                       — { docKey, text, image }
                                 text: signed name (string)
                                 image: canvas.toDataURL() PNG
```

**`LocationPickerModal.vue`**
```
Props:
  open: Boolean
  label: String                — modal title (e.g. "Principal Address")
  initialLat: Number
  initialLng: Number

Emits:
  confirm                      — { displayName: String }
  close
```

---

## 4. State Management

### No Pinia stores

`InvestorApplyView.vue` imports zero Pinia stores. All state is local to the component.

### Local reactive state (script setup)

| Variable | Type | Purpose |
|---|---|---|
| `step` | `ref<Number>` | Current step (0, 1, or 2) |
| `maxStep` | `ref<Number>` | Highest step reached — used for clickable nav |
| `completed` | `ref<Boolean>` | Whether onboarding was submitted successfully |
| `submitting` | `ref<Boolean>` | In-flight submission flag |
| `form` | `reactive({...})` | Main form object (see Forms section for all fields) |
| `vehicles` | `ref<Array>` | Variable-length fleet array (1 to fleet_size) |
| `banking` | `reactive({...})` | Banking info (bank_name, account_type, routing_number, account_number, account_name) |
| `signatures` | `reactive({})` | Signature tracker — keyed by doc_key, value `{ text, image }` |
| `showMapPicker` | `ref<Boolean>` | LocationPickerModal visibility |
| `showSignModal` | `ref<Boolean>` | InvestorSignModal visibility |
| `showReviewModal` | `ref<Boolean>` | Review & Complete modal visibility |
| `activeDoc` | `ref<Object>` | Currently-open document in the sign modal |
| `pdfBlobUrl` | `ref<String>` | Blob URL of the fetched preview PDF |
| `geolocating` | `ref<Boolean>` | "Use current location" button loading state |
| `showAcctNum` | `ref<Boolean>` | Eye toggle for account number in review modal |
| `mapsApiKey` | `ref<String>` | Google Maps API key (fetched from `/api/config/maps-key`) |

### Computed properties

| Name | Purpose |
|---|---|
| `documents` | Maps `INVESTOR_ONBOARDING_DOCS` with live signed status |
| `activeModelOptions` | Filters truckModels by selected make |
| `filteredBanks` | Autocomplete filter for bank name |
| `acctNameOptions` | Autocomplete options from [legal_name, contact_person] |
| `filteredStates` | US states autocomplete filter |
| `canProceedStep1` | Step 0 validation: legal_name + address + phone + email + ein_ssn all non-empty |
| `allVehiclesValid` | Every vehicle has year && make && model && vin |
| `signedCount` | Number of documents with a signature |
| `canSubmitBanking` | All required banking fields non-empty |

### `localStorage` persistence

- **Key:** `logisx_invest_state`
- **Trigger:** Deep watchers on `form`, `vehicles`, `banking`, `signatures`, `step`, `maxStep` (lines 693-699)
- **Saved on mount restore:** `loadState()` runs in `onMounted()` (line 710)
- **Photo stripping:** Before `JSON.stringify`, vehicle photo base64 strings are cleared to avoid exceeding the 5 MB `localStorage` budget (line 662)
- **Cleared after submit:** `localStorage.removeItem(STORAGE_KEY)` on successful submission

This means a user can close the tab mid-wizard and return later without losing progress.

---

## 5. Data Flow

### Frontend — from input to submission

```
User types in an input
    ↓
v-model updates form / vehicles / banking reactive state
    ↓
Deep watcher fires → saveState() → localStorage.setItem('logisx_invest_state', ...)
    ↓
User clicks "Continue" (step 0 → 1) → submitApplication() → step = 1, maxStep = 1
    ↓
User fills fleet → clicks document card → fetchPreview() → api.get('/api/public/investor-preview-pdf/{docKey}')
    ↓
Backend renders PDF stateless → returns blob
    ↓
Frontend creates Blob URL → passes to InvestorSignModal
    ↓
User signs in canvas → emits 'signed' → signatures[docKey] = { text, image }
    ↓
All 3 docs signed → user clicks "Continue" → step = 2, maxStep = 2
    ↓
User fills banking → clicks "Review & Complete" → showReviewModal = true
    ↓
Review modal displays all data (account number masked)
    ↓
User clicks "Confirm & Complete Onboarding" → submitOnboarding()
    ↓
submitting = true
    ↓
Payload assembled (photo base64 stripped from vehicles)
    ↓
api.post('/api/public/investor-apply', payload)
```

### Backend — from request to response

```
POST /api/public/investor-apply
    ↓
publicFormLimiter (10 req/15 min per IP)
    ↓
express.json({ limit: '50mb' }) parses body
    ↓
Validation (server.js:2062-2077)
  ├─ legal_name, email, phone, address, ein_ssn required (400 if missing)
  ├─ banking.{bank_name, routing_number, account_number} required (400)
  └─ signatures must have entries for all 3 INVESTOR_ONBOARDING_DOCS (400)
    ↓
SQLite transaction BEGIN
  ├─ INSERT investor_applications (status='New', access_token=UUID)
  ├─ UPDATE investor_applications SET vehicles_json = ?, vehicle_* = first vehicle fields
  ├─ INSERT investor_payment_info (banking details)
  ├─ INSERT investor_onboarding (status='fully_onboarded')
  └─ INSERT investor_onboarding_documents × 3 (signed=1)
SQLite transaction COMMIT
    ↓
PDF generation (non-blocking, outside transaction)
  ├─ fillW9Form(appData) → pdf-lib form fill with signature overlay
  ├─ renderPolicy('master_agreement', appData) → Master Agreement PDF
  └─ renderPolicy('vehicle_lease', appData) → Vehicle Lease PDF
    ↓
Write PDFs to /uploads/investor-onboarding-signed/{docKey}-inv-{appId}-signed.pdf
    ↓
Response: { success: true, applicationId }
    ↓
(Async, after response sent)
  ├─ sendEmail to applicant — "LogisX - Investor Application Received"
  └─ sendEmail to info@logisx.com — "New Investor Application: {legal_name}"
      with 3 PDF attachments
```

### Frontend — after response

```
submitOnboarding() resolves
    ↓
completed.value = true
    ↓
localStorage.removeItem('logisx_invest_state')
    ↓
toast('Onboarding complete!', 'success')
    ↓
setTimeout 5000ms → window.location.href = 'https://logisx.com/'
    ↓
Success screen visible during countdown
```

---

## 6. Business Logic

### Step progression guards

- **Step 0 → Step 1:** `canProceedStep1` must be true. Requires `legal_name`, `address`, `phone`, `email`, `ein_ssn`. No regex validation — only non-empty check.
- **Step 1 → Step 2:** Two gates:
  - `allVehiclesValid` — every vehicle in `vehicles[]` must have `year`, `make`, `model`, `vin`
  - `signedCount === 3` — all three documents in `INVESTOR_ONBOARDING_DOCS` must be signed
- **Step 2 → Submit:** `canSubmitBanking` — `bank_name`, `routing_number`, `account_number` all non-empty.

### Signature requirements

The three documents are defined in `server.js:1036-1040`:

```javascript
const INVESTOR_ONBOARDING_DOCS = [
  { key: "master_agreement", name: "Master Participation & Management Agreement" },
  { key: "vehicle_lease", name: "Commercial Vehicle Lease Agreement" },
  { key: "w9", name: "W-9 Tax Form" },
];
```

Frontend enforces "all 3 signed" before allowing step 2. Backend re-enforces by rejecting with HTTP 400 `"Signature required for {doc.name}."` if any doc's `signature.text` is missing/empty on submission.

### Fleet sizing

`fleet_size` number input accepts 1-20. Changing it dynamically resizes the `vehicles[]` array (push/splice). Each vehicle gets a default `status: 'Active'` and `titleStatus: 'Clean'`.

### Application status lifecycle

```
Draft → New → Reviewed → Accepted
                      ↘ Rejected
```

- **Draft:** initial state (not used in `/invest` atomic flow — reserved for the token-based split flow at `/api/public/investor-onboarding/:id/*`)
- **New:** set on insert by `POST /api/public/investor-apply`
- **Reviewed:** admin marks after initial review
- **Accepted:** triggers auto-provisioning (see below)
- **Rejected:** terminal

### Auto-provisioning on Accept (`server.js:2754-2840`)

When `PUT /api/investor-applications/:id/status` is called with `{ status: 'Accepted' }`:

1. **Username generation:**
   - Base: `legal_name.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9.]/g, '')`
   - Collision handling: incrementing suffix (`company.name`, `company.name1`, `company.name2`)

2. **Temp password:**
   - Random hex → bcryptjs hash → stored in `users.password`
   - Plaintext returned once in the response for the admin to share

3. **Investor record:**
   - Inserted into `investors` table with `user_id` FK, `full_name=legal_name`, `carrier_name=dba`, and all business fields

4. **Truck records:**
   - One row per vehicle in `vehicles_json`
   - Unit numbers: `INV-{appId}-A`, `INV-{appId}-B`, ... (letters A-Z)
   - `owner_id` set to the new investor user id

5. **Welcome email** sent to applicant with username + temp password

6. **Socket.IO notifications** emitted to refresh admin dashboards:
   - `investor-applications`, `investors`, `users`, `trucks`

7. **Audit log** entry: `action=accept_investor`, `entity=investor_application`

### Rate limiting

- `publicFormLimiter` on `POST /api/public/investor-apply` — **10 submissions per 15 minutes per IP**
- No rate limiting on the preview-PDF endpoint
- No rate limiting on admin review endpoints (protected by `requireRole('Super Admin')`)

---

## 7. User Flows

### Step 0 — Application

The user lands on `/invest` and sees the dark sidebar on the left with three steps (Application, Fleet & Documents, Banking) and a light content panel on the right. The right panel shows three accordion sections:

1. **General Information** — legal name, DBA, entity type, principal address (with Google Places autocomplete + "Use Map" button opening `LocationPickerModal`), contact person, title, phone, email.
2. **Business Profile** — years in operation, industry experience (Yes/No), preferred communication (Email/Text/Phone).
3. **Financial & Tax** — tax classification, EIN or SSN, monthly reporting delivery preference.

A "Use Current Location" button on the address field uses `navigator.geolocation` and reverse geocodes the coordinates via `/api/geocode`.

User clicks **Continue** → `submitApplication()` is called → `step = 1`, `maxStep = 1`, `saveState()` persists to `localStorage`.

### Step 1 — Fleet & Documents

**Fleet Information accordion:**
- User enters fleet size (1-20)
- System dynamically creates N vehicle tabs
- Each vehicle tab requires: make (select from truckMakes), model (select from truckModels[make]), year, VIN, license plate, mileage, title state (autocomplete from 50 US states)
- Optional: vehicle photo upload (stored as base64 until submit, then stripped)
- Default values: `status='Active'`, `titleStatus='Clean'`

**Onboarding Documents accordion:**
- Shows 3 document cards with signed/pending status
- Header shows "X / 3 signed" progress
- Click a card → `openDoc(doc)` → fetches preview PDF from `/api/public/investor-preview-pdf/{docKey}` → opens `InvestorSignModal`
- In the modal:
  - Left panel: iframe showing the PDF
  - Right panel: agreement checkbox, name input with autocomplete (suggests legal_name + contact_person), canvas for drawing signature
  - User types name, draws signature, clicks Sign → emits `{docKey, text, image}` → parent stores in `signatures[docKey]`
- After signing, the document card shows a green checkmark and "Signed by {name}"

User clicks **Continue** → `step = 2`, `maxStep = 2`.

### Step 2 — Banking

User fills in:
- Bank name (autocomplete from `usBanks` array of 50+ major US banks)
- Account type (Business Checking / Personal Checking / Savings)
- Name on account (autocomplete from legal_name, contact_person)
- Routing number (9-digit)
- Account number

Under the form is a green badge: "Your banking information is encrypted and stored securely."

User clicks **Review & Complete** → `showReviewModal = true`.

The review modal displays every field from all three steps in a two-column grid, with the account number masked (`••••XXXX`) and an eye icon to toggle visibility.

User clicks **Confirm & Complete Onboarding** → `submitOnboarding()` → API call → success screen.

### Success screen

- Animated checkmark (`popIn` 0.5s cubic-bezier)
- Heading: "Onboarding Complete"
- Personalized message: "Thank you, **{legal_name}**."
- "What happens next" list:
  1. Our team will review your application within 1-2 business days
  2. You'll receive login credentials via email once approved
  3. Access your investor dashboard to track fleet performance
- After 5 seconds, `window.location.href = 'https://logisx.com/'`

---

## 8. Forms & Inputs

### Step 0 — Application fields

#### General Information

| Field | Label | Type | Required | Notes |
|---|---|---|---|---|
| `legal_name` | Legal Name (Individual or Entity) | text | ✓ | e.g. "John Doe" or "Doe Enterprises LLC" |
| `dba` | DBA | text | — | "Doing business as..." |
| `entity_type` | Entity Type | select | — | LLC, Corp, Sole Prop, Other |
| `address` | Principal Address | text | ✓ | Google Places autocomplete + map picker + geolocation |
| `contact_person` | Primary Contact Person | text | — | Full name |
| `contact_title` | Title | select | — | Owner, CEO, President, Managing Member, Partner, Manager, Director, CFO, Other |
| `phone` | Phone | tel | ✓ | (555) 123-4567 format (not enforced) |
| `email` | Email | email | ✓ | you@company.com |

#### Business Profile

| Field | Label | Type | Required | Notes |
|---|---|---|---|---|
| `years_in_operation` | Years in Operation | number | — | min=0, max=100 |
| `industry_experience` | Industry Experience | select | — | Yes, No |
| `preferred_communication` | Preferred Communication | select | — | Email, Text, Phone |

#### Financial & Tax

| Field | Label | Type | Required | Notes |
|---|---|---|---|---|
| `tax_classification` | Tax Classification | select | — | C-Corp, S-Corp, Partnership, Individual/LLC |
| `ein_ssn` | EIN or SSN | text | ✓ | XX-XXXXXXX format (not enforced) |
| `reporting_preference` | Monthly Reporting Delivery | select | — | Digital Portal, Email PDF |
| `bankruptcy_liens` | — | — | — | **Declared in reactive form but no UI field — dead code** |

### Step 1 — Fleet & Documents

#### Fleet Information

| Field | Label | Type | Required | Notes |
|---|---|---|---|---|
| `fleet_size` | Total Fleet Size (Currently Owned) | number | ✓ | 1-20. Changing it resizes vehicles[] |

#### Per-vehicle fields (in `vehicles[]` array)

| Field | Label | Type | Required | Notes |
|---|---|---|---|---|
| `make` | Make | select | ✓ | Freightliner, Kenworth, Peterbilt, Volvo, International, Mack, Western Star, Hino, Isuzu, Ford, Chevrolet, RAM, GMC, Tesla, Nikola |
| `model` | Model | select | ✓ | Filtered by selected make (`truckModels[make]`) |
| `year` | Year | number | ✓ | |
| `vin` | VIN | text | ✓ | |
| `licensePlate` | License Plate | text | — | |
| `mileage` | Mileage | text | — | |
| `titleState` | Title State | autocomplete | — | 50 US states |
| `liens` | Liens | — | — | **Declared but no UI field** |
| `registeredOwner` | Registered Owner | — | — | **Declared but no UI field** |
| `status` | Status | — | — | Default `'Active'` |
| `photo` | Photo | file | — | Base64 stored in memory; stripped from payload before submit |
| `photoName` | Photo filename | — | — | Companion to `photo` |
| `purchasePrice` | Purchase Price | number | — | |
| `titleStatus` | Title Status | — | — | Default `'Clean'` |

**Validation:** `allVehiclesValid = vehicles.every(v => v.year && v.make && v.model && v.vin)`

#### Onboarding Documents (not form fields — interactive cards)

| doc_key | doc_name | Signing required |
|---|---|---|
| `master_agreement` | Master Participation & Management Agreement | ✓ |
| `vehicle_lease` | Commercial Vehicle Lease Agreement | ✓ |
| `w9` | W-9 Tax Form | ✓ |

Clicking a card opens `InvestorSignModal` with a PDF preview. Signing produces a `{ text, image }` object stored in `signatures[docKey]`.

### Step 2 — Banking

| Field | Label | Type | Required | Notes |
|---|---|---|---|---|
| `bank_name` | Bank Name | autocomplete | ✓ | Filter over `usBanks` array |
| `account_type` | Account Type | select | — | Business Checking, Personal Checking, Savings |
| `account_name` | Name on Account | autocomplete | — | [legal_name, contact_person] |
| `routing_number` | Routing Number | text | ✓ | 9-digit (not enforced) |
| `account_number` | Account Number | text | ✓ | Masked in review modal with eye-toggle |

### Submission payload shape

```json
{
  "legal_name": "...",
  "dba": "...",
  "entity_type": "...",
  "address": "...",
  "contact_person": "...",
  "contact_title": "...",
  "phone": "...",
  "email": "...",
  "years_in_operation": "...",
  "industry_experience": "...",
  "fleet_size": "...",
  "preferred_communication": "...",
  "tax_classification": "...",
  "ein_ssn": "...",
  "bankruptcy_liens": "...",
  "reporting_preference": "...",
  "vehicles": [
    { "make": "...", "model": "...", "year": "...", "vin": "...", "licensePlate": "...", "mileage": "...", "titleState": "...", "status": "Active", "titleStatus": "Clean", ... }
  ],
  "banking": {
    "bank_name": "...",
    "account_type": "...",
    "routing_number": "...",
    "account_number": "...",
    "account_name": "..."
  },
  "signatures": {
    "master_agreement": { "text": "John Doe", "image": "data:image/png;base64,..." },
    "vehicle_lease":    { "text": "John Doe", "image": "data:image/png;base64,..." },
    "w9":               { "text": "John Doe", "image": "data:image/png;base64,..." }
  }
}
```

---

## 9. Navigation & Routing

### Route definition

`client/src/router/index.js:19-24`

```javascript
{
  path: '/invest',
  name: 'invest',
  component: () => import('../views/InvestorApplyView.vue'),
  meta: { public: true, noSidebar: true },
}
```

- **Lazy loaded** via dynamic import — not bundled with the main JS chunk
- **Public** — no auth guard, no role check
- **noSidebar** — `App.vue` conditionally hides `AppSidebar` when `route.meta.noSidebar === true`

### Router guard behavior

The `beforeEach` guard in `router/index.js` (around line 160-170) handles these cases for `/invest`:

- **Unauthenticated user** → allowed (route is public)
- **Authenticated user** → redirected to `auth.roleHome`:
  - Super Admin → `/dashboard`
  - Dispatcher → `/dashboard`
  - Driver → `/driver`
  - Investor → `/investor`
  - (prevents logged-in users from accidentally submitting a second application)

### Sub-routes, query params, redirects

- **No sub-routes.** `/invest` is a single page with internal step state managed by `step` ref.
- **No query params read.**
- **Post-submit redirect:** `window.location.href = 'https://logisx.com/'` after a 5-second delay.

### Related routes

| Route | Purpose | Relation to `/invest` |
|---|---|---|
| `/investor-applications` | Admin review UI | Super Admin reviews submitted applications here |
| `/investor` | Investor dashboard | Where approved investors land after login |
| `/investors` | Admin CRUD for investor records | Populated when an application is accepted |

---

## 10. Third-party Integrations

### Google Maps Platform

- **Loaded via:** `useGoogleMaps()` composable → `@googlemaps/js-api-loader`
- **API key source:** `GET /api/config/maps-key` (exposed endpoint)
- **Used for:**
  - Places autocomplete on the `address` field
  - `LocationPickerModal` map display + marker
  - Reverse geocoding via `/api/geocode` (server-side proxy with SQLite cache)
  - Forward geocoding via `/api/geocode/search`
- **Security note:** API key is currently unrestricted by HTTP referrer (see memory `Pending Google Cloud` — needs referrer restriction when Cloud Console access is available)

### Nodemailer / Gmail

- **Helper:** `sendEmail()` at `server.js:1129-1138`
- **Credentials:** `GMAIL_USER` + `GMAIL_APP_PASSWORD` env vars
- **Triggered twice per submission:**
  1. Applicant confirmation: "LogisX - Investor Application Received"
  2. Admin notification: `New Investor Application: {legal_name}` with 3 PDF attachments
- **Triggered again on approval:** Welcome email with login credentials
- **Error handling:** Send failures are caught and logged — do NOT block the 200 response

### pdf-lib

- **Used for:** W-9 form filling via `fillW9Form()` in `server.js`
- **Capabilities:** Fills PDF form fields (name, DBA, entity type checkboxes, address, EIN/SSN), overlays signature text, embeds signature PNG image
- **Output:** `/uploads/investor-onboarding-signed/w9-inv-{appId}-signed.pdf`

### pdfkit

- **Used for:** General PDF generation elsewhere in `server.js` (applications, invoices, onboarding documents)
- **Not directly used in `/invest`** — `pdf-lib` handles W-9, `renderPolicy` handles the other two

### `./lib/policy-renderer` (internal)

- **Exports:** `renderPolicy(docKey, appData)`
- **Used for:** Rendering Master Agreement and Vehicle Lease PDFs from templates
- **Receives:** `{ company, vehicle, banking, signature }` data object
- **Returns:** PDF buffer/stream written to `/uploads/investor-onboarding-signed/`

### express-rate-limit

- **`publicFormLimiter`** (`server.js:1592`): 10 requests per 15 minutes per IP
- **Applied to:** `POST /api/public/apply` and `POST /api/public/investor-apply`
- **Purpose:** Prevent spam/abuse of public forms

### better-sqlite3

- **Database driver** for all SQLite operations
- **Transaction support:** `db.transaction(fn)()` wraps the 5 INSERTs atomically
- **Session store:** `better-sqlite3-session-store` backs express-session

### bcryptjs

- **Used during admin approval** to hash the auto-generated temp password before inserting into `users.password`
- **Not used in `/invest` submission** — the public form never creates a user account directly

---

## 11. UI/UX Details

### Layout

- **Desktop:** Two-panel flex layout
  - Left: 290px fixed dark sidebar (`#0f2847`, `#0f172a`) with logo, step nav, footer
  - Right: flex-1 scrollable content panel (`#fff`)
- **Mobile (≤768px):**
  - Sidebar hidden
  - Mobile top-bar appears with logo + step dots + step label
  - Form grid collapses from 2-column to 1-column

### Color palette

| Purpose | Color |
|---|---|
| Dark navy (sidebar) | `#0f2847`, `#0f172a` |
| White background | `#fff`, `#fafbfd` |
| Border gray | `#e9edf3`, `#e2e8f0`, `#f1f5f9` |
| Text primary | `#0f172a` |
| Text secondary | `#64748b`, `#475569` |
| Accent blue | `#3b82f6` |
| Success green | `#22c55e`, `#16a34a` |
| Neutral gray | `#94a3b8` |

### Typography

- **Font:** `'DM Sans', system-ui, sans-serif`
- **No external font loading** — DM Sans is assumed to be loaded globally by the app

### Modals

- **`InvestorSignModal`** — full-screen, two-panel (PDF iframe + signature panel)
- **`LocationPickerModal`** — centered modal with embedded Google Map and address search
- **Review & Complete modal** — inline in `InvestorApplyView`, two-column summary grid, masked account number with eye-toggle

### Toasts

- **Composable:** `useToast()` (singleton)
- **Component:** `AppToast` (mounted globally in `App.vue`)
- **Triggered on:**
  - Success: `toast('Onboarding complete!', 'success')` (3-second timeout)
  - Error: `toast(err.message || 'Submission failed', 'error')`

### Loading states

- **`submitting` ref** disables the submit button during the API call
- **`geolocating` ref** shows a spinner on the "Use Current Location" button
- **PDF fetch** shows a brief loading state before the `InvestorSignModal` appears

### Error states

- **Client-side:** Form validation prevents step progression with disabled buttons (no inline error messages)
- **Server-side:** Errors from `api.post` are caught and shown via toast
- **Network failure:** `useApi` throws → caught in try/catch → toast + `submitting = false`

### Animations

- **`popIn` keyframe** — 0.5s cubic-bezier for success checkmark
- **Transition 0.15-0.20s** on state changes (accordion expand, button hover)
- **Smooth scroll** on step change (not explicitly coded — browser default)

### Responsive breakpoint

- **Single breakpoint at 768px** via `@media (max-width: 768px)`
- **Above 768px:** Desktop layout with sidebar
- **At or below 768px:** Mobile layout with top-bar

### Accessibility

- **Semantic HTML:** `<aside>`, `<main>`, `<nav>`, `<form>` tags used
- **ARIA:** Minimal — relies on native semantics
- **Keyboard:** Standard form navigation; canvas signature requires pointer input (not keyboard accessible)
- **Reduced motion:** Not explicitly honored

---

## 12. Auth & Permissions

### `/invest` page (frontend)

- **Public route** — no authentication required
- **Router guard** redirects already-authenticated users to `auth.roleHome`
- **No CSRF token** — relies on the endpoint being public and rate-limited

### `POST /api/public/investor-apply` (backend)

- **No `requireAuth` middleware**
- **No `requireRole` middleware**
- **Rate limited** via `publicFormLimiter` — 10 req / 15 min per IP
- **Body limit** 50 MB (set globally via `express.json({ limit: '50mb' })`)
- **No CORS configuration** (relies on same-origin for the SPA; external clients could submit)

### Admin review endpoints

| Endpoint | Middleware | Who |
|---|---|---|
| `GET /api/investor-applications` | `requireAuth`, `requireRole('Super Admin')` | Super Admin |
| `GET /api/investor-applications/:id` | `requireAuth`, `requireRole('Super Admin')` | Super Admin |
| `PUT /api/investor-applications/:id/status` | `requireAuth`, `requireRole('Super Admin')` | Super Admin |
| `POST /api/investor-outreach/send` | `requireAuth`, `requireRole('Super Admin')` | Super Admin |

### Token-based onboarding endpoints (alternative flow)

The split flow at `/api/public/investor-onboarding/:id/*` uses an `access_token` UUID stored in `investor_applications.access_token`. These endpoints validate the token against the URL parameter before allowing document signing, vehicle submission, or banking submission. This flow is NOT used by the `/invest` page (which submits atomically in one request) — it exists as a fallback for manual/partial onboarding.

### Investor user provisioning (on approval)

- **Role:** `Investor` (one of Super Admin / Dispatcher / Driver / Investor)
- **Password:** Random hex bcrypt-hashed
- **Username:** Auto-generated from `legal_name` with collision handling
- **First login:** User must change password (enforced by UI, not server)

---

## 13. Key Dependencies

### Frontend (client/package.json)

| Package | Role |
|---|---|
| `vue` ^3.x | Core framework |
| `vue-router` ^4.x | Routing |
| `pinia` ^2.x | (Not used by `/invest` — other views use it) |
| `@googlemaps/js-api-loader` | Lazy-load Google Maps JS API |
| `vant` | Mobile UI components (not used directly in `/invest`) |
| `reka-ui` / `radix-vue` | shadcn-vue primitives (not used directly in `/invest`) |

### Backend (root package.json)

| Package | Version | Role in `/invest` |
|---|---|---|
| `express` | ^4.18.2 | Web framework |
| `express-session` | ^1.19.0 | Session management (not used on public endpoint) |
| `express-rate-limit` | ^8.3.2 | `publicFormLimiter` (10 req/15min) |
| `better-sqlite3` | ^12.8.0 | SQLite client, transaction support |
| `better-sqlite3-session-store` | ^0.1.0 | SQLite-backed session store |
| `nodemailer` | ^8.0.5 | Gmail email sending |
| `pdf-lib` | ^1.17.1 | W-9 form filling + signature overlay |
| `pdfkit` | ^0.18.0 | Other PDF generation (invoices, reports) |
| `bcryptjs` | ^3.0.3 | Hash temp password on approval |
| `compression` | ^1.8.1 | gzip response compression |
| `dotenv` | ^17.3.1 | Load `GMAIL_USER`, `GMAIL_APP_PASSWORD`, etc. |
| `crypto` | (built-in) | UUID generation for `access_token` |
| `fs`, `path` | (built-in) | Write PDF files to `/uploads/` |

### Internal helpers

| File | Export | Purpose |
|---|---|---|
| `lib/policy-renderer.js` | `renderPolicy(docKey, appData)` | Master Agreement + Vehicle Lease PDF rendering |
| `server.js` (inline) | `fillW9Form(appData)` | W-9 PDF form filling via pdf-lib |
| `server.js` (inline) | `sendEmail(to, subject, html, attachments)` | Nodemailer wrapper |

---

## 14. Backend Endpoint Reference

### Public endpoints (no auth)

| Method | Path | Rate limit | Purpose |
|---|---|---|---|
| POST | `/api/public/investor-apply` | 10/15min | Atomic submission — insert app + banking + signatures + generate PDFs + emails |
| GET | `/api/public/investor-onboarding/:id` | none | Get application state (token required) |
| POST | `/api/public/investor-onboarding/:id/sign/:docKey` | none | Sign a document (token required) |
| GET | `/api/public/investor-onboarding/:id/documents/:docKey/pdf` | none | Retrieve unsigned preview PDF |
| POST | `/api/public/investor-onboarding/:id/vehicles` | none | Save vehicles JSON |
| POST | `/api/public/investor-onboarding/:id/banking` | none | Submit banking + promote Draft → New |
| POST | `/api/public/investor-preview-pdf/:docKey` | none | Stateless PDF preview for live sign modal |
| GET | `/api/config/maps-key` | none | Expose Google Maps API key to frontend |
| POST | `/api/geocode` | none | Reverse geocoding (cached) |
| POST | `/api/geocode/search` | none | Forward address search |

### Admin endpoints (Super Admin only)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/investor-applications` | List all non-Draft applications with onboarding status + signed doc count |
| GET | `/api/investor-applications/:id` | Full application details (vehicles, banking, documents) |
| PUT | `/api/investor-applications/:id/status` | Set status (New/Reviewed/Accepted/Rejected). On Accepted: auto-provision user + investor + trucks + send welcome email |
| POST | `/api/investor-outreach/send` | Send outreach emails (batch max 50) |
| GET | `/api/investor-outreach/log` | Recent outreach history (last 100) |

### Investor dashboard endpoints (Super Admin or Investor)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/investor/onboarding-documents` | Investor's signed onboarding docs |
| GET | `/api/investor/documents` | All documents for investor's drivers |
| GET | `/api/investor/tax-csv` | Download tax shield CSV |
| GET | `/api/investor/report` | Generate PDF performance report |
| GET | `/api/investor` | Aggregated financial data for investor view |
| PUT | `/api/investor/config` | Update investor view settings |

### Investor CRUD (Super Admin)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/users/investors` | List users with Investor role |
| GET | `/api/investors` | List investor records |
| POST | `/api/investors` | Create investor record |
| PUT | `/api/investors/:id` | Update investor record |
| POST | `/api/investors/:id/profile-picture` | Upload profile picture |

---

## 15. SQLite Schema Reference

### `investor_applications`

```sql
CREATE TABLE IF NOT EXISTS investor_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legal_name TEXT NOT NULL,
  dba TEXT DEFAULT '',
  entity_type TEXT DEFAULT '',
  address TEXT DEFAULT '',
  contact_person TEXT DEFAULT '',
  contact_title TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  years_in_operation TEXT DEFAULT '',
  industry_experience TEXT DEFAULT '',
  fleet_size TEXT DEFAULT '',
  preferred_communication TEXT DEFAULT '',
  tax_classification TEXT DEFAULT '',
  ein_ssn TEXT DEFAULT '',
  bankruptcy_liens TEXT DEFAULT '',
  reporting_preference TEXT DEFAULT '',
  vehicle_year TEXT DEFAULT '',
  vehicle_make TEXT DEFAULT '',
  vehicle_model TEXT DEFAULT '',
  vehicle_vin TEXT DEFAULT '',
  vehicle_mileage TEXT DEFAULT '',
  vehicle_title_state TEXT DEFAULT '',
  vehicle_liens TEXT DEFAULT '',
  vehicle_registered_owner TEXT DEFAULT '',
  access_token TEXT DEFAULT '',
  vehicles_json TEXT DEFAULT '[]',
  status TEXT DEFAULT 'Draft' CHECK(status IN ('Draft','New','Reviewed','Accepted','Rejected')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

**Denormalization note:** The `vehicle_*` columns store the FIRST vehicle from `vehicles_json` — legacy single-vehicle support that was never cleaned up when multi-vehicle support was added.

### `investor_payment_info`

```sql
CREATE TABLE IF NOT EXISTS investor_payment_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL UNIQUE,
  bank_name TEXT DEFAULT '',
  account_type TEXT DEFAULT '',
  routing_number TEXT DEFAULT '',
  account_number TEXT DEFAULT '',
  account_name TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES investor_applications(id)
)
```

### `investor_onboarding`

```sql
CREATE TABLE IF NOT EXISTS investor_onboarding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL UNIQUE,
  status TEXT DEFAULT 'documents_pending'
    CHECK(status IN ('documents_pending','banking_pending','fully_onboarded')),
  onboarded_at TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES investor_applications(id)
)
```

**Note:** The `/invest` atomic flow always sets status to `fully_onboarded` on insert. The `documents_pending` / `banking_pending` states are used by the split token-based flow.

### `investor_onboarding_documents`

```sql
CREATE TABLE IF NOT EXISTS investor_onboarding_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  doc_key TEXT NOT NULL,
  doc_name TEXT NOT NULL,
  signed INTEGER DEFAULT 0,
  signature_text TEXT DEFAULT '',
  signed_at TEXT DEFAULT '',
  signed_pdf_url TEXT DEFAULT '',
  signature_image TEXT DEFAULT '',
  UNIQUE(application_id, doc_key),
  FOREIGN KEY (application_id) REFERENCES investor_applications(id)
)
```

Three rows are inserted per application — one per `INVESTOR_ONBOARDING_DOCS` entry.

### `investors` (created on approval)

```sql
CREATE TABLE IF NOT EXISTS investors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE,
  full_name TEXT NOT NULL DEFAULT '',
  carrier_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive')),
  notes TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  entity_type TEXT DEFAULT '',
  address TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  ein_ssn TEXT DEFAULT '',
  tax_classification TEXT DEFAULT '',
  contact_person TEXT DEFAULT '',
  contact_title TEXT DEFAULT ''
)
```

**Unique index:** `idx_inv_carrier ON investors(carrier_name)`

### `investor_outreach_log`

```sql
CREATE TABLE IF NOT EXISTS investor_outreach_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  sent_by TEXT NOT NULL,
  status TEXT DEFAULT 'sent',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

### `investor_config`

```sql
CREATE TABLE IF NOT EXISTS investor_config (
  owner_id INTEGER DEFAULT 0,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(owner_id, key)
)
```

Used for per-investor dashboard view configuration (e.g., which columns to show).

---

## 16. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER AT /invest (Browser)                   │
│                                                                 │
│  Step 0: Application      Step 1: Fleet & Docs   Step 2: Bank  │
│  ┌─────────────┐          ┌─────────────┐        ┌──────────┐   │
│  │ form{...}   │ ───────→ │ vehicles[]  │ ─────→ │ banking{}│   │
│  │             │          │ signatures{}│        │          │   │
│  └──────┬──────┘          └──────┬──────┘        └────┬─────┘   │
│         │                        │                   │         │
│         └────────────────────────┴───────────────────┬┘         │
│                                                     ↓           │
│                                    localStorage: logisx_invest  │
│                                         (auto-save watcher)     │
└─────────────────────────────────────┬───────────────────────────┘
                                      │ POST /api/public/investor-apply
                                      ↓
┌─────────────────────────────────────────────────────────────────┐
│                      EXPRESS BACKEND (server.js)                │
│                                                                 │
│  publicFormLimiter (10/15min)                                   │
│       │                                                         │
│       ↓                                                         │
│  express.json({ limit: '50mb' })                                │
│       │                                                         │
│       ↓                                                         │
│  Validate: legal_name, email, phone, address, ein_ssn,          │
│            banking.{bank_name, routing_number, account_number}, │
│            signatures × 3                                       │
│       │                                                         │
│       ↓  (400 if invalid)                                       │
│  ┌────────────────────────────────────────────┐                 │
│  │  SQLite Transaction                         │                 │
│  │  ├─ INSERT investor_applications           │                 │
│  │  ├─ UPDATE investor_applications (vehicles)│                 │
│  │  ├─ INSERT investor_payment_info           │                 │
│  │  ├─ INSERT investor_onboarding             │                 │
│  │  └─ INSERT investor_onboarding_documents×3 │                 │
│  └────────────────────────────────────────────┘                 │
│       │                                                         │
│       ↓ (commit)                                                │
│  ┌────────────────────────────────────────────┐                 │
│  │  PDF Generation (non-blocking)             │                 │
│  │  ├─ fillW9Form() → w9-inv-{id}-signed.pdf │                 │
│  │  ├─ renderPolicy('master_agreement') → …  │                 │
│  │  └─ renderPolicy('vehicle_lease') → …     │                 │
│  └────────────────────────────────────────────┘                 │
│       │                                                         │
│       ↓                                                         │
│  Files saved to /uploads/investor-onboarding-signed/            │
│       │                                                         │
│       ↓                                                         │
│  Response: { success: true, applicationId }                     │
│       │                                                         │
│       ↓ (async, after response)                                 │
│  ┌────────────────────────────────────────────┐                 │
│  │  sendEmail × 2                             │                 │
│  │  ├─ applicant: "Application Received"      │                 │
│  │  └─ info@logisx.com: "New Investor App"    │                 │
│  │      + 3 PDF attachments                   │                 │
│  └────────────────────────────────────────────┘                 │
└─────────────────────────────────────┬───────────────────────────┘
                                      │ { success: true, applicationId }
                                      ↓
┌─────────────────────────────────────────────────────────────────┐
│                       BROWSER POST-SUBMIT                       │
│                                                                 │
│  completed = true                                               │
│  localStorage.removeItem('logisx_invest_state')                 │
│  toast('Onboarding complete!')                                  │
│  Success screen rendered                                        │
│  setTimeout(5000) → window.location = 'https://logisx.com/'     │
└─────────────────────────────────────────────────────────────────┘

                          . . . later . . .

┌─────────────────────────────────────────────────────────────────┐
│           ADMIN AT /investor-applications (Super Admin)        │
│                                                                 │
│  Reviews application → clicks "Accept"                         │
│                                                                 │
│  PUT /api/investor-applications/:id/status { status: 'Accepted'}│
│                                                                 │
│  ├─ Generate username (collision-safe)                          │
│  ├─ Random hex → bcryptjs.hash → temp password                  │
│  ├─ INSERT users (role='Investor')                              │
│  ├─ INSERT investors (link user_id + business info)             │
│  ├─ INSERT trucks × N (unit = INV-{appId}-{A,B,C...})           │
│  ├─ INSERT audit_trail (action='accept_investor')               │
│  ├─ Emit Socket.IO: investor-applications, investors, users,    │
│  │                   trucks                                     │
│  └─ sendEmail: "Welcome to LogisX — Your Account is Ready"      │
│                (contains username + temp password)              │
│                                                                 │
│  Response: { success, accountCreated, credentials: {            │
│    username, tempPassword, userId, investorName                 │
│  } }                                                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 17. Known Quirks & Gotchas

### Dead code: `bankruptcy_liens`

The `form.bankruptcy_liens` field is initialized in the reactive form object and submitted in the payload, but there is **no UI field** that binds to it. It always submits as empty string. Either add the input or remove the field.

### `vehicle.liens` and `vehicle.registeredOwner` — also dead

Each vehicle object initializes `liens` and `registeredOwner` but neither has a bound input. They end up in `vehicles_json` as empty strings.

### `localStorage` photo stripping

Vehicle photo base64 strings can easily exceed the 5 MB `localStorage` quota. Before every `saveState()` call, the photos are cleared from the array copy (`line 662`) — but they remain in-memory for the actual submission. If the user closes the tab and returns, photos are lost.

### Denormalized vehicle columns on `investor_applications`

The first vehicle's fields are duplicated into `vehicle_year`, `vehicle_make`, `vehicle_model`, `vehicle_vin`, `vehicle_mileage`, `vehicle_title_state`, `vehicle_liens`, `vehicle_registered_owner` — a legacy holdover from when only one vehicle was supported. The full array is also stored in `vehicles_json`. Migrations or reporting code that reads from these columns will miss vehicles 2-N.

### PDF generation errors are swallowed

If `fillW9Form()` or `renderPolicy()` throws, the error is logged to the console but the response still returns `{ success: true }`. The application is inserted but the PDFs may not exist on disk. The admin notification email will then fail to attach the missing PDFs, and the welcome flow will still work — but the investor's signed documents will be unavailable for retrieval.

### Email failures are swallowed

Both the applicant confirmation and admin notification emails are sent async after the response. Send failures are logged but never reach the user. If `GMAIL_USER` / `GMAIL_APP_PASSWORD` are misconfigured, the application insert still succeeds but nobody gets notified.

### No CORS configuration

`POST /api/public/investor-apply` has no CORS headers configured. External origins could POST to it (subject to the 10/15min rate limit). Rely on rate limiting + input validation as the only defenses.

### No phone/email/EIN format validation

Required fields are only checked for non-emptiness. A user can submit `phone: "asdf"`, `email: "not-an-email"`, and `ein_ssn: "12345"` successfully. Server-side regex validation would catch these but is not implemented.

### 5-second redirect can swallow errors

After successful submission, the success screen only shows for 5 seconds before navigating away. If the user misses the message, they have no way to confirm their application went through. The welcome email (post-approval) is the next confirmation.

### `bankruptcy_liens` column has no CHECK constraint

While `status` has a CHECK constraint, `bankruptcy_liens` accepts any string. Since it's never populated from the UI anyway, this is inert — but if you add a UI field, be aware there's no constraint.

### `/invest` does not use the token-based onboarding flow

There's a parallel set of endpoints at `/api/public/investor-onboarding/:id/*` that support a split flow (save partial state, resume later, validate step-by-step). The `/invest` page does NOT use them — it submits atomically in one request. If you see code referencing `access_token`, Draft status, or `documents_pending`/`banking_pending` states, that's the other flow.

### Authenticated users are kicked out of `/invest`

The router guard redirects already-authenticated users to their role home. This is intentional (prevents duplicate applications), but it means a logged-in Super Admin testing the form must log out first.

### Rate limit is per-IP and shared with `/apply`

The `publicFormLimiter` is shared across `/api/public/apply` (driver applications) and `/api/public/investor-apply` (investor applications). A driver application and an investor application from the same IP both count toward the same 10/15min bucket.

---

## Verification

To verify this analysis against the live codebase:

1. **Start the dev servers:**
   ```bash
   npm run dev         # Express on :3000
   npm run dev:client  # Vite on :5173
   ```

2. **Open http://localhost:5173/invest** in a browser.

3. **Walk through the wizard:**
   - Fill step 0, click Continue
   - Set fleet size to 2, fill both vehicles, sign all 3 documents, click Continue
   - Fill banking, click Review & Complete, click Confirm

4. **Inspect the database:**
   ```bash
   sqlite3 app.db 'SELECT * FROM investor_applications ORDER BY id DESC LIMIT 1;'
   sqlite3 app.db 'SELECT * FROM investor_payment_info ORDER BY id DESC LIMIT 1;'
   sqlite3 app.db 'SELECT * FROM investor_onboarding_documents ORDER BY id DESC LIMIT 3;'
   ```

5. **Check the generated PDFs:**
   ```bash
   ls -la uploads/investor-onboarding-signed/
   ```

6. **Test the admin flow:**
   - Log in as Super Admin
   - Navigate to `/investor-applications`
   - Find the test application, click Accept
   - Verify the temp password is displayed, a user/investor/truck row is created, and a welcome email is sent

---

## Appendix — Source line references

| Reference | File | Lines |
|---|---|---|
| Route definition | `client/src/router/index.js` | 19-24 |
| Main view | `client/src/views/InvestorApplyView.vue` | 1-1610 |
| Sign modal | `client/src/components/invest/InvestorSignModal.vue` | 1-291 |
| Map picker | `client/src/components/data-manager/LocationPickerModal.vue` | 1-288 |
| Submit endpoint | `server.js` | 2054-2304 |
| Validation | `server.js` | 2062-2077 |
| DB transaction | `server.js` | 2086-2128 |
| PDF generation | `server.js` | 2132-2188 |
| Email dispatch | `server.js` | 2192-2300 |
| Token-based onboarding endpoints | `server.js` | 2413-2657 |
| Admin review endpoints | `server.js` | 2710-2876 |
| Accept auto-provisioning | `server.js` | 2754-2840 |
| Outreach endpoints | `server.js` | 2881-3024 |
| `investor_*` table schemas | `server.js` | 879-991 |
| `INVESTOR_ONBOARDING_DOCS` | `server.js` | 1036-1040 |
| `sendEmail` helper | `server.js` | 1129-1138 |
| `publicFormLimiter` | `server.js` | 1592 |
| Investor dashboard endpoints | `server.js` | 7180-7335 |

---

*Generated 2026-04-15 as a static reference for the `/invest` public investor onboarding wizard. Line numbers are accurate as of commit `c6bb3ae` on branch `main`. Re-verify line ranges before relying on them for surgical edits.*
