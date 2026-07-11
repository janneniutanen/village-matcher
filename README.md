# Village Matcher

A support-group matching tool for new mothers in Helsinki. Reads applicants
from a Google Sheet, runs a neighbourhood-aware grouping algorithm, lets a
coordinator review and approve groups, and tracks each group through outreach
stages.

## Architecture

```
Browser (Netlify static)
  ↓  POST /.netlify/functions/api  +  X-Matcher-Password header
Netlify Function
  ├── Google Sheets API  (service account — GOOGLE_SERVICE_ACCOUNT_JSON env var)
  ├── Digitransit API    (geocoding + transit routing — DIGITRANSIT_API_KEY)
  └── OpenRouteService   (isochrones — ORS_API_KEY)
```

The organizer opens the Netlify URL, enters a password, and uses the tool.
No local server, no terminal, no Google sign-in.

## Running locally (macOS / Linux)

Start the bundled HTTP server — it serves the frontend and handles all API
calls through the same backend logic as the Netlify function:

```
node server.js
```

Then open `http://localhost:3000`. Credentials come from a `.env` file:

```
MATCHER_PASSWORD=...
SPREADSHEET_ID=...
SOURCE_TAB=Form Responses 1
DIGITRANSIT_API_KEY=...
ORS_API_KEY=...
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=village-matcher-key.json   # path to key file
```

See `docs/LOCAL-SETUP.md` for step-by-step organizer instructions.

## Deploying to Netlify

All credentials are set as environment variables in the Netlify dashboard
(never in the repo). Required variables:

| Variable | Description |
|---|---|
| `MATCHER_PASSWORD` | Password the organizer enters on first load |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON content of the service account key file |
| `SPREADSHEET_ID` | Google Sheet ID (the long string in the sheet URL) |
| `SOURCE_TAB` | Sheet tab name containing applicant data |
| `DIGITRANSIT_API_KEY` | From portal.digitransit.fi |
| `ORS_API_KEY` | From openrouteservice.org |

See `docs/ORGANIZER-SETUP.md` for step-by-step Netlify deployment instructions.

## Project layout

```
index.html                   main UI
styles.css
src/
  app.js                     all UI logic and backend calls
  matching-engine.js         grouping algorithm
  validation.js              row validation (browser + function share same file)
  mock-data.js               offline fallback (18 sample applicants)
netlify/
  functions/
    api.js                   Netlify Function — all backend logic
netlify.toml                 Netlify build config
server.js                    local production server (serves frontend + API)
local-test-server.js         local dev server (CSV mock data only)
mock-applicants.csv          18 sample rows for offline testing
package.json
tests/
docs/
  LOCAL-SETUP.md             step-by-step guide for running locally on macOS
  ORGANIZER-SETUP.md         step-by-step guide for Netlify deployment
```

## Local development

For quick UI testing against the CSV mock data, use the local server with
the `?backend=` escape hatch:

```
node local-test-server.js mock-applicants.csv
```
Then open `index.html?backend=http://localhost:8791` in your browser.

For testing against a real sheet locally, use `netlify dev` (requires
[Netlify CLI](https://docs.netlify.com/cli/get-started/)) with a `.env` file:

```
# .env
MATCHER_PASSWORD=dev
GOOGLE_SERVICE_ACCOUNT_JSON=<paste JSON here>
SPREADSHEET_ID=<your sheet id>
SOURCE_TAB=mock-applicants
DIGITRANSIT_API_KEY=<key>
ORS_API_KEY=<key>
```
```
netlify dev
```

## Tests

```
npm install
npm test           # unit tests (matching engine + validation)
```

For the DOM smoke tests, start the local CSV server first:
```
node local-test-server.js mock-applicants.csv
```
Then open `index.html?backend=http://localhost:8791` or run `npm run test:ui`.

## Known simplifications

- Greedy clustering heuristic, not an optimal solver
- Neighbourhood matching is exact-string (sheet typos create separate groups)
- No multi-user support — designed for a single organizer
