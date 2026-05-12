# Overview

A high-level introduction to the LogisX platform — what it does, who uses it, and how the pieces fit together.

## What is LogisX

LogisX is a dispatch and fleet management platform for small trucking companies. It coordinates the movement of freight from broker to delivery: dispatchers assign loads to drivers, drivers report their position and status from the road, investors who own the trucks see real-time earnings on the fleet they fund, and customers can track their load with a public link.

The system is a Node.js / Express backend, a Vue 3 single-page application for the user-facing surfaces, and Google Sheets as the system of record for job tracking — with SQLite holding everything that doesn't fit the Sheets model (users, sessions, geocode cache, expenses, applications, onboarding documents, telemetry).

## Who uses it

Four roles, each with a tailored experience.

| Role | What they do | Primary surface |
|---|---|---|
| **Super Admin** | Operations leadership. Manages users, reviews applications, approves invoices, sees full financials. | Dashboard + every admin route |
| **Dispatcher** | Daily operations. Assigns loads, tracks trucks live, handles driver communication. | Dashboard, tracking map, messages |
| **Driver** | The person in the truck. Accepts loads, reports GPS, updates status, uploads POD, logs expenses. | Mobile-optimized `/driver` view |
| **Investor** | The owner-operator who funded a truck. Sees earnings, fleet performance, and signed documents. | `/investor` dashboard |

In addition, three public flows require no login: driver applications at `/apply`, investor applications at `/invest`, and the customer load tracker at `/track/:loadId`.

## Stack at a glance

- **Backend** — Node.js, Express, Socket.IO, better-sqlite3, googleapis (Sheets/Drive), Puppeteer (HTML→PDF), pdfkit, pdf-lib, nodemailer.
- **Frontend** — Vue 3, Vite, Vue Router, Pinia, Tailwind CSS v4, shadcn-vue, Vant (mobile), Leaflet + Google Maps.
- **Storage** — Google Sheets ("Job Tracking" tab is the source of truth for loads), SQLite (`app.db`, WAL mode, ~35 tables for everything else).
- **Real-time** — Socket.IO rooms per role (dispatch, investor, driver:&lt;name&gt;) for instant load assignments, status updates, and dashboard refreshes.
- **Integrations** — Google Sheets, Google Drive (POD uploads), Google Maps (geocoding, routing, weather), Gemini 2.5 Flash (receipt OCR), n8n (broker email ingestion), Routemate (ELD telematics, off by default), Tesseract (legacy POD OCR).

## How loads move through the system

```
Broker email arrives
    └─► n8n parses the load details and posts to /api/n8n/job
            └─► row appended to "Job Tracking" sheet (status: Unassigned)
                    └─► Dispatcher assigns driver via /dashboard
                            └─► Socket.IO emits "load-assigned" to the driver
                                    └─► Driver accepts → status: Dispatched
                                            └─► GPS reports → geofence auto-advances status
                                                    └─► Driver uploads POD → status: Delivered
                                                            └─► Super Admin generates invoice
                                                                    └─► Invoice approved → driver paid
```

Every step is logged: socket events fan out to the dispatcher's UI, status changes write to the "Status Logs" sheet, and admin-significant actions land in the `audit_trail` SQLite table.

## What this document covers

The chapters that follow are organized by concern: backend, frontend, integrations, document generation, deployment, and operations. The final appendix is a flat API reference of every route in the system. Each chapter is self-contained — read top-to-bottom for a complete tour, or jump to the topic you need.

If you are looking for how *users* perform tasks (sign onboarding documents, accept a load, generate an investor report), see the companion **User Manual** PDF instead.
