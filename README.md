# Google Sheets CRUD — Node.js + Express

A lightweight Node.js app that uses **Google Sheets as a database** with full
Create / Read / Update / Delete support via a REST API and a web dashboard.

---

## Quick Start

### 1. Set Up Google Cloud

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. **Enable the Google Sheets API:**
   - Navigate to **APIs & Services → Library**
   - Search for "Google Sheets API" and click **Enable**
4. **Create a Service Account:**
   - Go to **APIs & Services → Credentials**
   - Click **Create Credentials → Service Account**
   - Give it a name (e.g. `sheets-bot`) and click **Done**
5. **Download the key file:**
   - Click on the service account you just created
   - Go to the **Keys** tab → **Add Key → Create new key → JSON**
   - Save the downloaded file as `service-account-key.json` in this project folder

### 2. Prepare Your Google Sheet

1. Create a new Google Sheet (or open an existing one)
2. **Add headers** in row 1 (e.g. `Name | Email | Role`)
3. **Share the sheet** with your service account email  
   (it looks like `sheets-bot@your-project.iam.gserviceaccount.com`)  
   Give it **Editor** access
4. Copy the **Spreadsheet ID** from the URL:
   ```
   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID_IS_HERE/edit
   ```

### 3. Configure the App

Open `server.js` and update these three values at the top:

```js
const SPREADSHEET_ID = "your-spreadsheet-id";
const SHEET_NAME     = "Sheet1";           // your tab name
const KEY_FILE       = "./service-account-key.json";
```

### 4. Install & Run

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) — you should see the dashboard.

---

## API Reference

| Method   | Endpoint            | Body                          | Description         |
| -------- | ------------------- | ----------------------------- | ------------------- |
| `GET`    | `/api/data`         | —                             | Read all rows       |
| `POST`   | `/api/data`         | `{ "values": ["a","b","c"] }` | Append a new row    |
| `PUT`    | `/api/data/:row`    | `{ "values": ["a","b","c"] }` | Update row at index |
| `DELETE` | `/api/data/:row`    | —                             | Delete row at index |

`:row` is the 1-based sheet row number (header = row 1, first data row = row 2).

### Example with curl

```bash
# Read all
curl http://localhost:3000/api/data

# Add a row
curl -X POST http://localhost:3000/api/data \
  -H "Content-Type: application/json" \
  -d '{"values": ["Alice", "alice@example.com", "Admin"]}'

# Update row 2
curl -X PUT http://localhost:3000/api/data/2 \
  -H "Content-Type: application/json" \
  -d '{"values": ["Alice", "alice@newmail.com", "Super Admin"]}'

# Delete row 3
curl -X DELETE http://localhost:3000/api/data/3
```

---

## Project Structure

```
google-sheets-app/
├── server.js                  # Express server + Sheets API logic
├── package.json
├── public/
│   └── index.html             # Web dashboard (single-file frontend)
└── service-account-key.json   # ← YOU provide this (not committed to git)
```

---

## Tips

- **Don't commit** `service-account-key.json` to version control — add it to `.gitignore`.
- The Google Sheets API has a default quota of **300 requests per minute**.
- For production, consider adding rate limiting, input validation, and error handling middleware.
- If you need real-time updates, poll `/api/data` on an interval or look into Google Apps Script triggers + webhooks.
