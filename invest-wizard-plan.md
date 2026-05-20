# /invest Wizard Overlay Assistant — Implementation Plan

**Project:** LogisX
**Target surface:** `/invest` (public investor onboarding wizard)
**Feature name:** InvestWizard Overlay Assistant
**Plan date:** 2026-04-15
**Single source of truth:** `invest-page-analysis.md` (this plan cites it throughout as **IPA**)
**Output type:** Knowledge-driven guided walkthrough — **NOT an AI/LLM chatbot**

---

## 0. TL;DR

Build a floating side-panel overlay that rides on top of the existing three-step `/invest` wizard and holds the investor's hand through every field, document, and decision point. It is a deterministic state machine driven by a JSON knowledge base — no LLM calls, no inference, no network roundtrips for content. It spotlights real DOM elements via CSS overlays, reads the same reactive state the underlying page uses, and stores its own progress in `localStorage` (`logisx_wizard_state`) parallel to the page's existing `logisx_invest_state`.

A non-developer can update every piece of wizard copy by editing `client/src/wizard/knowledge-base.json` and redeploying. The wizard ships in three phases — MVP (registration walkthrough), Full (FAQ + navigation + error recovery), Polish (mobile parity, animations, accessibility audit).

---

## 1. Product Spec

### 1.1 What the wizard does

- **Guides** the investor through all three steps of `/invest` (Application → Fleet & Documents → Banking → Review) with plain-language explanations.
- **Highlights** the current field or button on the page via a spotlight overlay that darkens the rest of the page.
- **Answers** common questions from a searchable FAQ drawer ("What is EIN vs SSN?", "Can I sign later?", "How is my banking info protected?").
- **Recovers** users from stuck states by detecting validation failures and routing them to the right explainer.
- **Tracks** progress so a returning user can resume where they left off (even after a refresh or new tab).

### 1.2 Scope

**In scope:**
- Every field, button, and step in `InvestorApplyView.vue` (IPA §7, §8)
- All three signed documents (Master Agreement, Vehicle Lease, W-9) and the signature modal flow (IPA §3)
- Fleet size logic + per-vehicle field guidance (IPA §8)
- Banking safety explainer (IPA §11)
- Review modal walkthrough (IPA §7)
- Known quirks surfaced as proactive warnings (IPA §17)

**Out of scope:**
- Admin review UI at `/investor-applications` (separate audience, separate ticket)
- Post-approval investor dashboard at `/investor`
- Driver application flow at `/apply` (different form, parallel feature)
- Backend changes — wizard is frontend-only
- AI/LLM integration — explicitly rejected per prompt
- Multi-language support (English only for MVP)
- Live chat handoff to a human agent
- Analytics events (tracked separately in Phase 3)

### 1.3 User Personas

#### Persona A — First-time investor (Deshorn's target)
- Never owned a truck before, considering LogisX as a passive income vehicle
- Intimidated by legal documents and banking fields
- Needs: plain-language explanations, reassurance, estimated time to complete
- Behavior: opens wizard immediately on landing, follows every step, reads every tooltip
- Success: completes application end-to-end without abandoning

#### Persona B — Experienced fleet owner
- Already runs 1-5 trucks somewhere else, wants to move a vehicle to LogisX
- Familiar with W-9, EIN, VIN, lease agreements
- Needs: fast path, skip explainers, quick access to document preview
- Behavior: dismisses wizard on landing, opens it only when stuck (e.g. "what format should routing number be in?")
- Success: completes application in <5 minutes

#### Persona C — Confused visitor
- Came from an ad or referral, not sure what this page is or if they should fill it out
- Needs: "what is this?" overview, "what happens after I submit?" explainer, escape hatch to the marketing site
- Behavior: opens wizard for context, never finishes the form
- Success: understands what `/invest` is, leaves with a positive impression

#### Persona D — Returning abandoner
- Started the form yesterday, got stuck on documents or banking, left the tab open
- Needs: "where was I?" resume prompt, "why did I stop?" reminder
- Behavior: reopens the tab → sees resume banner → clicks continue
- Success: finishes what they started (leverages the existing `logisx_invest_state` persistence from IPA §4)

### 1.4 Entry points

1. **Auto-show on first visit** — wizard opens automatically on the first visit if no `logisx_wizard_state` entry exists in localStorage. Shows a welcome screen with "Start tour" / "I'll do it myself" buttons.
2. **Floating help button** — always-visible circular "?" button in the bottom-right corner (above the LogisX footer). Clicking toggles the wizard panel.
3. **Contextual trigger** — if the user attempts to click "Continue" with validation errors, a toast appears: "Need help? Open the guide." Clicking it opens the wizard to the relevant step.
4. **Deep link** — `/invest?guide=1` forces the wizard open on load. Useful for support links ("click here for a guided walkthrough").
5. **Resume prompt** — if `logisx_wizard_state.step > 0` and the user returns to `/invest`, a banner appears: "Resume your guided tour from Step 2?"

### 1.5 Exit points

1. **Dismiss (X button)** — closes the wizard but keeps state. User can reopen via the floating help button.
2. **"I'll do it myself"** — dismisses and sets a `dismissed: true` flag to suppress auto-open for this session. Help button still available.
3. **"Reset guide"** — in the wizard settings, clears `logisx_wizard_state` and restarts from step 0.
4. **Completion** — when the user submits the form successfully, the wizard shows a final "You did it!" screen and auto-hides after 3 seconds (leaving the underlying success screen visible).
5. **Navigate away** — leaving the `/invest` page unmounts the wizard entirely.

### 1.6 Non-goals

- The wizard must **never** block form submission. It is a helper, not a gatekeeper. The user can always close it and proceed without guidance.
- The wizard must **never** submit the form on the user's behalf. It can only point at the submit button and explain what will happen.
- The wizard must **never** store or transmit form data itself. It reads from the parent's reactive state for decision-making only.

---

## 2. User Flows

Every flow below traces to actual components and state from **IPA**. Step labels reference the parent page's steps: Step 0 = Application, Step 1 = Fleet & Documents, Step 2 = Banking, Review = Review modal.

### 2.1 Registration flow (end-to-end)

This is the primary happy path. Each wizard node maps to one or more fields from IPA §8.

```
WELCOME → OVERVIEW → LEGAL_BASICS → ENTITY_TYPE → ADDRESS_HELP →
CONTACT_INFO → BUSINESS_PROFILE → TAX_DETAILS → STEP0_REVIEW →
[USER CLICKS CONTINUE] →
FLEET_SIZE → VEHICLE_1_INTRO → VEHICLE_1_MAKE → VEHICLE_1_MODEL →
VEHICLE_1_YEAR → VEHICLE_1_VIN → VEHICLE_1_DETAILS →
[IF fleet_size > 1] → VEHICLE_N_LOOP →
DOCS_INTRO → MASTER_AGREEMENT → VEHICLE_LEASE → W9_FORM →
[USER CLICKS CONTINUE] →
BANKING_INTRO → BANK_NAME → ACCOUNT_TYPE → ROUTING_NUMBER →
ACCOUNT_NUMBER → BANKING_SECURITY_NOTE →
[USER CLICKS REVIEW] →
REVIEW_WALKTHROUGH → SUBMIT_CONFIRMATION → COMPLETION
```

#### Decision points

| Node | Condition | Branch |
|---|---|---|
| `ENTITY_TYPE` | user picks "Individual/LLC" | go to `EIN_OR_SSN_CHOICE` explainer |
| `ENTITY_TYPE` | user picks "Corp" or "LLC" | go to `EIN_REQUIRED` (skip SSN hint) |
| `FLEET_SIZE` | size > 5 | show `LARGE_FLEET_WARNING` (validate limit, suggest contact) |
| `FLEET_SIZE` | size == 1 | skip `VEHICLE_N_LOOP`, go straight to `DOCS_INTRO` |
| `MASTER_AGREEMENT` | already signed | mark complete, skip to next doc |
| `DOCS_INTRO` | all 3 signed already (resume case) | skip to `BANKING_INTRO` |
| `BANK_NAME` | bank not in autocomplete | show `CUSTOM_BANK_WARNING` |
| `REVIEW_WALKTHROUGH` | validation gate fails | route to the failing field's wizard node |

### 2.2 FAQ flow

The FAQ drawer is triggered from:
- The floating help button's "Ask a question" tab
- Any wizard node that embeds a "Still confused?" link
- A search box in the main wizard panel

FAQ entries are **keyed by field or concept**, not by step number, so they survive step re-ordering.

#### MVP FAQ categories

1. **About LogisX** — "What is LogisX?", "What does it mean to be an investor here?", "How do I get paid?", "How is this different from Uber for trucks?"
2. **The application process** — "How long does this take?", "Can I save and resume?" (answer: yes, auto-saves), "What happens after I submit?", "How long until I hear back?"
3. **Legal & identity** — "What is EIN vs SSN?", "Do I need to be a US citizen?", "What if I don't have a DBA?", "What does Entity Type mean?"
4. **Fleet & vehicles** — "What if my truck is leased?", "Do I need to own the truck outright?", "What if I don't know my VIN?", "Can I add more trucks later?"
5. **Documents** — "What am I signing?", "Is this legally binding?", "Can I download a copy?", "What if I disagree with a clause?"
6. **Banking** — "Why do you need my bank info?", "Is this secure?", "How often do I get paid?", "Can I change my banking info later?"
7. **Troubleshooting** — "The continue button is greyed out", "I can't upload a photo", "The map isn't loading", "I accidentally signed with the wrong name"

### 2.3 Navigation flow

The wizard can **jump** the user to any section, not just walk linearly. Triggered via:
- A mini sitemap inside the wizard panel (3 pills: Application / Fleet & Docs / Banking)
- Clicking a step in the page's existing sidebar (wizard listens for click and re-syncs)
- Keyboard: `Ctrl+1/2/3` while the wizard is open

Navigation flow nodes:
- `OVERVIEW_MAP` — shows all three steps at a glance with completion checkmarks
- `STEP_NAVIGATION_EXPLAINER` — "You can click any completed step to revisit it"
- `FIELD_FINDER` — free-text search that matches field labels and jumps to the matching field

### 2.4 Error recovery flow

Triggered when the wizard detects a stuck state. Detection strategies:

1. **Validation gate failure** — user clicks a disabled Continue button (wizard observes `canProceedStep1` / `allVehiclesValid` / `canSubmitBanking` via the parent component's exposed ref)
2. **Field idle timeout** — user focuses a field, types nothing for 60 seconds, wizard offers help
3. **Repeated delete-retype** — user types and deletes the same field 3+ times in 30s
4. **External signal** — the parent emits a custom event `invest:error` with `{ field, reason }`

Recovery flow:
```
DETECTED_STUCK_STATE
  → wizard panel pulses gently
  → "Looks like you're stuck on [field]. Want help?"
  → user clicks "Show me"
  → wizard opens to the relevant field's explainer node
  → explainer shows: what the field means, example values, common mistakes
  → user fixes → validation passes → wizard returns to linear flow
```

### 2.5 Resume flow

```
PAGE LOAD
  → read logisx_invest_state (existing parent persistence)
  → read logisx_wizard_state (new, from this wizard)
  → if wizard_state.step > 0 and !wizard_state.completed
      → show "Welcome back!" banner with "Continue from Step X" button
  → user clicks continue → wizard jumps to the saved node
```

Resume state is invalidated if:
- The parent's `logisx_invest_state` is missing (user cleared browser data)
- The parent's `step` value is earlier than the wizard's saved step (user rewound)
- More than 30 days have passed since last save (stale abandonment)

---

## 3. Wizard Steps Blueprint

Each step has the shape:

```json
{
  "id": "STEP_ID",
  "title": "Short title",
  "body": "Plain-language explanation (≤80 words)",
  "target": "CSS selector of the element to spotlight",
  "action": "info | input | click | select | wait",
  "highlight": "spotlight | pulse | arrow | none",
  "next": "NEXT_STEP_ID or conditional object",
  "canSkip": true,
  "faqLinks": ["FAQ_KEY_1", "FAQ_KEY_2"],
  "enterCondition": "optional JS-safe expression",
  "exitCondition": "optional expression to auto-advance"
}
```

Below is the full node catalog grouped by phase of the parent page.

### 3.1 Entry/Welcome nodes

| ID | Title | Target | Action | Notes |
|---|---|---|---|---|
| `WELCOME` | Welcome to LogisX investing | `.invest-page` | info | Opens on auto-show |
| `OVERVIEW` | 3 steps, ~10 minutes | `.invest-sidebar` | info | Spotlights the sidebar step list |
| `STEP_NAV_EXPLAINER` | Click any completed step to jump back | `.sidebar-step.done` | info | Only shows after user completes step 0 |

### 3.2 Step 0 — Application nodes

Map source: **IPA §8 — Step 0 fields**

| ID | Title | Target | Action | Field from IPA §8 | Notes |
|---|---|---|---|---|---|
| `LEGAL_BASICS` | Your legal name | `input[v-model="form.legal_name"]` | input | `legal_name` | Explains individual vs entity |
| `DBA_OPTIONAL` | Do you have a DBA? | `input[v-model="form.dba"]` | input | `dba` | "Doing Business As" — skip if N/A |
| `ENTITY_TYPE` | What type of business? | `select[v-model="form.entity_type"]` | select | `entity_type` | Branches to `EIN_OR_SSN_CHOICE` |
| `ADDRESS_HELP` | Principal business address | `input[v-model="form.address"]` | input | `address` | Explains map picker + geolocation buttons |
| `MAP_PICKER_INTRO` | Or pin it on a map | `.map-picker-btn` | click | — | Highlights the map-picker button |
| `CONTACT_PERSON` | Primary contact | `input[v-model="form.contact_person"]` | input | `contact_person` | |
| `CONTACT_TITLE` | Their role | `select[v-model="form.contact_title"]` | select | `contact_title` | |
| `PHONE_EMAIL` | How we'll reach you | `input[v-model="form.phone"]` | input | `phone`, `email` | Single node covering both |
| `YEARS_EXP` | Years in operation | `input[v-model="form.years_in_operation"]` | input | `years_in_operation` | Zero is fine for first-timers |
| `INDUSTRY_EXP` | Industry experience? | `select[v-model="form.industry_experience"]` | select | `industry_experience` | |
| `COMM_PREF` | How should we contact you? | `select[v-model="form.preferred_communication"]` | select | `preferred_communication` | |
| `TAX_CLASS` | Tax classification | `select[v-model="form.tax_classification"]` | select | `tax_classification` | |
| `EIN_OR_SSN` | EIN or SSN | `input[v-model="form.ein_ssn"]` | input | `ein_ssn` | Links to FAQ `ein_vs_ssn` |
| `REPORT_PREF` | How should we send reports? | `select[v-model="form.reporting_preference"]` | select | `reporting_preference` | |
| `STEP0_REVIEW` | Ready to continue? | `.continue-btn` | click | — | Confirms before moving to Step 1 |

### 3.3 Step 1 — Fleet & Documents nodes

Map source: **IPA §8 — Step 1 fields + documents**

| ID | Title | Target | Action | Field / Doc | Notes |
|---|---|---|---|---|---|
| `FLEET_INTRO` | Tell us about your fleet | `.accordion-fleet` | info | — | |
| `FLEET_SIZE` | How many trucks? | `input[v-model="form.fleet_size"]` | input | `fleet_size` | Explains 1-20 limit |
| `LARGE_FLEET_WARNING` | Fleets over 5 | (banner) | info | — | Conditional: only if fleet_size > 5 |
| `VEHICLE_TAB_NAV` | One tab per truck | `.vehicle-tabs` | info | — | Explains the tab UI |
| `VEHICLE_MAKE` | What make? | `select[v-model="vehicles[i].make"]` | select | `make` | Loop per vehicle |
| `VEHICLE_MODEL` | What model? | `select[v-model="vehicles[i].model"]` | select | `model` | Depends on make |
| `VEHICLE_YEAR` | Year | `input[v-model="vehicles[i].year"]` | input | `year` | |
| `VEHICLE_VIN` | VIN (17 chars) | `input[v-model="vehicles[i].vin"]` | input | `vin` | FAQ: "where do I find my VIN?" |
| `VEHICLE_PLATE` | License plate | `input[v-model="vehicles[i].licensePlate"]` | input | `licensePlate` | |
| `VEHICLE_MILES` | Current mileage | `input[v-model="vehicles[i].mileage"]` | input | `mileage` | |
| `VEHICLE_STATE` | Title state | `input[v-model="vehicles[i].titleState"]` | input | `titleState` | Autocomplete explainer |
| `VEHICLE_PHOTO` | Photo (optional) | `.vehicle-photo-upload` | info | `photo` | Warns about the localStorage quirk |
| `DOCS_INTRO` | Time to sign 3 documents | `.accordion-documents` | info | — | |
| `MASTER_AGREEMENT_OPEN` | Open the Master Agreement | `.doc-card[data-doc-key="master_agreement"]` | click | — | Opens InvestorSignModal |
| `SIGN_MODAL_EXPLAINER` | How signing works | `.invest-sign-modal` | info | — | Spotlights the PDF + canvas |
| `SIGN_CHECKBOX` | Agree to the terms | `.sign-agreement-checkbox` | click | — | |
| `SIGN_NAME_INPUT` | Type your name | `.sign-name-input` | input | — | |
| `SIGN_CANVAS` | Draw your signature | `.sign-canvas` | input | — | |
| `SIGN_SUBMIT` | Click Sign | `.sign-submit-btn` | click | — | |
| `VEHICLE_LEASE_OPEN` | Next: Vehicle Lease | `.doc-card[data-doc-key="vehicle_lease"]` | click | — | |
| `W9_OPEN` | Last: W-9 tax form | `.doc-card[data-doc-key="w9"]` | click | — | |
| `STEP1_REVIEW` | Ready for banking? | `.continue-btn` | click | — | Gated on `allVehiclesValid && signedCount == 3` |

### 3.4 Step 2 — Banking nodes

Map source: **IPA §8 — Step 2 Banking fields**

| ID | Title | Target | Action | Field | Notes |
|---|---|---|---|---|---|
| `BANKING_INTRO` | Your payout account | `.banking-section` | info | — | Reassures about encryption |
| `BANK_NAME` | Your bank | `input[v-model="banking.bank_name"]` | input | `bank_name` | |
| `CUSTOM_BANK_WARNING` | Bank not listed? | (banner) | info | — | Conditional if user types custom text |
| `ACCOUNT_TYPE` | Checking or savings? | `select[v-model="banking.account_type"]` | select | `account_type` | |
| `ACCOUNT_NAME` | Name on account | `input[v-model="banking.account_name"]` | input | `account_name` | |
| `ROUTING_NUMBER` | Routing number (9 digits) | `input[v-model="banking.routing_number"]` | input | `routing_number` | FAQ: "where do I find it?" |
| `ACCOUNT_NUMBER` | Account number | `input[v-model="banking.account_number"]` | input | `account_number` | |
| `BANKING_SECURITY` | How we protect it | `.banking-security-note` | info | — | |
| `REVIEW_OPEN` | Review everything | `.review-complete-btn` | click | — | |

### 3.5 Review & submission nodes

| ID | Title | Target | Action | Notes |
|---|---|---|---|---|
| `REVIEW_WALKTHROUGH` | Double-check your info | `.review-modal` | info | |
| `REVIEW_MASKED_ACCOUNT` | Account number is hidden | `.masked-account-eye` | info | Eye-toggle explainer |
| `SUBMIT_CONFIRM` | Ready to submit? | `.confirm-submit-btn` | click | |
| `SUBMITTING_STATE` | Submitting now... | (full overlay) | wait | Locks wizard until response |
| `COMPLETION` | You're all done! | `.success-check` | info | Congratulates, explains next steps |
| `POST_SUBMIT_REDIRECT` | Redirecting in 5 seconds | (banner) | info | Wizard auto-hides after this |

### 3.6 Decision tree summary

```
ENTITY_TYPE = "Sole Prop" | "Individual/LLC"
   ↓
EIN_OR_SSN_CHOICE → shows SSN-OK explainer
ELSE
   ↓
EIN_REQUIRED → shows "EIN required for entities"

FLEET_SIZE > 5
   ↓
LARGE_FLEET_WARNING → "We cap at 20; consider contacting us for 6+"
ELSE IF FLEET_SIZE == 1
   ↓
Skip VEHICLE_2_LOOP entirely

All 3 signatures present on resume
   ↓
Skip DOCS_INTRO → BANKING_INTRO

Validation fails on STEP0_REVIEW
   ↓
Route to first empty required field's explainer node
```

---

## 4. Knowledge Base Structure

### 4.1 File layout

```
client/src/wizard/
├── index.js                       # Entry — exports loaders + validators
├── engine/
│   ├── WizardEngine.js            # State machine driver
│   ├── stepResolver.js            # Evaluates next-step conditions
│   ├── spotlight.js               # DOM highlight utility
│   └── eventBus.js                # Listens for parent events
├── data/
│   ├── knowledge-base.json        # Single source of truth for all copy
│   ├── schema.json                # JSON Schema for validation at build time
│   └── faq.json                   # Split out for easier editing
└── components/
    ├── InvestWizardOverlay.vue    # Root wizard component
    ├── WizardPanel.vue            # Right-side drawer
    ├── WizardSpotlight.vue        # Dimming + cutout for target element
    ├── WizardFab.vue              # Floating "?" help button
    ├── WizardResumeBanner.vue     # "Welcome back!" banner
    └── WizardFaqDrawer.vue        # FAQ accordion
```

### 4.2 `knowledge-base.json` shape

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-04-15",
  "steps": {
    "WELCOME": {
      "title": "Welcome to LogisX investing",
      "body": "We'll walk you through the 3 steps to become a truck owner on LogisX. This usually takes about 10 minutes. You can pause anytime — your progress saves automatically.",
      "target": ".invest-page",
      "action": "info",
      "highlight": "none",
      "next": "OVERVIEW",
      "canSkip": true,
      "faqLinks": ["what_is_logisx", "how_long_does_this_take"]
    },
    "LEGAL_BASICS": {
      "title": "Your legal name",
      "body": "Use the exact name on your ID or business filing. If you're an individual, use 'First Last'. If you're a company, use the full legal entity name.",
      "target": "input[v-model='form.legal_name']",
      "action": "input",
      "highlight": "spotlight",
      "next": "DBA_OPTIONAL",
      "examples": ["John Smith", "Doe Enterprises LLC"],
      "faqLinks": ["what_if_no_dba"]
    }
    // ... every other step
  },
  "faqs": {
    "what_is_logisx": {
      "q": "What is LogisX?",
      "a": "LogisX is a trucking logistics company. As an investor, you lease your truck(s) to us. We handle dispatch, loads, insurance, and paperwork. You get monthly payouts based on your truck's earnings."
    },
    "ein_vs_ssn": {
      "q": "What's the difference between EIN and SSN?",
      "a": "EIN (Employer Identification Number) is for businesses. SSN (Social Security Number) is for individuals. If you're filing as an LLC or Corp, you need an EIN. If you're a sole proprietor or individual, your SSN is fine."
    }
    // ... 50-80 entries for MVP
  },
  "tooltips": {
    "form.legal_name": "Your exact legal name — must match your tax filing",
    "form.ein_ssn": "9 digits, with or without dashes",
    "banking.routing_number": "9 digits on the bottom-left of your check"
    // ... one per field
  },
  "errorExplanations": {
    "canProceedStep1_failed": {
      "plain": "You need to fill in all the required fields before continuing.",
      "required": ["legal_name", "address", "phone", "email", "ein_ssn"],
      "helpNode": "STEP0_REVIEW_ERRORS"
    },
    "allVehiclesValid_failed": {
      "plain": "Every truck needs a year, make, model, and VIN.",
      "helpNode": "VEHICLE_REQUIRED_FIELDS"
    },
    "signedCount_failed": {
      "plain": "All 3 documents need to be signed before you can submit.",
      "helpNode": "DOCS_INTRO"
    }
  }
}
```

### 4.3 Editability model

**Primary editor: non-developer content author**

1. Clone the repo (or use a CMS UI in Phase 3 — out of MVP scope)
2. Open `client/src/wizard/data/knowledge-base.json`
3. Edit the relevant step / FAQ / tooltip text
4. Run `npm run validate:wizard` (calls a validator against `schema.json`)
5. Commit and push — CI deploys

**Build-time validation** (new npm script):

```
// package.json additions
"scripts": {
  "validate:wizard": "node scripts/validate-wizard-kb.js",
  "prebuild": "npm run validate:wizard"
}
```

The validator checks:
- Every referenced `next` step ID exists in `steps`
- Every referenced `faqLinks` ID exists in `faqs`
- Every `target` CSS selector matches a regex of known patterns (prevents typos)
- Every `body` is ≤ 300 characters
- JSON Schema conformance

### 4.4 Tooltip/help text governance

Each field in **IPA §8** gets exactly one tooltip entry. Maintained in sync via a linter that walks `InvestorApplyView.vue`, extracts every `v-model="form.X"` / `v-model="banking.X"`, and asserts a matching `tooltips["form.X"]` key exists in the knowledge base.

### 4.5 Error message explanations

Three error surfaces:

1. **Validation gate failures** (`canProceedStep1`, `allVehiclesValid`, `canSubmitBanking`) — each gets an `errorExplanations` entry keyed by the gate name.
2. **Server errors** from `POST /api/public/investor-apply` — indexed by error string prefix. Examples:
   - `"Please fill in all required fields."` → `server_missing_required`
   - `"Banking information is required."` → `server_missing_banking`
   - `"Signature required for..."` → `server_missing_signature`
3. **Network errors** (timeout, 500, etc.) — single generic "Network hiccup" explainer with retry guidance.

---

## 5. UI/UX Design Spec

### 5.1 Overlay positioning

**Desktop (>1024px):**
- Right-side drawer, 380px wide, full height minus 24px top/bottom padding
- Slides in from right on open, slides out on dismiss
- Non-blocking — the underlying page remains interactive when the wizard is in "passive" mode
- When spotlighting a field, a semi-transparent dim layer covers the rest of the page with a cutout around the target

**Tablet (768px–1024px):**
- Bottom-sheet — full width, 50% height, slides up from bottom
- Spotlight still works; dim layer covers everything above the sheet

**Mobile (<768px):**
- Full-screen modal with close button
- Wizard steps take over the viewport; user must close the wizard to interact with the page
- Spotlight still shown but appears briefly before hiding so the user can tap the highlighted field

### 5.2 Structure of the wizard panel (desktop)

```
┌─────────────────────────────┐
│ [X]  LogisX Guide       [≡] │  ← header with close + menu
├─────────────────────────────┤
│ Step 3 of 27                │  ← progress indicator
│ ████████░░░░░░░ 30%         │  ← progress bar
├─────────────────────────────┤
│                             │
│ 📍 Your legal name          │  ← step title
│                             │
│ Use the exact name on your  │  ← step body
│ ID or business filing...    │
│                             │
│ Examples:                   │
│  • John Smith               │
│  • Doe Enterprises LLC      │
│                             │
│ ┓ Still confused?           │  ← FAQ link
│                             │
├─────────────────────────────┤
│ [ Back ]  [  Skip  ]  [ Next ] │  ← action bar
└─────────────────────────────┘
```

### 5.3 Progress indicator

- Three large step pills at the top: **Application | Fleet & Docs | Banking**
- Sub-step counter: "Step N of M within the current parent step"
- Overall percentage based on total node count (not step count, since nodes vary per step)
- Color coding: completed (green), current (blue), future (grey)

### 5.4 Spotlight mechanism

Implementation:
- `WizardSpotlight.vue` renders a full-screen `<svg>` with a `<mask>` cutout
- The cutout is a rectangle positioned via `getBoundingClientRect()` of the target element
- A pulsing ring animation (`@keyframes pulse-ring`) draws attention
- On scroll or resize, a `ResizeObserver` + `scroll` listener reposition the cutout
- Fallback: if the target isn't found (element removed or hidden), show the panel without the spotlight and log a console warning

Spotlight variants:
- **spotlight** — dim background + cutout
- **pulse** — no dim, just a pulsing ring around the target
- **arrow** — animated arrow pointing at the target from the panel
- **none** — no visual cue, just panel text (for info nodes with no specific target)

### 5.5 Mobile behavior

- Tap the floating "?" FAB → full-screen wizard opens
- Back button closes the wizard (intercepted via `popstate` event, pushes a dummy history entry on open)
- Swipe down to dismiss
- Spotlight flashes for 800ms, then fades so the user can interact with the field
- "Continue" button on each step auto-closes the wizard, lets the user fill the field, then re-opens on the next action

### 5.6 Animations & transitions

Keep it lightweight — all motion via CSS transforms, no JS tweening:

| Element | Animation | Duration |
|---|---|---|
| Panel open | `transform: translateX(100%) → 0` | 300ms ease-out |
| Panel close | reverse | 200ms ease-in |
| Spotlight appear | `opacity: 0 → 1` | 250ms |
| Spotlight cutout | `transition: all 300ms` on position/size | 300ms |
| Pulse ring | `@keyframes pulse-ring` infinite | 1.5s loop |
| Progress bar | `width` transition | 400ms ease |
| FAQ drawer | slide down | 200ms |

**Respect `prefers-reduced-motion`:** disable all transitions when the media query matches.

### 5.7 Accessibility

- **Keyboard navigation:**
  - `Tab` cycles through wizard controls
  - `Esc` closes the wizard
  - `Enter` on Next/Back advances
  - `Ctrl+1/2/3` jumps to parent steps
  - `/` opens the FAQ search
- **Screen readers:**
  - Root element has `role="dialog"` and `aria-modal="false"` (non-blocking)
  - `aria-labelledby` points to the step title
  - `aria-live="polite"` on the body text so step changes are announced
  - Spotlight has `aria-hidden="true"` (visual affordance only)
- **Focus management:**
  - On open, focus moves to the Next button
  - On close, focus returns to the trigger (FAB or contextual link)
  - If the wizard auto-advances on an input change, focus stays on the input
- **Contrast:** all text meets WCAG AA against its background
- **Motion:** all animations honor `prefers-reduced-motion`
- **Target size:** Next/Back buttons are ≥ 44×44 pixels on touch devices

---

## 6. Technical Architecture

### 6.1 Where it lives in the codebase

```
client/src/
├── views/
│   └── InvestorApplyView.vue    ← modified to mount the wizard
└── wizard/                       ← NEW directory (see §4.1)
    ├── components/
    ├── engine/
    └── data/
```

**Zero changes to `server.js`.** This is a frontend-only feature.

### 6.2 Component structure

```
InvestorApplyView.vue (existing, modified minimally)
│
└── <InvestWizardOverlay
      :page-step="step"
      :max-step="maxStep"
      :form="form"
      :vehicles="vehicles"
      :banking="banking"
      :signatures="signatures"
      :completed="completed"
      @jump-to="handleWizardJump"
    />
```

`InvestWizardOverlay.vue` composes:
- `<WizardFab />` — the floating help button (always visible)
- `<WizardPanel />` — the side drawer (visible when `open === true`)
- `<WizardSpotlight />` — the dim + cutout (visible when step has a target)
- `<WizardResumeBanner />` — the resume prompt (visible once on mount if resume conditions met)
- `<WizardFaqDrawer />` — the FAQ accordion (visible when user opens FAQ tab)

### 6.3 State management approach

**No Pinia store.** Keep the wizard state local to `InvestWizardOverlay.vue` — the feature is small enough that a Pinia store would be overkill, and the existing `/invest` page uses no stores (IPA §4), matching the local-only pattern.

State shape (Vue 3 `reactive`):

```javascript
const wizardState = reactive({
  open: false,
  currentStepId: 'WELCOME',
  history: [],             // breadcrumb stack for Back button
  completed: false,
  dismissed: false,        // session-level "leave me alone" flag
  faqOpen: false,
  faqSearch: '',
  spotlightRect: null,     // { x, y, width, height } of current target
});
```

Persisted subset (to `localStorage` key `logisx_wizard_state`):

```javascript
{
  currentStepId: "VEHICLE_VIN",
  history: ["WELCOME", "OVERVIEW", ...],
  completed: false,
  dismissed: false,
  lastSavedAt: "2026-04-15T20:30:00Z"
}
```

### 6.4 Interaction with the existing `/invest` page

**One-way data flow: parent → wizard.** The wizard receives props from `InvestorApplyView.vue` but never writes back to the parent's form state.

The wizard reads:
- `step`, `maxStep` — to know which parent step the user is on
- `form`, `vehicles`, `banking`, `signatures` — for decision logic (e.g. "is this field filled?", "is this doc signed?")
- `completed` — to trigger the completion node

The wizard emits:
- `@jump-to` with a step ID, when the user clicks a parent sidebar step via a wizard shortcut (parent handles by setting `step = n`)
- `@focus-field` with a field name, when the wizard wants to move caret into a field (parent calls `inputRef.focus()`)

The parent exposes a minimal API via `defineExpose`:

```javascript
// In InvestorApplyView.vue
defineExpose({
  focusField(fieldName) { /* ref-based focus */ },
  openDoc(docKey) { /* opens InvestorSignModal for the doc */ },
  jumpToStep(n) { step.value = n }
});
```

### 6.5 Data structure for steps and KB

See **§4.2** for the full JSON shape. Runtime representation:

```typescript
type WizardStep = {
  id: string;
  title: string;
  body: string;
  target: string | null;
  action: 'info' | 'input' | 'click' | 'select' | 'wait';
  highlight: 'spotlight' | 'pulse' | 'arrow' | 'none';
  next: string | Array<{ when: string; goto: string }>;
  canSkip: boolean;
  examples?: string[];
  faqLinks?: string[];
  enterCondition?: string;
  exitCondition?: string;
};
```

Conditions use a **safe expression language** — not `eval`. A tiny whitelist-based evaluator that supports:
- `field.X` — reads `form.X` from parent
- `vehicles.length`, `vehicles[i].field`
- `signatures.key.signed`
- `==`, `!=`, `>`, `<`, `>=`, `<=`, `&&`, `||`, `!`

Example:
```json
"next": [
  { "when": "field.entity_type == 'Sole Prop'", "goto": "EIN_OR_SSN_CHOICE" },
  { "goto": "EIN_REQUIRED" }
]
```

A minimal expression evaluator (~60 lines) parses these into an AST and walks it with a locked-down scope. No prototype access, no function calls.

### 6.6 Editability for non-developers

**Phase 1 (MVP):** edit `knowledge-base.json` directly, validate via `npm run validate:wizard`, commit.

**Phase 3 (future):** a standalone admin tool at `/admin/wizard-editor` behind `requireRole('Super Admin')` that reads/writes the JSON file via a new API endpoint `PUT /api/wizard/knowledge-base`. Includes a live preview. Out of scope for this plan.

### 6.7 Storage and resume

- **Key:** `logisx_wizard_state`
- **Write trigger:** debounced 300ms after `currentStepId` changes
- **Read trigger:** on component mount — if a valid state exists, show the resume banner
- **Expiration:** 30 days via `lastSavedAt` timestamp check
- **Parallel to** `logisx_invest_state` — the wizard's progress is independent of the page's form data
- **Clearing:** when the user completes the form or explicitly resets the guide

---

## 7. Edge Cases & Known Gotchas

### 7.1 Quirks pulled from IPA §17

| Quirk from IPA | Wizard mitigation |
|---|---|
| `bankruptcy_liens` is dead code (no UI field) | Wizard skips it in the node list — no node targets it |
| Vehicle `photo` base64 lost on reload | `VEHICLE_PHOTO` node warns: "Upload the photo right before you submit — it won't save if you close the tab" |
| PDF generation errors swallowed | `SUBMITTING_STATE` → `COMPLETION` assumes success (what the server reports). If the user later reports missing PDFs, point them to the admin. Not wizard's concern. |
| Email failures swallowed | Same — wizard can't detect this; included in FAQ as "If you don't get a confirmation email in 10 minutes, check spam or contact us" |
| 5-second redirect after success | `POST_SUBMIT_REDIRECT` node explains this so the user isn't surprised |
| No phone/email/EIN format validation | Wizard adds soft client-side format hints in each field's `body` text but does not block submission |
| Authenticated users redirected away from `/invest` | Wizard never mounts for authenticated users (the page itself redirects) — no-op |
| Rate limit shared with `/apply` | Wizard doesn't need to know about this — only matters on submission error |

### 7.2 Page changes underneath the wizard

**Scenario:** a future `/invest` refactor renames `form.legal_name` to `form.legalName` or restructures the template.

**Mitigations:**
1. **CSS selector registry** — all targets come from a single map (`selectorRegistry.js`) that maps semantic names to current selectors. Renames happen in one place.
2. **Selector resilience** — prefer `data-wizard-target="legal-name"` attributes over `v-model` selectors. Add these attributes to the parent template. Stable across refactors.
3. **Fallback behavior** — if `querySelector(target)` returns `null`, the wizard logs a warning and shows the step panel without a spotlight instead of throwing.
4. **CI smoke test** — a Playwright test walks through the first 10 wizard nodes and asserts each target is found. Runs on every PR that touches `InvestorApplyView.vue` or wizard files.

### 7.3 Multi-tab behavior

**Scenario:** user opens `/invest` in two tabs.

Both tabs read/write the same `logisx_wizard_state` key. Without coordination, the second tab's writes overwrite the first.

**Mitigation:** listen for `storage` events on `window`. When the key changes externally:
1. Show a banner: "Wizard updated in another tab. Reload to sync?"
2. Don't auto-reload — let the user decide
3. The parent page's `logisx_invest_state` has the same multi-tab concern — already an existing bug, not wizard's fault

### 7.4 Back button behavior

**Scenario:** user clicks browser back while the wizard is open.

- Desktop: wizard panel is not in browser history. Back takes the user off `/invest` entirely. Acceptable — the wizard saved its state, so re-navigating restores it.
- Mobile: wizard push a dummy history entry on open. Back closes the wizard without navigating away. On the second back press, normal browser back fires.

Implementation:
```javascript
onMounted(() => {
  if (isMobile) {
    history.pushState({ wizard: true }, '');
    window.addEventListener('popstate', handlePopState);
  }
});
```

### 7.5 Page refresh behavior

**Scenario:** user refreshes mid-wizard.

1. Page reloads
2. `InvestorApplyView.vue` mounts → restores `logisx_invest_state` → rebuilds form state
3. Wizard component mounts → restores `logisx_wizard_state` → shows resume banner
4. User clicks "Continue from Step X" → wizard jumps to saved node
5. Spotlight re-attaches to the DOM element

**Gotcha:** the wizard step might target a field that's in a collapsed accordion. Fix: on resume, check if the target element is visible (`elementIsVisible(target)`); if not, expand the parent accordion first.

### 7.6 Form state drift

**Scenario:** user dismisses the wizard, edits fields manually, reopens the wizard.

The wizard re-reads parent state on open and validates its own assumptions:
- Is the saved step still relevant? (e.g. wizard is on `FLEET_SIZE` but user already filled it)
- Auto-advance past already-completed steps

Implementation: on every open/show, run `validateState()` which walks from the saved `currentStepId` forward, skipping any step whose `exitCondition` already evaluates true.

### 7.7 Network failure on submit

**Scenario:** user clicks submit with the wizard on `SUBMIT_CONFIRM`, the API returns 500.

- Parent catches the error and shows an error toast
- Wizard observes the error via a `failed` prop or event bus
- Wizard shows the `SUBMIT_FAILED` node with "Try again" and "Contact support"
- Does not clear `logisx_wizard_state` — user can retry

### 7.8 Concurrent `InvestorSignModal` interaction

**Scenario:** user opens the sign modal, the wizard is guiding them. The modal takes focus.

- Wizard detects the modal via `document.querySelector('.invest-sign-modal')` on a MutationObserver
- When the modal appears, wizard switches to "sign-modal-mode" with modal-specific nodes (`SIGN_MODAL_EXPLAINER`, `SIGN_CHECKBOX`, etc.)
- When the modal closes, wizard returns to the parent flow

### 7.9 Google Maps autocomplete race

**Scenario:** user is on `ADDRESS_HELP` node, Google Maps hasn't finished loading, they type an address.

- Wizard doesn't care about the autocomplete dropdown — it only spotlights the input
- Autocomplete is a page-level concern, not wizard's

### 7.10 `localStorage` full / blocked

**Scenario:** `localStorage.setItem` throws (Safari private mode, quota exceeded).

- Wizard catches the error, falls back to in-memory state
- Shows a one-time banner: "Your progress won't save if you close the tab"
- Continues to function for the current session

---

## 8. Implementation Roadmap

### Phase 1 — MVP (registration walkthrough only)

**Goal:** A working wizard that guides a first-time user through all three parent steps and the review modal.

**Deliverables:**
1. `client/src/wizard/` directory structure (§4.1)
2. `knowledge-base.json` with ~30 core nodes covering Step 0, Step 1, Step 2, Review (§3)
3. `InvestWizardOverlay.vue` + 5 sub-components (`WizardFab`, `WizardPanel`, `WizardSpotlight`, `WizardResumeBanner`, minimal FAQ drawer)
4. `WizardEngine.js` with the state machine + expression evaluator
5. `spotlight.js` DOM highlight utility
6. `logisx_wizard_state` persistence
7. Minimal FAQ — 10 top questions
8. Desktop-only (>1024px) — mobile parity deferred
9. Data attributes (`data-wizard-target="X"`) added to `InvestorApplyView.vue` for stable targeting
10. `npm run validate:wizard` build-time validator

**Explicitly NOT in MVP:**
- Mobile-specific layout
- Error recovery flow
- Navigation flow (skipping to arbitrary steps)
- CSS animations beyond basic panel slide
- FAQ search
- Accessibility audit

**Complexity:** Medium. ~8-12 engineering days. Most time in content writing for the knowledge base.

**Dependencies:**
- Read-only access to `form`, `vehicles`, `banking`, `signatures` from the parent — requires `defineExpose` or prop drilling
- `data-wizard-target` attributes on every targeted field — requires touching `InvestorApplyView.vue`

**Risks:**
- **Content quality** — 30 nodes of plain-language copy is more work than it sounds. Budget 2 days for content alone, or hire a copywriter.
- **Selector fragility** — if the parent template changes, targets break. Mitigate by using `data-wizard-target` attrs from day one.
- **Reactive sync** — Vue's reactivity may not propagate parent state to child wizard in time for conditional rendering. Test early.

### Phase 2 — Full coverage

**Goal:** Production-ready wizard covering every persona, mobile parity, full FAQ, error recovery.

**Deliverables:**
1. Remaining ~20 wizard nodes (FAQ links, skip paths, large fleet warning, custom bank warning, etc.)
2. Full FAQ — 50+ entries across all 7 categories (§2.2)
3. Error recovery flow with gate-failure detection (§2.4)
4. Navigation flow — jump to any parent step via wizard UI (§2.3)
5. Mobile layout — full-screen modal, swipe-to-dismiss, back-button interception
6. Tablet bottom-sheet layout
7. Spotlight variants (pulse, arrow)
8. FAQ search (fuzzy match against q + a)
9. Resume banner polish
10. `prefers-reduced-motion` support
11. Keyboard shortcut overlay (`Ctrl+/` for help)

**Complexity:** Medium-high. ~10-14 engineering days after MVP.

**Dependencies:**
- Mobile device testing (real iOS + Android)
- UX review of the FAQ categorization
- Copywriter for the 50+ FAQ entries

**Risks:**
- **Mobile spotlight accuracy** — iOS Safari's viewport resizing during keyboard appearance breaks `getBoundingClientRect`. Requires custom handling.
- **FAQ drift** — if content authors update the FAQ without linting, broken `faqLinks` references appear. Mitigate with the validator from MVP.

### Phase 3 — Polish and optimization

**Goal:** Production-hardened, accessible, instrumented.

**Deliverables:**
1. WCAG 2.1 AA audit + fixes (screen reader announcements, focus management, color contrast)
2. Animations: panel slide, spotlight fade, pulse ring — all with reduced-motion fallbacks
3. Analytics events (wizard opened, step completed, FAQ searched, abandoned) — instrument via the existing Socket.IO channel or a dedicated `POST /api/wizard-events` endpoint (backend change required)
4. A/B test infrastructure for copy variants
5. CI Playwright smoke test walking the full happy path
6. Bundle size budget check — wizard code must be <30KB gzipped, lazy-loaded via dynamic import (only downloaded when the user visits `/invest`)
7. Content preview tool for authors — a `/wizard-preview` route behind Super Admin that renders any step by ID without needing to drive the form
8. Admin editor (from §6.6 Phase 3 — out of scope of this plan)

**Complexity:** Medium. ~6-10 engineering days.

**Dependencies:**
- Accessibility auditor (internal or external)
- Analytics infrastructure (existing, needs wiring)
- Playwright added to the dev dependencies (currently absent per CLAUDE.md)

**Risks:**
- **Accessibility scope creep** — audits often surface more issues than expected. Budget conservatively.
- **Bundle bloat** — lazy loading helps, but if the KB grows beyond ~100KB of JSON, consider splitting into chunks loaded on-demand per step group.

### Phase summary

| Phase | Scope | Complexity | Days | Blockers |
|---|---|---|---|---|
| **1 MVP** | Desktop registration walkthrough | Medium | 8-12 | Content writing, data attrs on parent |
| **2 Full** | Mobile + FAQ + error recovery + nav | Medium-high | 10-14 | Mobile testing, copywriter |
| **3 Polish** | a11y + analytics + CI + preview | Medium | 6-10 | a11y auditor, Playwright |
| **Total** | | | **24-36 days** | |

### Dependencies across phases

```
Phase 1 MVP
   ↓
   ├──→ Phase 2 (needs MVP's engine + components)
   │
   └──→ Requires `data-wizard-target` attrs added to InvestorApplyView.vue
         ↑
         └── This is a 1-time change that lands with MVP

Phase 2
   ↓
   └──→ Phase 3 (needs Phase 2's content + mobile layout)

Phase 3 analytics
   ↓
   └──→ Requires new backend endpoint `POST /api/wizard-events`
         ↑
         └── Only backend change in the whole plan
```

### Technical risks (all phases)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Parent template changes break selectors | High | Medium | `data-wizard-target` attrs + CI smoke test |
| Content staleness vs form changes | Medium | Medium | Validator links fields to tooltips |
| Mobile viewport + spotlight breakage | High | High | Test on real devices early, consider disabling spotlight on mobile |
| KB grows too large | Low | Low | Split into per-step JSON chunks, lazy load |
| `localStorage` disabled or full | Low | Low | Fall back to in-memory, show one-time banner |
| Reactive sync issues between wizard + parent | Medium | Medium | Use Vue 3 `toRef` / `toRefs` + `watch` carefully |
| Users dismiss and never re-open | High | Low | Accept — this is a "helper, not gate" by design |
| A/B test shows wizard hurts conversion | Low | High | Roll out behind a feature flag, measure before full launch |

---

## 9. Verification

### 9.1 Plan validation

Before implementation begins, verify:
1. Every wizard node in §3 maps to a real field or element from IPA §8
2. Every FAQ in §4 addresses a real user question derived from the page's complexity or known gotchas
3. The JSON schema in §4.2 is valid JSON Schema draft-07 or later
4. The state shape in §6.3 is compatible with Vue 3 `reactive`
5. All selectors in §3 exist in the current `InvestorApplyView.vue` template (or are planned to be added via `data-wizard-target`)

### 9.2 MVP acceptance criteria

The wizard ships when:
- [ ] A new user landing on `/invest` sees the welcome prompt
- [ ] Clicking "Start tour" opens the side panel
- [ ] The spotlight correctly highlights every field in order
- [ ] Clicking a field in the page syncs the wizard to that field's node
- [ ] Closing the wizard and reopening it resumes from the same step
- [ ] Refreshing the page preserves both form state AND wizard state
- [ ] All 3 documents can be signed while the wizard guides the user
- [ ] The submit flow works end-to-end with the wizard open
- [ ] `npm run validate:wizard` passes
- [ ] Bundle size under 30KB gzipped (lazy chunk)

### 9.3 Full-coverage acceptance criteria

Adds to MVP:
- [ ] Works on iOS Safari, Chrome Android
- [ ] FAQ search finds relevant entries within 100ms
- [ ] Validation gate failures route the user to the correct explainer
- [ ] Back button on mobile closes the wizard without navigating away
- [ ] Multi-tab storage events are handled gracefully

### 9.4 Polish acceptance criteria

Adds to Full:
- [ ] axe-core reports zero critical/serious violations
- [ ] Lighthouse accessibility score ≥ 95 on `/invest` with wizard open
- [ ] Playwright smoke test passes on CI
- [ ] Analytics events land in the database
- [ ] A Super Admin can preview any wizard step via `/wizard-preview?step=X`

---

## 10. Open Questions

These need answers from the CEO (Deshorn King) or product owner before Phase 1 begins:

1. **Entry default** — should the wizard auto-open for first-time visitors, or is it strictly opt-in via the help button? (Assumption: auto-open, dismissible)
2. **Tone** — how conversational should the copy be? "Hey there!" friendly or "Please enter your legal name" formal? (Assumption: warm but professional)
3. **Branding** — use the same navy `#0f2847` as the page sidebar or a contrasting accent color? (Assumption: navy to match)
4. **Content ownership** — who writes and maintains `knowledge-base.json` after launch? Developer, marketing, Deshorn? (Assumption: Deshorn or a copywriter, developers only for structural changes)
5. **Analytics** — which events matter most for measuring wizard success? Completion rate, abandonment point, FAQ searches? (Assumption: all of the above, defined in Phase 3)
6. **Persona priority** — which persona is most important to serve well for MVP? (Assumption: Persona A, first-time investor)
7. **Legal review** — does the wizard copy for the three signed documents need legal review before ship? (Assumption: yes for the `SIGN_MODAL_EXPLAINER` node, no for generic field tooltips)
8. **FAQ scope** — is there an existing FAQ document somewhere we can mine for content? (Assumption: no, start from scratch)

---

## 11. Appendix — Cross-reference to IPA

Every section of this plan traces to specific sections of `invest-page-analysis.md`:

| Plan section | Sources from IPA |
|---|---|
| §1.2 Scope | IPA §1 Overview, §7 User Flows |
| §2.1 Registration flow | IPA §7 Step 0/1/2, §8 Forms & Inputs |
| §2.4 Error recovery | IPA §6 Business Logic (validation gates) |
| §3.2 Step 0 nodes | IPA §8 Application fields |
| §3.3 Step 1 nodes | IPA §8 Fleet fields + §3 InvestorSignModal contract |
| §3.4 Step 2 nodes | IPA §8 Banking fields |
| §4.3 Editability | IPA §4 (no Pinia stores — matches page pattern) |
| §5.1 Overlay positioning | IPA §11 UI/UX (existing 290px sidebar layout) |
| §6.3 State management | IPA §4 State Management (no Pinia) |
| §6.7 Storage | IPA §4 (`logisx_invest_state` pattern) |
| §7.1 Quirks | IPA §17 Known Quirks & Gotchas |
| §7.2 Page changes | IPA §11 (component structure) |
| §7.3 Multi-tab | IPA §4 localStorage persistence |
| §8 Roadmap | IPA §5 Data Flow (submission behavior) |

---

*Generated 2026-04-15 as the implementation plan for the /invest Wizard Overlay Assistant. All wizard nodes, FAQ entries, and decision logic trace back to documented fields and flows in `invest-page-analysis.md`. No AI/LLM runtime dependency — the wizard is a deterministic state machine over a JSON knowledge base, editable by non-developers, auditable by static validation at build time.*
