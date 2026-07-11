# What's in this folder?

You don't need to understand or open most of these files. Here's a quick map
so nothing looks mysterious.

---

## Files you will touch

| File | What it is |
|---|---|
| `.env` | Your personal settings — password, Sheet ID, API keys. You create this once by copying `.env.example`. |
| `village-matcher-key.json` | The key file your developer sent. Drop it here and reference it in `.env`. |

---

## Files you will use (but not edit)

| File | What it is |
|---|---|
| `server.js` | Starts the tool. Run `node server.js` in Terminal, then open your browser. |
| `.env.example` | A blank copy of the settings file. Duplicate this to create your `.env`. |

---

## Folders you can ignore

| Folder / file | What it is |
|---|---|
| `docs/` | The setup guides you're reading right now. |
| `src/` | The code that runs the matching tool in your browser. Don't edit. |
| `netlify/` | Code for the Netlify cloud version. Not used when running locally. |
| `tests/` | Automated checks your developer uses. You don't need these. |
| `node_modules/` | Libraries the tool depends on — installed automatically by `npm install`. Don't edit or move. |
| Everything else | Config files (`package.json`, `netlify.toml`, etc.) — leave as-is. |

---

## The short version

The only two things you manage are **`.env`** (your settings) and the
**`.json` key file** (sent by your developer). Everything else runs itself.
