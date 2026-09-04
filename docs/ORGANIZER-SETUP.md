# Village Matcher — organizer setup guide

This guide walks you through connecting Village Matcher to your Google Sheet
so applicant data flows automatically into the tool. You'll do this once, in
about 30 minutes, entirely in your browser — no technical skills needed.

---

## What you'll need before starting

- Your existing Netlify site for Village Matcher (e.g. `your-site.netlify.app`)
- Your Google Sheet that collects applicant responses
- The service account key file — your developer will send this to you securely
  as a `.json` file. Save it somewhere safe on your computer; you'll copy its
  contents into Netlify.
- Two free API keys (steps 4 and 5 below)
- A password of your choice to protect the tool

---

## Step 1 — Find your Google Sheet ID

1. Open your Google Sheet in a browser
2. Look at the URL — it looks like this:
   ```
   https://docs.google.com/spreadsheets/d/  THIS_PART  /edit
   ```
3. Copy just the long ID in the middle — you'll need it shortly

---

## Step 2 — Note your applicant tab name

1. Look at the tabs at the bottom of your Google Sheet
2. Find the tab that contains the applicant form responses
3. Note the exact tab name (e.g. `mock-applicants` or `Form Responses 1`) —
   spelling and capitalisation matter

---

## Step 3 — Share your Google Sheet with the service account

The tool reads and writes your sheet using a special service account
(not a personal Google login). You need to share the sheet with it once.

1. Open your Google Sheet
2. Click the **Share** button in the top-right corner
3. In the "Add people and groups" box, paste this email address exactly:
   ```
   village-matcher@village-matcher.iam.gserviceaccount.com
   ```
4. Make sure the permission is set to **Editor**
5. Uncheck "Notify people" (the service account does not receive emails)
6. Click **Share**

---

## Step 4 — Get a free Digitransit API key (geocoding)

This key lets the tool place applicants on a map using real addresses.

1. Go to **[portal.digitransit.fi](https://portal.digitransit.fi)**
2. Click **Sign up** in the top-right corner and create a free account
   (you can use a Google account or register with email)
3. After signing in, click **APIs** in the top menu
4. Find **Digitransit Developer** and click **Subscribe**
5. Click your profile icon (top-right) → **Profile**
6. Scroll down to **Subscriptions** — you should see your Digitransit Developer
   subscription listed
7. Click on it to expand, then copy the **Primary Key** shown there

---

## Step 5 — Choose an access password

Pick any password you'll use to log in to the Village Matcher tool. You're
the only user, so it can be something simple but not obvious.

---

## Step 6 — Add environment variables in Netlify

This is where everything gets connected. You'll add six pieces of information
as "environment variables" — a secure way Netlify stores private settings that
your tool can read.

1. Go to **[app.netlify.com](https://app.netlify.com)** and open your site
2. Click **Site configuration** in the left sidebar
3. Click **Environment variables**
4. Click **Add a variable** for each of the following (one at a time):

---

### Variable 1 — `MATCHER_PASSWORD`

| Field | Value |
|---|---|
| Key | `MATCHER_PASSWORD` |
| Value | The password you chose in Step 5 |

---

### Variable 2 — `SPREADSHEET_ID`

| Field | Value |
|---|---|
| Key | `SPREADSHEET_ID` |
| Value | The Sheet ID you copied in Step 1 |

---

### Variable 3 — `SOURCE_TAB`

| Field | Value |
|---|---|
| Key | `SOURCE_TAB` |
| Value | The exact tab name you noted in Step 2 |

---

### Variable 4 — `DIGITRANSIT_API_KEY`

| Field | Value |
|---|---|
| Key | `DIGITRANSIT_API_KEY` |
| Value | The Digitransit key from Step 4 |

---

### Variable 5 — `GOOGLE_SERVICE_ACCOUNT_JSON`

This one contains the full contents of the `.json` file your developer sent.
The file belongs to the service account
`village-matcher@village-matcher.iam.gserviceaccount.com` — the same address
you shared the sheet with in Step 3.

1. Open the `.json` file with Notepad (right-click → Open with → Notepad)
2. Select all the text (Ctrl+A) and copy it (Ctrl+C)
3. Paste it as the value for this variable

| Field | Value |
|---|---|
| Key | `GOOGLE_SERVICE_ACCOUNT_JSON` |
| Value | The full contents of the `.json` file (paste everything) |

---

## Step 7 — Redeploy the site

After adding all six variables:

1. Click **Deploys** in the left sidebar
2. Click **Trigger deploy** → **Deploy site**
3. Wait about a minute for the deploy to finish (the status will say
   **Published** when done)

---

## Step 8 — Test it

1. Open your Village Matcher URL in the browser
2. The tool will ask for your password — enter the one you set in Step 5
3. Click **Unlock**
4. Go to **Templates & Settings** → click **Test connection**
5. You should see a green ✓ with your sheet tab name

If the test passes, click **↻ Sync with Google Sheet** in the **New Matches**
tab — your applicants should load onto the map.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| "Incorrect password" | Re-check the `MATCHER_PASSWORD` variable — copy-paste to avoid typos |
| "Cannot connect to server" | The site may still be deploying — wait a minute and try again |
| "Tab X not found" | Re-check `SOURCE_TAB` — it must match the tab name exactly |
| "SPREADSHEET_ID not set" | Re-check that you added the variable and redeployed |
| "Permission denied" on the sheet | Make sure you shared the sheet with `village-matcher@village-matcher.iam.gserviceaccount.com` and set it to **Editor** (Step 3) |
| Applicants load but show data issues | The column headers in your sheet may not match — contact your developer |
| Map pins show but in wrong locations | Geocoding may need a moment — click Sync again after a few seconds |

If something still isn't working after checking the above, take a screenshot
of the error and send it to your developer.

---

## Changing your password later

1. Go to Netlify → Site configuration → Environment variables
2. Find `MATCHER_PASSWORD` and click **Edit**
3. Change the value to your new password → **Save**
4. Go to Deploys → Trigger deploy → Deploy site
5. Use the new password next time you log in
