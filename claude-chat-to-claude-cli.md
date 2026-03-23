# Project Context — Google Sheets CRUD App

## Overview
A Node.js + Express web app that uses **Google Sheets as a database** with full CRUD (Create, Read, Update, Delete) operations. The app connects via the Google Sheets API v4 using a service account for authentication.

## Project Structure
```
google-sheets-app/
├── server.js                  # Express server with 4 CRUD endpoints
├── package.json               # Dependencies: express, googleapis
├── public/
│   └── index.html             # Single-file frontend dashboard (vanilla HTML/CSS/JS)
├── service-account-key.json   # Google service account credentials (DO NOT commit)
├── .gitignore
└── CLAUDE.md
```

## Tech Stack
- **Backend**: Node.js + Express
- **Database**: Google Sheets (via Sheets API v4)
- **Auth**: Google Service Account (JSON key file)
- **Frontend**: Vanilla HTML/CSS/JS (dark theme dashboard)

## Google Cloud Setup (completed)
- **Project**: Logistics App (project ID: `logistics-app-491014`)
- **API enabled**: Google Sheets API
- **Service account**: `sheets-bot@logistics-app-491014.iam.gserviceaccount.com`
- **Key file**: JSON key downloaded and placed as `service-account-key.json`

## Google Sheet Details
- **Sheet name**: "Copy of Dispatch Management"
- **Spreadsheet ID**: `1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI`
- **Active tab**: `Job Tracking`
- **Columns**: Contract ID, Load ID, Details, Trailer Number, Driver, Pickup Info, Pickup Appointment, Pickup Address (and possibly more columns beyond H)
- **Service account has Editor access** to the sheet

## API Endpoints
| Method   | Endpoint         | Description                        |
|----------|------------------|------------------------------------|
| GET      | /api/data        | Read all rows (headers + data)     |
| POST     | /api/data        | Append a new row                   |
| PUT      | /api/data/:row   | Update a specific row by index     |
| DELETE   | /api/data/:row   | Delete a row (shifts rows up)      |

## Configuration (in server.js)
```js
const SPREADSHEET_ID = "1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI";
const SHEET_NAME = "Job Tracking";
const KEY_FILE = "./service-account-key.json";
```

## Current Frontend
- Dark themed dashboard with a form to add rows and a table to display/edit/delete rows
- Dynamically reads column headers from Row 1 of the sheet
- Inline editing support with save/cancel
- Toast notifications for success/error feedback
- Status indicator showing connection state

## What's Been Done
1. ✅ Google Cloud project created and Sheets API enabled
2. ✅ Service account created with JSON key downloaded
3. ✅ Google Sheet shared with service account as Editor
4. ✅ Express server with full CRUD endpoints
5. ✅ Frontend dashboard with add/edit/delete functionality
6. ✅ server.js configured with correct Spreadsheet ID and sheet name

## What Could Be Done Next
- Run `npm install && npm start` and test the connection
- Improve the frontend (better layout for many columns, responsive design)
- Add search/filtering for the dispatch data
- Add pagination for large datasets
- Add input validation and error handling
- Add support for dropdown fields (e.g., Driver selection)
- Deploy to a hosting platform (Railway, Render, Vercel, etc.)
- Add authentication to protect the web dashboard
- Support multiple sheet tabs (Job Tracking, Carrier Database, Payments Table, etc.)

## Important Notes
- Google Sheets API has a rate limit of 300 requests/minute
- The service account key file should never be committed to version control
- The sheet has multiple tabs: Job Tracking, Job Details, Carrier Database, Status Logs, Payments Table, Job Tracking Log, Carrier History, Job Summary Sheet
- Some columns in the sheet use dropdowns (e.g., Driver column)
