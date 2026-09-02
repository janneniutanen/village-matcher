# Village Matcher

A support-group matching tool for new mothers, covering all of Finland. Reads
applicants
from a Google Sheet, runs a neighbourhood-aware grouping algorithm, and lets
a coordinator review and approve candidate groups. Approved members are
written back to the sheet, and the Active Groups tab shows everyone grouped
by the `Village` column the coordinator maintains there.

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
netlify/
  functions/
    api.js                   Netlify Function — all backend logic
netlify.toml                 Netlify build config
server.js                    local production server (serves frontend + API)
local-test-server.js         local dev server (CSV mock data only)
mock-applicants.csv          150 sample rows for offline testing
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

## Test data

`mock-applicants.csv` holds 300 synthetic applicants using real street names
with invented house numbers. Rows A001-A150 cover Uusimaa: Helsinki, Espoo,
Vantaa and Kauniainen through to Porvoo, Lohja, Hyvinkää, Raasepori and Hanko.
Rows A151-A300 cover the rest of the country: Tampere and its districts,
the Pirkanmaa commuter belt (Kangasala, Nokia, Pirkkala, Ylöjärvi, Lempäälä,
Valkeakoski), and Turku, Oulu, Jyväskylä, Lahti, Hämeenlinna and Kouvola.

That second half exists because the tool stopped being a Helsinki-region tool,
and the failures that came with the move only appear in national data:

- **The same street name in several cities.** Hämeenkatu is in Tampere, Turku
  and Hyvinkää; Yliopistonkatu in Tampere, Turku and Jyväskylä; Kauppakatu in
  Kouvola, Jyväskylä and Oulu. Each appears more than once in the sample, in
  different cities, so a geocoder that ignores the municipality gets caught.
- **Several people at one address.** Seven rows deliberately repeat an
  address, because coincident pins used to be drawn on top of each other and
  the hidden ones were invisible.
- **Districts written instead of cities** (`Hervanta`, `Kaleva`), which is how
  the column actually gets filled in.

It is shaped to exercise the matching engine rather than to look tidy:

- **Languages** follow the largest foreign-language populations in Finland
  (Russian, Estonian, Arabic, Somali, Ukrainian, Vietnamese, Chinese, Kurdish,
  Persian and others), most combined with English and/or Finnish.
- **Baby ages** span roughly two and a half years across 28 distinct months,
  so the `maxAgeGap` setting actually bites.
- **Phone numbers** mix bare local, spaced, `+358` and foreign formats to
  exercise normalization.
- **Travel limits** include free-text answers such as "Doesn't matter" and
  "about 20 min".
- **Rows are deliberately corrupted** (A145-A150 and A296-A300): unknown
  transport modes, an impossible date, a missing name, an out-of-range travel
  time, a street that does not exist, a missing neighbourhood, so the
  validation and geocoding failure paths always have something to flag.

`src/regions.js` carries a coordinate for every neighbourhood the CSV uses, so
the offline geocode stub places people in roughly the right part of the map.
The stub also puts every fourth address on a neighbour's exact coordinates, so
the map's shared-pin handling is exercised without a network call.

Measured against the live Digitransit API over all 300 rows: 286 placed, none
in the wrong municipality, and the 14 refusals are all streets that genuinely
do not exist in the municipality given (or rows with no address at all).

## Messy addresses

The sheet is hand-filled, so the address cells are cleaned before being sent to
the geocoder. The original is never overwritten — the organizer still sees what
she typed, and only the query is normalized.

Dropped from the street cell, because they identify a person rather than a
building and make the geocoder miss: apartment and stair markers (`as 3`,
`as. 12`, `rappu B`, `krs 3`, `huoneisto`, `bostad`), care-of lines, a postal
code and city written after a comma, and the tail of a house-number range. A
house-number suffix letter is kept (`5 A`) while an apartment number after it
is not (`5 A 12`). A missing space is inserted, so `Vaasankatu5` resolves.

The Neighbourhood cell is matched case-insensitively, with or without
Scandinavian diacritics (`toolo` finds Töölö), ignoring postal codes and
parentheses, and accepting a district and city written together — `Helsinki,
Kallio`, `Kallio (Helsinki)` and `Pirkkala Kyösti` all resolve, whether the
two names are separated by punctuation or just a space. A city on its own
resolves too. Anything unrecognised is flagged rather than guessed at.

## How an address becomes a coordinate

Digitransit's geocoder covers all of Finland but treats the query as free
text: it discards the municipality and fuzzy-matches the street name
nationally, so `Jokikatu 11, Porvoo` comes back as Jokikatu 11 in Joensuu,
400km away, at 0.96 confidence. **The confidence score cannot be used to catch
this.** What works is verifying the answer ourselves:

1. **Establish the municipality.** A district resolves to its city through the
   table in `src/regions.js` (`Hervanta` → Tampere); anything else is looked up
   in the geocoder's own `localadmin` layer, so all 309 municipalities work
   without a hand-kept list. Results are cached.
2. **Ask several ways.** Pelias is inconsistent about qualifiers: a district
   name can pin the right city (`Insinöörinkatu 60, Hervanta` is exact) or
   return *nothing at all* (`Vaasankatu 5, Kallio` finds zero results, while
   `Vaasankatu 5, Helsinki` is exact). The query ladder tries the most specific
   phrasing first and falls back to the bare street.
3. **Verify at municipality level.** Street names repeat across Finland but are
   effectively unique within a municipality, so the municipality is the check
   that works. `localadmin` is the municipality; `locality` is the *postal
   town* and is not accepted in its place. Parts of Kangasala have a Tampere
   postal town, and trusting that put Kangasala addresses on the map as
   Tampere.
4. **Rank what survives** by exact house number first, then district match,
   then confidence. Pelias ranks by text similarity, so it offered house 9 for
   a request for 59: the right street, 700m away.

Nothing verifiable means no answer: the row is flagged for the organizer
rather than pinned somewhere plausible. A wrong pin is worse than a flag,
because a flag can be fixed and a wrong pin quietly corrupts a group.

The geocoder is **never** constrained to a sub-region. An earlier version
passed a Uusimaa-shaped `boundary.rect`, which clipped Pirkanmaa out of the
result set entirely, so the only candidates left for a Tampere street were
same-named streets in Uusimaa, so Tampere applicants landed in Helsinki,
Hyvinkää, Espoo, Salo and Järvenpää. Constrain the answer, not the search.

### What the organizer sees

Results are not just found or not found. Under **Needs attention**, blocking
problems (red) are people who are *not* on the map and not being matched;
below them, amber rows are people who *are* on the map but whose pin deserves
a glance:

| Reported as | Meaning |
|---|---|
| exact | the house number asked for |
| approximate | right street and city, nearest house number in the register |
| street level | the street exists, that house number does not |
| area level | the street cell held only a place name, so the pin is at the centre of that district |

Requests are spaced globally and retried on throttling. A 300-applicant sync
issues roughly 600 geocoder calls; without spacing, around twenty of them came
back rate-limited, which looked to the organizer like people missing from the
map for no reason. Repeated addresses within one batch are looked up once.

## The map

Pins are drawn per *location*, not per person. Two mothers in the same building
used to be two markers on the same pixel, so the second was invisible: a
17-person dataset showed as 7 dots with nothing to indicate the rest were
underneath. A shared pin is now drawn slightly larger, carries a count, and its
popup lists everyone standing on it.

The view frames itself around the pins that exist, rather than opening on a
fixed city. A hardcoded Helsinki view left a Tampere dataset off-screen
entirely. Pressing **Sync with Google Sheet** re-frames it; panning and zooming
by hand is not undone by a re-render.

Clicking a person anywhere on their row in any list rings them on the map,
zooms in far enough that neighbouring buildings separate, and opens their
popup. The row itself is marked so it is clear which dot belongs to which name.
Rows that could not be placed have no such control, so clicking them is inert
rather than a dead end.

## Sheet columns

Applicant data is read by column heading, not position, so columns can be
reordered freely. The tool reads `Identity number`, `Name`, `Neighbourhood`,
`Street address`, `Transport`, `Language`, `travel time`, `Date of birth`,
`Phone number`, `Older child`, `amount of children`, `worries`, `hopes`,
`questions`, `source`, `My notes`, `Mum's status`, `Village` and
`Village status`. It writes back to `Match Status` and `Match Group ID`,
creating those two columns on first run if they are missing.

`Village` is coordinator-maintained: anyone with a value there is treated as
already placed, so they drop out of the unmatched pool and appear under that
village in Active Groups.

### Expecting mothers

`Date of birth` holds a **due date as often as a birthday**. Matching before
the birth is deliberate: a village takes time to warm up, and it is needed most
in the first weeks, when there is least energy to go looking for one. Dates up
to ten months ahead are accepted (a full pregnancy from the earliest a due
date is known), while still rejecting a mistyped year.

The matching engine needs no special case for this. Age is compared as months
between members, and two due dates a month apart are a month apart exactly as
two birthdays are, so `maxAgeGap` groups expecting mothers with each other and
with newborns at the right distance. What does change is the coordinator's
side: anyone still expecting is marked `expecting` on their row, their date is
labelled **Due** rather than **Baby DOB**, and the map popup says so, because
it changes how you write to her and which group she belongs in.

Accepted dates are bounded by `DOB_MAX_MONTHS_AHEAD` and
`DOB_MAX_YEARS_PAST` in `src/validation.js`. The backward bound is generous on
purpose: a rolling application means a "youngest child" can be a couple of
years old by the time a group forms.

## Match quality scoring

Every candidate group gets a 0..1 quality score, used both to grow groups
(each step adds whichever eligible candidate produces the highest-scoring
group) and to order the review list so the strongest matches appear first.

| Signal | Weight | What it measures |
|---|---|---|
| Travel | 0.5 | Worst pairwise journey as a fraction of that member's own stated limit. Scored on the worst pair, not the average, because a group is only as reachable as its most burdened member. |
| Age | 0.3 | How tight the baby age spread is, rather than merely staying under `maxAgeGap`. |
| Language | 0.2 | How much of the members' language repertoires is common ground, so nobody has to fall back to a second language. |

Travel is weighted highest because a group that is awkward to reach won't
actually meet. The weights live in `SCORE_WEIGHTS` in
`src/matching-engine.js` if they need tuning.

Each candidate card shows its rank, the overall score, and a bar per signal,
so a group that is weak on one dimension is distinguishable from one that is
mediocre across the board.

Scoring only ranks groups that already pass the hard constraints in
`fitsGroup` (shared language, age gap, travel time within each member's
limit) — it never lets an ineligible group through.

## Travel times

Groups meet at a café or park rather than at each other's homes, so the check
is whether each person can reach a meeting point within their own stated limit
using their own transport, not whether either could travel the whole way. A
mode's fixed overhead (walking to the stop, waiting for the bus) is not halved
— only the moving time is.

Public transport times come from Digitransit's scheduled router
(`planConnection`), asked for at a fixed weekday mid-morning so results don't
depend on when matching is run, and including the wait for the first departure.
Walking, cycling and driving come from the same router, asked for one mode at
a time.

Every routed value is checked before it is used: too fast for the mode over
that distance, or far slower than the speed model allows, and it is discarded
in favour of an estimate and counted separately in the note. This catches a
routing call that succeeds but answers with something impossible — a unit
mix-up, or a router silently ignoring the requested mode. It does not catch a
time that is merely wrong but believable; that has to be prevented at source.

If a routing call fails, the engine
falls back to a straight-line speed estimate from `MODE_MODEL` — the New
Matches tab states how many journeys were routed and how many were estimated,
because a dead routing API otherwise looks identical to a healthy one.

Seeds are taken most-constrained-first: whoever can reach the fewest others
forms a group before someone better connected takes their only option.

## Known simplifications

- Greedy best-fit clustering heuristic, not an optimal solver. Seeds are taken
  most-constrained-first, which helps, but a group formed early can still take
  someone a later group needed more — members are never reconsidered once
  placed.
- The neighbourhood *filter* and the group naming still compare the
  Neighbourhood column as an exact string, so two spellings of one district read
  as two places there. Geocoding is tolerant of spelling (see Messy addresses);
  this bullet is only about the filter and the generated group name.
- Per-member outreach stage tracking was removed along with the village
  rewrite. `Match Status` is still written on approval, but the UI no longer
  advances it through contacted/confirmed/introduced, and only the first
  WhatsApp template in Settings has a consumer.
- No multi-user support — designed for a single organizer
