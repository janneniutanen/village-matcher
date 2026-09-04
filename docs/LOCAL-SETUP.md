# Village Matcher — local setup guide (macOS)

This guide walks you through running Village Matcher directly on your Mac,
without needing Netlify. You'll do this once; after that, starting the tool
is just double-clicking a script.

---

> Not sure what all the files are for? See **FOLDER-GUIDE.md** in this `docs`
> folder for a plain-English map of the project.

## What you'll need before starting

- The Village Matcher project folder (unzipped somewhere on your Mac, e.g.
  your Desktop or Documents)
- The service account key file (`.json`) your developer sent you — save it
  **inside** the project folder for easy access
- Two free API keys (see steps below)
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
3. Note the exact tab name (e.g. `Form Responses 1`) —
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
5. Uncheck "Notify people"
6. Click **Share**

---

## Step 4 — Get a free Digitransit API key (geocoding)

This key lets the tool place applicants on a map using real addresses.

1. Go to **[portal.digitransit.fi](https://portal.digitransit.fi)**
2. Click **Sign up** in the top-right corner and create a free account
3. After signing in, click **APIs** in the top menu
4. Find **Digitransit Developer** and click **Subscribe**
5. Click your profile icon (top-right) → **Profile**
6. Scroll down to **Subscriptions** — click your Digitransit Developer subscription
7. Copy the **Primary Key** shown there

---

## Step 5 — Install Node.js (one-time)

Node.js is a free program that runs the Village Matcher server on your Mac.
You only need to install it once.

1. Go to **[nodejs.org](https://nodejs.org)**
2. Download the **LTS** version (the button labelled "LTS" on the left)
3. Open the downloaded `.pkg` file and follow the installer — click Continue,
   Agree, Install
4. When it finishes, click Close

---

## Step 6 — Create the configuration file

You'll fill in a configuration file called `.env` inside the project folder.
This file holds your credentials — keep it private.

The project folder already contains a file called `.env.example` with all the
fields ready for you.

1. In **Finder**, open the project folder
2. Find `.env.example`, right-click it → **Duplicate**
3. Rename the copy to `.env` (remove `.example` from the name)
   - If macOS asks "Are you sure?", click **Use "."**
4. Right-click `.env` → **Open With** → **TextEdit**
5. In TextEdit, go to **Format** menu → **Make Plain Text** (if the option
   is available — it means the file opened in rich-text mode)
6. Fill in your values — the file looks like this:

   ```
   MATCHER_PASSWORD=choose-a-password-here
   SPREADSHEET_ID=paste-your-sheet-id-here
   SOURCE_TAB=Form Responses 1
   DIGITRANSIT_API_KEY=paste-your-digitransit-key-here
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=village-matcher-e25c4fc9e213.json
   ```

   Replace each value with your own:
   - `MATCHER_PASSWORD` — the password you'll type to open the tool
   - `SPREADSHEET_ID` — the ID you copied in Step 1
   - `SOURCE_TAB` — the exact tab name from Step 2
   - `DIGITRANSIT_API_KEY` — the key from Step 4
   - `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` — the filename of the `.json` key
     file your developer sent (make sure this file is inside the project
     folder)

4. Save the file: press **Command+S**
5. In the save dialog, navigate to the project folder
6. Name the file **exactly** `.env` (with a dot at the start, no `.txt`)
7. If macOS asks "Are you sure you want to use a name that starts with a
   dot?", click **Use "."**

> **Tip:** If TextEdit keeps adding `.txt`, you can instead open Terminal
> and run `nano .env` from the project folder (see Step 8 for how to open
> Terminal in the right folder).

---

## Step 7 — Install dependencies (one-time)

1. Open **Finder** and navigate to the project folder
2. Open **Terminal**: press **Command+Space**, type **Terminal**, press Enter
3. In Terminal, type `cd ` (with a space after it), then drag the project
   folder from Finder into the Terminal window — the path fills in
   automatically
4. Press **Enter**
5. Type the following and press Enter:
   ```
   npm install
   ```
6. Wait for it to finish — you'll see the cursor return on a new line

You only need to do this once. If you move the project folder, run
`npm install` again from the new location.

---

## Step 8 — Start the tool

Each time you want to use Village Matcher:

1. Open **Terminal** and navigate to the project folder (drag the folder
   onto the Terminal window, as in Step 7)
2. Type the following and press Enter:
   ```
   node server.js
   ```
3. You'll see:
   ```
   Village Matcher is running!
   Open this in your browser → http://localhost:3000
   ```
4. Open your browser and go to **http://localhost:3000**
5. Enter your password and click **Unlock**

To stop the server when you're done, press **Ctrl+C** in the Terminal window.

---

## Making it easier to start (optional shortcut)

To avoid opening Terminal every time, you can create a double-clickable
script:

1. Open TextEdit → Format → Make Plain Text
2. Paste the following:
   ```
   #!/bin/bash
   cd "$(dirname "$0")"
   node server.js
   ```
3. Save it as `start.command` inside the project folder
4. Open Terminal, navigate to the project folder, and run:
   ```
   chmod +x start.command
   ```
5. From now on, double-click `start.command` to start Village Matcher

---

## Troubleshooting

| What you see | What to do |
|---|---|
| "command not found: node" | Node.js isn't installed — repeat Step 5 |
| "Cannot find module" | Run `npm install` from the project folder (Step 7) |
| "Incorrect password" | Re-check `MATCHER_PASSWORD` in your `.env` file |
| "Tab X not found" | Re-check `SOURCE_TAB` — must match the sheet tab name exactly |
| "No service account credentials found" | Make sure `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` in `.env` matches the exact filename of the `.json` key file, and that the file is in the project folder |
| "Permission denied" on the sheet | Make sure you shared the sheet with `village-matcher@village-matcher.iam.gserviceaccount.com` and set it to **Editor** (Step 3) |
| Port 3000 already in use | Something else is using that port — add `PORT=3001` to your `.env` file and open `http://localhost:3001` instead |
| Map pins show but in wrong locations | Geocoding may need a moment — click Sync again after a few seconds |

If something still isn't working, take a screenshot of the Terminal output
and send it to your developer.

---

## Changing your password later

1. Open the `.env` file in TextEdit
2. Change the value after `MATCHER_PASSWORD=`
3. Save the file
4. Restart the server (Ctrl+C, then `node server.js` again)
