# Leaderboard (app key `performance`) — GX 2.0 app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app integrates with it (binds the `GXCore` Apps Script library; forwards bug reports
to it, and reads its changelog). Its app key in GX Core is **`performance`**.

**This file is rules only (since 2026-10-09).** The stories, measurements and failed first attempts
behind each rule are in **`docs/claude-md-history.md`** — the whole previous file, frozen.
**Read the history section a rule points at before changing code that rule guards.** Each `Hist:` quotes
words from the history heading to search for. This file wins on any disagreement.

## Stack & local loop

**No build step — the file on disk IS the app.** This is the **all-staff kiosk**, the most visible surface
in the suite; ship accordingly.

| | |
|---|---|
| frontend | `index.html` (~12k lines, monolith) on GitHub Pages |
| backend | `.gs` files at the repo root, deployed with clasp |
| tests | **`tests/*_test.js`** (node) — covers the pure functions where a silent bug would corrupt revenue, goals or rankings. `tests.gs` is now editor-only Dutchie diagnostics |
| run | `python3 serve.py` → <http://localhost:8181> (`--lan` for a kiosk/phone) |
| ship | commit → push (Pages) → `./deploy.sh "message"` |

**`deploy.sh` here is this app's OWN full pipeline, not the shared recorder** *(made explicit
2026-10-09; previously contradicted, not implied, by history § "Stack & local loop", which listed
`deploy.sh` among the files synced from gx-theme. Source: `deploy.sh`'s own header and the suite
`CLAUDE.md` correction of 2026-09-17.)*

- It stamps the version from the **git commit count** (`COUNT=$(git rev-list --count HEAD)`,
  `v$((1 + COUNT/1000)).$(printf %03d $((COUNT % 1000)))`), writes it into `index.html`, pushes to GAS
  *and* Pages, and records the release.
- **Do not touch `GC.VERSION`; just run `./deploy.sh "message"` and read the version it prints.** A hand
  bump is overwritten by the deploy that follows it, and the commit message ends up naming a version
  the app never ran.
- **Never sync the shared `deploy.sh` over it.** The gx-theme copy is only a version RECORDER — it files
  an `app_versions` row and deploys nothing, so syncing it here does not update the app, it removes its
  ability to deploy at all. The `# gx-sync:keep-local` marker on line 2 is what makes `./gx-sync.sh`
  skip it; never remove that marker.

**The tests gate the push.** `node tests/<name>_test.js` runs one suite; `gx-preflight.sh` (the pre-push
hook) runs every `tests/*_test.js` and **refuses the push** on a failure. Run them after touching any
revenue, goal or ranking math:

```bash
for t in tests/*_test.js; do node "$t"; done
```

Each test loads the shipped `.gs` file **as text** (`tests/_harness.js` → `load()`) with the Apps Script
globals stubbed, then calls the real function. **Never copy a function into a test** — a test carrying its
own copy passes forever while production drifts away from it. `Utilities.formatDate` in the harness is a
genuine ICU/`Intl` implementation, not a fixture, because every PT date helper depends on real DST math.

`tests.gs` still ships to Apps Script but holds only `diagAlertProration` and `diagPagination` — live
Dutchie diagnostics with no pass/fail, run from the editor.

`docs-mocks/` holds design mocks and handoff notes (kiosk hero, standings, EOM card, avatar picker) — read
them for intent, but they are **not shipped code** and nothing references them. Renamed from `mocks/` on
2026-08-22. `src/fixtures` backs fixture mode.

The dev server talks to the **live** backend; `gx-dev.js` blocks writes until armed. `gx-preflight.sh` runs
as a **pre-push hook** and refuses dev leftovers (fixtures on, writes armed, localhost URLs, `@devonly`).

**Shared files** (`serve.py`, `gx-preflight.sh`, `.claude/gx-brain-notes.sh`) come from **gx-theme** via
`./gx-sync.sh`. Edit them **there** (gx-theme is core-admin's — last section), then re-sync; an edit here
is overwritten. This CLAUDE.md is **not** synced.

Hist: "Stack & local loop".

## Incentive lives in GX Crew — the old engine here was retired (2026-09-14)

Incentive/compensation moved **out of** this app into **GX Crew** (decision 2026-08-16). The sequence
was: promote the per-employee metrics and discretionary-discount classification to a shared home
first, then cut Crew over. Both happened — GX Core computes the slice (`incentive_perf`) and Crew
has read it since `cfg.incentiveEngine` flipped to `gxcore` on 2026-09-01.

- **So the old engine is gone from here.** Removed: the `incentive`, `saveincentive`, `incentiveperf`,
  `frozenperiod`, `frozenperiods` and `applydiscounttargets` routes, `getIncentiveData_`,
  `computeIncentivePerf_`, `saveIncentiveInputs_`, the sky/mike access gate and its tests.
- **The Script Properties themselves were left in place** (`GC_INC_PERF_*`,
  `GC_INCENTIVE_INPUTS_JSON`) — code only, no pay data deleted. They are closed pay periods: leave them
  *(made explicit 2026-10-09; previously implied by this section)*. All 28 frozen closed-period
  snapshots matched GX Core's `incentive_frozen` archive byte-for-byte (sha256) before removal; the 29th
  key is the superseded v1 snapshot for 2026-06-22.
- **What stays, and must:** `discounts.gs` (the registry and classification, published to Core kv
  `discountRegistry`), the `discountrules` route (Crew's fallback read — keep it until this app is
  deleted outright), and `getIncentiveThresholds_` / `incentiveDefaults_`, which the kiosk still uses
  for its discount color target.

Hist: "Incentive lives in GX Crew".

## SPIFF — the contracts (history: same "Incentive lives in GX Crew" section, lower half)

- **There is no `spiff_payouts` tab and this app never read one.** It is not in `GX_TABS`, nothing writes
  it, nothing reads it — the claim was invented in documentation. SPIFF keeps its payout data in its own
  sheet. The real Leaderboard↔Core contract is `goal_publications` (Leaderboard publishes, Sales
  consumes). **This repo is the PRODUCER.** Gated here by `tests/cross_app_contract_test.js`, a wrapper
  that runs the canonical test in the hub, `greencross-command-center/tests/cross_app_goals_contract_test.js`
  (which drives the real consumer against the real producer's shape), so this repo's pre-push hook is
  gated by it too. It prints `SKIP` and passes when the hub is not a sibling checkout — a skip is not
  coverage. *Corrected 2026-10-09: this said "covered by `tests/cross_app_goals_contract_test.js`", which
  is the hub's file name; no file of that name exists in this repo's `tests/`.*
- **There IS a SPIFF contract now, and it is the other direction (2026-09-08).** SPIFF publishes each pay
  period's finished per-employee sell-through and payout to GX Core's **`spiff_publications`** tab after
  every hourly refresh; this app reads it back with `GXCore.publishedSpiffProgress(secret, scope)` and
  folds it onto the kiosk staff cards. Never call SPIFF's `/exec` directly — `spiff.gs` used to, knowingly
  app-to-app *(reworded 2026-10-09; original in history § "Incentive lives in GX Crew")*.
- **Core stores the payload verbatim and never recomputes it**, so a SPIFF that stops publishing does not
  fail — it just gets older, and nothing throws anywhere. `spiff.gs` therefore refuses any scope older
  than `cfg.spiffStaleHours` (GX Core's own watchdog threshold, so the alert and the screen agree) rather
  than drawing a fortnight-old bar on the kiosk.
- **A payload is filed under the pay period the PROGRAM started in, not the current one.** A SPIFF that
  began last fortnight and is still running is filed under the previous scope, so reading only the
  current one drops a live program off every card. `SPIFF_LOOKBACK_PERIODS` reads three back and merges.
- **The program copy is on a SIDECAR, never on the row (2026-09-12).** The five things the kiosk
  popup shows that a per-employee row cannot say — the product in words, each store's goal, what the
  program pays *and how*, Tawny's selling tips, and when it was measured — arrive as
  `payload.programs[]`, **one entry per program, joined by `program_id`**. A reader for row columns finds
  nothing forever and draws a card with every block missing, with no error anywhere. The
  spellings: `programs[].product`, `store_goals[store_id]` (a MAP, not a number — `bt_goals[store_id]`
  is the per-person goal and the one the bars are drawn against), `payout` + `payout_type`, `tips` (a
  real array), and `payload.refreshed_at` — **there is no `measured_at`**. `payout_type` is the one
  that costs money if ignored: on `per_unit` the payout is **per unit sold with no threshold at all**,
  so "$0.75 when you hit it" is a wrong dollar figure on a wall screen. Gated end-to-end by
  `tests/spiff_sidecar_contract_test.js`, which builds the sidecar with SPIFF's **own** `programsFor_`
  off its shipped source and renders it with the shipped `GC.spiffPanel` — a fixture of ours would
  only re-assert the shape we already believed in, which is how this went wrong the first time.

## SPIFF — the kiosk popup (one view, drawn here)

- **The kiosk's SPIFF button opens a popup Leaderboard DRAWS** — a card over the dimmed board, not
  `window.open`, which a kiosk browser blocks (Sky, 2026-09-11). `GC.views.openSpiffBoard` paints
  `GC.spiffPanel` into `#kioskSpiffPanel` from data the kiosk already holds — no wait, no fetch, and
  painted fresh on every open.
- **The panel is SPIFF's redesigned board, drawn here (Sky's decision, 2026-09-16), not a framed
  `store.html`.** `store.html` calls SPIFF's engine for its own data, so framing it puts SPIFF's uptime
  in front of the most visible screen in the company. **The panel reads Core's published copy, which
  AGES rather than dies** — and `spiff.gs` already refuses a scope older than the watchdog threshold, so
  it cannot go quietly stale either. Publish, don't proxy, applied to the popup and not only to the
  numbers.
- **The iframe fallback is GONE (2026-09-17) — do not bring a second rendering back.** `applySpiffLink`,
  `spiffPanelHasSpiffCopy_`, the iframe, its warming and `.kso-frame` are all gone. The fix was removal,
  not a third place that fixes the state: **a view chosen in three places is wrong in whichever one
  nobody re-reads.** (`renderSpiffOverlay` painted the frame VISIBLE and our panel HIDDEN whenever the
  store had a token, with `openSpiffBoard` correcting it on the way in — so a full re-render while the
  popup was OPEN, `checkRemoteRefresh` → `renderKiosk`, put SPIFF's page on a kiosk mid-read.)
- **The store's token is still minted by `spiffKioskUrl_` (`spiff.gs`) and still in
  `cfg.spiffKiosk.<core store_id>`** (GX Core kv; one permanent token per store, keyed on the GX Core
  `store_id`, not Leaderboard's slug), for the direct link Sky or Tawny opens by hand — SPIFF's own
  per-store board, `store.html?t=<token>`. **The kiosk no longer reads it, and since 2026-10-09 the
  engine no longer sends it:** `spiffKioskUrl` was removed from both kiosk payloads once nothing read
  it. `spiffKioskUrl_` now feeds only the `spiffdiag` route; the link people open by hand comes from
  SPIFF's own Settings → Kiosk links, which never went through this app.
- **`spiffKioskUrl_` has three answers and they are NOT the same:** the URL, `''` when the store has no
  token, and `null` when it could not find out. An unknown folded into a falsy is the bug; an absence
  needs its own state.
- **Settings → Include SPIFF is the one switch for the button** — the same switch as the staff-card
  rows, so the setting and the button cannot disagree. The token plays no part. The button and the
  overlay are ALWAYS in the markup, hidden when off — not omitted — so the 5-minute refresh can reveal
  them on a painted screen; `GC.views.applySpiffState` owns `hidden`. **Undefined is not off:** an
  engine that does not send `spiffOn` must leave the screen exactly as it is. Switched off while open,
  the popup closes.
- **The popup closes itself, and must always be dismissible:** a wall screen has no chrome, so a popup
  nobody can dismiss is the board gone for the shift. `KIOSK_SPIFF_AUTOCLOSE_S` (120) counts down on
  the popup's bar — shown, because a screen that closes with no warning reads as a crash. Any touch
  restarts the clock; the scrim and the Close button both close it.

*Corrected 2026-10-09, checked against `index.html` and `spiff.gs`. This file said three things that
stopped being true when the frame was removed on 2026-09-17: "The frame is loaded at kiosk paint and
left loaded"; "Leaderboard reads the token live on every poll, so a rotation reaches a running kiosk
in ~60s"; and "The token decides only what the button OPENS". There is no frame, the poll applies the
token to nothing, and the button opens one thing. They remain in the history file as written.*
- **Two faithful implementations of one design are nearly indistinguishable on a screenshot, so the data
  is what tells you which you are looking at.** SPIFF's page shows a vendor-prefixed title (their
  `programLabel()`) and full names; ours shows the plain program name and the kiosk's first names.

**The source of truth for the LOOK is SPIFF's handoff bundle**,
`greencross-spiff/design_handoff_spiff_kiosk_board/README.md` — not this repo's CSS and not `store.css`.
Three stacked cards: the program (vendor, name, what to sell, and three figures — what it pays, units
to hit your bonus, days left), then the BOARD as the centerpiece, then Tawny's tips. Not guessable from
the code:

- **The board is the point.** Ranked by units descending with rank numbers, 46px rows, and everyone at
  the store on it *including everyone at zero* — a board listing only sellers cannot tell you whether
  you are behind or simply not in this one.
- **No earnings per person.** A kiosk is a shared screen a customer can read over the counter, which is
  why SPIFF's own `storeView` returns no earnings, cost, investment or ROI at all. The figure is still on
  our payload; it no longer reaches the screen — **nobody's pay can reach a wall screen**, and a test
  guards it.
- **The bars went green and are clamped at the goal.** The handoff specifies green, and the overshoot
  is already stated in words one column right ("11/8"), so the hash carried nothing the row did not say
  — no gold-on-hit, no overshoot hash here. **Gold still means money on the cards; on this panel it is
  reserved for days left at three or fewer** — the one thing here that is running out. A per-unit
  program has no goal to be a fraction of, so its bars scale against the LEADER, which makes the bar a
  comparison rather than a promise.
- **The store-attainment track takes the store's live registry color**, through the `--store-<slug>` var
  `GC.loadStoreColors()` has already overlaid with GX Core values — so a Command Center edit reaches the
  wall without a deploy and a seventh store inherits its own color. The slug comes off the URL hash and
  goes inside a style attribute, so it is whitelisted to the shape a slug can have rather than escaped:
  `--store-<anything>` is a var name, and an escaper built for text is the wrong tool for one.
- **The page-level store name and the "as of" stamp are gone** — the popup's own bar already says SPIFF
  and names the store. `measuredAt` still arrives on the payload and is simply not drawn.

Gated by `tests/spiff_popup_test.js` (one-view popup: the overlay markup contains no second rendering and
the panel is never painted hidden; *named `spiff_store_window_test.js` in older notes — no such file has
ever existed*), `tests/spiff_panel_test.js` and `tests/spiff_sidecar_contract_test.js`, which drive the
shipped `GC.spiffPanel`.

Hist: "The kiosk's SPIFF button opens", "The iframe fallback is GONE".

## The name on a tile is DERIVED, and only disambiguates when it has to (2026-09-15)

- A kiosk tile has no room for a surname, so the board shows first names — **except** where two people
  would read the same, and those get GX Core's `short_name` ("Nate S", "Zach B"). Sky's call over
  initials for all 42. The comparison is on the **casual** form, which is `short_name` with
  Core's trailing initial taken back off; grouping on `preferred_name` instead would see "Zach B" and
  "Zach R" as two different names and find no collision at all. A name can therefore change when
  somebody ELSE is hired or leaves — that is the point, not a bug.
- **THE COLLISION IS COUNTED AT ONE STORE, NOT ACROSS THE CHAIN (Sky, 2026-09-17.)** *"we only need to
  add the last initial if two people have the same name at the same store, so at Baseline we have two
  Zach's, we need it, at Century we only have one Nate, don't need it."* A Nate at Century and a
  different Nate at Portland are two people who can never appear on the same board.
  `getNicknames_(store)` scopes it; `getNicknames_()` with no argument still counts the chain, which is
  right for the director's staff table and the badge strip because those list every store at once.
  **The caller says which question it is asking** rather than one answer trying to serve both.
- Scoping is by **home store**, through `gxRecBelongsToStore_` (the rec-taking half of
  `gxBelongsToStore_`, split out so the roster walk does not re-resolve every key by name). It answers
  TRUE when it cannot judge — no home store, or a cold registry — so an unknown never quietly drops
  somebody from the count and un-disambiguates a name that needed it.
- **The edge it does not cover:** two same-named people from different stores both covering a shift at a
  third store would show two identical tiles. Home store is what "at the same store" means for a
  roster, and the board's set is really home crew ∪ today's sellers; closing that would mean passing
  the day's sellers into the name derivation. Not done, and worth knowing before someone reports it.
- **Guarded per surface, because they do not share a function:** the **tiles** come from
  `getStoreLeaderboard`, the **ticker** and **shift strip** from `getStoreToday`, and the director table
  from `getDirectorStaff`. Guard all three; the first pass left the tiles passing while un-scoped.
- **It is not simply `preferred_name`.** A disambiguator written INTO the nickname ("Zach B") is wrong in
  every app that also shows a surname ("Zach B Babcock"). The kiosk takes Core's `short_name`;
  `preferred_name` is the plain nickname suite-wide.
- **`gxShortNameOf_` carries a stopgap: delete it when Core's data is clean.** Until `preferred_name`
  is cleared to plain "Zach", Core derives `short_name` as **"Zach B B"**, so we collapse a doubled
  trailing initial locally. That is what let this ship WITHOUT a coordination window — the board reads
  right on either side of core-admin's data write, in either order. It goes inert the moment Core strips the repeat itself or the data is
  corrected; it is not load-bearing after that.
- **One name per person, one place that decides it.** The ticker's own disambiguator is gone;
  `makeTicker_` uses the name it was given. Do not give any surface its own
  *(made explicit 2026-10-09; previously implied by this section)*.
- **The initial comes back OFF wherever a surname is shown (2026-09-16).** `gxWithSurname_` in
  `gx_roster.gs` is the one rule, used by `gxDisplayNameOf_` and by the director's staff table (which
  pairs the nickname with the surname **Dutchie** holds, not the one Core holds — two callers, and they
  were allowed to differ). It drops a trailing lone initial only when that initial is the surname's own
  first letter, so a nickname that genuinely ends in a letter survives, and it goes inert once Core
  derives `short_name` for everyone.
- A second casual-name map was deleted rather than shipped as belt-and-braces — **a branch no test can
  fail is a branch nobody can trust.** (The nickname is only ever found by matching the Dutchie name,
  and then the two surnames agree by construction.)

Gated by `tests/short_name_test.js`, which asserts BOTH data states, drives the real `getStoreToday`
for the ticker and the real `getDirectorStaff` for the table. `getNicknames_` is in `goals.gs`; the
helpers are in `gx_roster.gs`.

Hist: "The name on a tile is DERIVED".

## A number never reads "+0%" or "−0%" (2026-09-16)

- There is no amount of below-zero that displays as zero. Never decide the sign from the RAW value and
  then print the ROUNDED one *(reworded 2026-10-09; original in history § "A number never reads")*.
- **`GC.fmtSignedPct(frac, decimals)` is the one definition** — it asks "does this round to zero at
  the precision THIS surface shows?", which no single epsilon could answer, because the gauges round
  to whole percent and the store table to one decimal. Do not hand-roll
  `(p >= 0 ? '+' : '−') + Math.abs(...)`; there were **six** copies (the store table's vs.-plan column,
  the director and kiosk pace gauges, the sparkline badge, the historical store cards, the Sky wall).
- The same rule in other units: `fmtDeltaNum` judges the rounded value, and the standings rows sign off
  rounded dollars.
- **Never hardcode `▲ +` in front of a raw number** *(reworded 2026-10-09; original in history § "A
  number never reads")* — a period that discounted LESS read "▲ +-$412.00". Avg UPT, Total Discounts
  and Discount Rate now go through `fmtDeltaDecimal` / `fmtDeltaCurrency` / `fmtDeltaPts`.
- `tests/signed_zero_test.js` drives every call site and the real `GC.renderKpiBlock`, not just the
  helper — the three prefixes were in the WIRING, and a helper-only assertion would have passed with
  them still there. It also greps for a **two-way** sign split (plus or minus, no branch for zero),
  which is the shape that cannot print a bare 0% whatever it is fed; a three-way split on a rounded
  value is the fix, not the bug.

Hist: "A number never reads".

## A secret must never reach the screen inside an error (2026-09-15)

- Three of this app's URLs carry a secret **in the query string**: `dutchie_keys?connector_secret=`
  (`GX_CONNECTOR_SECRET` — the key that unlocks the Dutchie credentials), and `app_roster` and
  `gxCoreRoute_`, both with `GX_DEPLOY_SECRET`.
- **`muteHttpExceptions: true` silences a STATUS code, not a transport failure** — an unreachable host
  still throws, and Google's own message is `Address unavailable: <the whole url>`. Unscrubbed, that
  renders in the kiosk's error banner in front of the shop.
- `scrubSecrets_` (in `dutchie_proxy.gs`, next to `jsonOut`) is applied at **both router catches and at
  all three fetches** — at source so nothing secret is ever inside a thrown message, at the router as
  the backstop that covers the route added next year. Source matters on its own: several handlers
  catch and return `{ok:false, error}` straight into `jsonOut` without ever reaching `doGet`'s catch.
- **It must not be anchored to `?`/`&`** — the highest-value secret here travels as
  `connector_**secret**=`, where `secret=` follows an underscore, so an anchor-only form matches nothing.
- **It must cover every name the session token arrives under:** `requireAuth_` accepts `token`,
  `session` *or* `auth`, so knowing only `token=` leaves two thirds of the door open.
  `tests/error_scrub_test.js` asserts both — it runs an anchor-only regex on the real URL and requires
  it to leak.
- **Derive the names from `requireAuth_`, and do not copy another app's regex — not even the best
  one.** Inventory's `SECRET_PARAM_RE_`, Sales and Crew *all* miss `session=` (two also miss `auth=`).
  Crew's is anchor-only, which is safe *in Crew* — it carries no prefixed secret parameter at all — and
  wrong to copy anywhere that does. Prefixed parameters by app, counted 2026-09-15: leaderboard 7,
  inventory 9, core-admin 5, and crew, sales, spiff, pricecards 0.
- **If `requireAuth_` ever learns a fourth name, it goes in `scrubSecrets_` in the same commit.**
- That suite **never greps a file for the scrub**, which is how SPIFF's own version passed while
  proving nothing (it matched a scrub inside a different function). It drives the real `doGet` and
  `doPost` and reads the served body, and every one of the five scrubs was proven red by removing it.

Hist: "A secret must never reach the screen".

## A part period is compared against the same PART of the one before (2026-09-16)

`getDateRange_('pp')` runs to `ppEndMs` — the end of the **whole** fortnight, including days that have
not happened. Comparing that against a full prior period is the calendar, not a signal.

- **`getPriorRange_` is now the elapsed-aligned window; `getPriorFullRange_` is the whole period.**
  Aligning on elapsed days also aligns the **weekdays**: a pay period is a whole number of weeks, so day
  N of this one is the same weekday as day N of the last.
- **Totals use the aligned window, rates use the full period, and that split is deliberate.** An AOV
  or a discount rate is not distorted by how long you measure it, and the longer window is the steadier
  benchmark. Sales / Hour is the exception among the rates: it is aligned, because the weekday
  argument above beats the steadiness one inside a period.
- **The card SAYS which basis each number used** (`summary.comparison` → the `.kpi-basis` line). When a
  caller pre-fetched the aligned window and not the full one, the rates fall back to the aligned window
  and `rateDays` reports that, so a narrower benchmark is labeled rather than silent — going and
  fetching would put a live Dutchie call inside a path whose contract is "I already have the data".
- **`getPriorRange_` ends at the same wall-clock instant on its last day** (2026-09-17), and the card
  says **`, to this time`** on the totals basis line when the cut is live. A total that climbs through
  the day with no label reads as a fault.
- **`ptDateTimeToUtcMs_` exists because midnight-plus-elapsed-ms is wrong.** It ROUND-TRIPS — builds
  both the UTC-7 and UTC-8 candidates and keeps the one that formats back to the date and hour asked
  for. The ambiguous fall-back hour resolves to its first occurrence; the spring-forward gap resolves
  forward. **At 11am the naive form gives the same answer**, so the 11am DST test cannot be the guard
  for it — the discriminating cases are the first three hours of a transition day, and they have their
  own test. A board IS read at 1am: the kiosks run all night and reload at 04:00.
- **A PART-DAY MUST NEVER ENTER THE DAY CACHE.** `GC_DAYAGG_v2_<slug>_<date>` names only the date, so
  slicing a settled day would write a short day under the whole-day key and every later reader —
  month-to-date, the rate benchmark, the historical store cards — would get it silently.
  `daysOfRange_` marks each slice `whole`, and `byStoreAggCached_` refuses to treat a part-day as
  settled, for the read as well as the write.
- **Sales / Hour divides by the open hours that have HAPPENED**, and each side still keeps its own
  span. Collapsing to one shared divisor is tempting and wrong: it is correct only while the windows
  are equal, and they are NOT when the prior window is **clamped** (30 days into March against a 28-day
  February). That clamp is the only case that catches it.
- **Discounting more is no longer green.** The delta's color class was picked off the arrow glyph and
  `.up` is green, so a period that discounted MORE rendered a green ▲ on both Total Discounts and
  Discount Rate. The arrow still says which way; `invert` flips only the color.
- **One discrepancy recorded rather than fixed:** `ptDateToUtcMs_` probes the offset at noon UTC, so on
  the November fall-back date it reports midnight an hour late (08:00Z; the day begins at 07:00Z). Left
  alone deliberately: that helper sets the day boundary for the whole app including every cache key,
  and moving it to chase an hour with no trade is a far larger blast radius. Asserted in the test so it
  is a known quantity. Do not "fix" it in passing
  *(made explicit 2026-10-09; previously implied by § "…AND AT THE SAME TIME OF DAY")*.
- Small-row order is the four trade numbers then the two staff cards, asserted as an order.

Gated by `tests/kpi_comparison_window_test.js`: the windows, the DST close instant, the February
clamp, the registry-driven period length, and the summary end to end. Two places a wrong divisor
passes by accident — the Sales/Hour divisor only differs from `daysElapsed` when the window is
**clamped**, and `toLocal` survives naive ms arithmetic because PT midnight is 07:00/08:00 UTC either
way.

Hist: "A part period is compared", "AND AT THE SAME TIME OF DAY".

## The /exec stall rate is a SIX-WIDE number — cite it that way or not at all (2026-09-17)

Four places in this repo lean on Sales' 2026-09-15 measurement of GX Core's `/exec` second hop — the
cold-start paint and its test, and the one-call kiosk route and its test. **The only citable figure
is: 6 of 174 requests fired six-wide (3.4%) HANG for 11-60 seconds instead of failing.** Six-wide is
the shape a kiosk load actually fires, which is why it is the condition that applies to us.

- **It was not measured on `libversion`.** All 234 requests were authenticated store-month pulls
  carrying 2.5-3.5s of Sales' own backend work, so the run cannot separate Google's hop from Apps
  Script executing a query.
- **Six-wide `libversion` runs HAVE been done, and they do not replace 3.4% — they show the stalls are
  not independent.** Sales ran three (240 requests each): 2026-09-17, 6 stalls (2.5%), all six in ONE
  round; 2026-09-18 morning, 18 (7.5%), 13 of them in five consecutive rounds; 2026-09-18 evening, 10
  (4.2%), 9 in one stretch. Stalls arrive in **windows** lasting from ~27 seconds to minutes. "The hop
  goes away and takes everything in flight" is the extreme case (09-17), not the rule — on 09-18 no
  round lost all six. Compare those runs with each other, never with the 3.4% store-pull baseline.
  Three runs is a hint, not a distribution. *Corrected 2026-10-09: this said of such a run "Nobody has
  done one". Evidence: `greencross-sales/docs/claude-md-history.md` § "THE STALLS ARE NOT INDEPENDENT",
  and `endpoints.gs` in this repo, which already cited the 09-17 result.*
- **The wider sweeps are our own queueing, not a worse hop.** Every GX app runs its Apps Script as
  `sky@`, Google caps simultaneous executions at **30 per account**, and the suite peaked at 114 on
  2026-09-15. A 30-wide sweep from one machine is at the cap by itself. Same cap the randomized retry
  spread in `retryDelay_` exists for.
- **The count at 30-wide is a floor** (`>=4`; totals `>=12 of 234`). The true number is unknown without
  re-running.
- **So: never restate this as "10%", and never average the conditions into "3-10%" — that range
  describes neither one.** The apparent 12-30-wide effect tests at p~0.06 (Fisher, one-sided,
  conditioned on the 12 stalls the run actually produced), not the p~0.02 you get by treating the
  six-wide rate as known when it came out of the same run. One evening, unreplicated.
- The full ledger is in `greencross-sales/CLAUDE.md` under the v2.597 heading. `8/234` and `6/174` both
  print as "3.4%": check the counts, not the headline.
- Separately and still true: the `~6% of rapid calls 404` figure in `dutchie_fetch.gs` and the
  `16-45s` in `gxdevlogin.sh` are **different measurements of different things**. Don't reconcile them
  with this one.

Hist: "The /exec stall rate".

## The kiosk's figures COUNT UP, and an agent's browser pane cannot watch them (2026-10-05)

**The headline dollars animate from zero.** `document.visibilityState` is **`hidden`** in a Claude
browser pane, browsers throttle `requestAnimationFrame` in a hidden tab, so the count-up barely
advances while an agent looks at it. Read the text then and the board says **`$0 SOLD`** — next to
budtender rows showing **111%** and a `DAILY GOAL HIT` banner. That was reported to Sky as a display bug;
the real kiosk was fine the whole time.

- **Measure the DATA, not the pixels.** Call the route the page calls (`?action=kioskall`; also
  `?action=storetoday`) and compare.
- **Structure is safe to read in a hidden tab; motion is not.** Node counts, mount counts and
  whether text is present are synchronous. An animated numeric string is not.
- **The tell:** `$0` beside `111%` is self-contradicting — the percentage was computed from a number the
  display had not finished counting to. Two readings of one fact disagreeing is a reason to re-measure,
  never to report.
- This is the second instance in the suite; `greencross-sales/CLAUDE.md` records the first under the
  v2.573 poll work. Knowing the mechanism did not prevent repeating it.
- **Do NOT "fix" the kiosk in response to a `$0` seen this way.** There is nothing to fix, and the
  figures are correct on every real display.

Hist: "The kiosk's figures COUNT UP".

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX Core
— the sync protocol lives in that one command, not copied here. **"brain sync" / "sync brain"** = the
reconcile-and-report step alone (skips orientation).

Coordination is the **central brain-notes inbox** in GX Core (this repo's `BRAIN_NOTES.md` was retired
and deleted): `/gxbrain` reads notes addressed to `to_app=performance`, resolves done ones
(`resolve_note`), and writes note-backs to any app (`add_note`). The SessionStart hook surfaces the same
inbox.

App-specific facts for the sync check: app key **`performance`** in GX Core; integrated via bug forwarding
(`gxIngestBug` + `tab`), and auto-record on deploy (central `deploy_version` endpoint + shared untracked
`.gx_deploy_secret`).

**The changelog is read from GX Core's `version_history` ROUTE** — `index.html` calls
`GXClient(GXCORE).jsonp('version_history', { app: 'performance' })`. `version_history` is a route, not a
tab: it reads the **`app_versions`** tab, which `deploy_version` writes. *Corrected 2026-10-09: this
said "changelog read from `version_history`", which read as a tab name.*

**Which `GXCore` version this app runs: ask the running app (`?action=libversion`).** Never this file
and never `appsscript.json` — a call runs the version the live DEPLOYMENT snapshotted, so a re-pin that
was not deployed changed nothing. No pinned version number is written here, on purpose: three times
this line named one and the pin moved on without it. *Corrected 2026-10-09: this said "`appsscript.json`
pins `GXCore` v330"; the repo had already moved past it.* One floor that is not a pin and still
matters: `GXCore.setAvatar` — the single avatar write — **does not exist before 225**, so an
un-deployed re-pin is not a stale note, it is every avatar save on the kiosk throwing.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next
prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app. It
reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) when you need its id for the `curl` — but **refer to it by its `title`, never its id**. `job_mtg9vyxs_ewd9` means nothing to Sky; every job carries the to-do text in the same response the id came from, so say that instead, summarized if it's long ("the employee email column"). Same for `bug_…` and note ids. **Then re-list what's open, numbered `[1] [2] [3]…`, instead of proposing a next task** — re-fetch `action=whats_next` (the board moved while you worked) and let Sky pick by number rather than from memory.

Hist: "Sync with the brain".

## The HUB is core-admin's — send a note, don't edit (rule from Sky, 2026-09-02 · applied here 2026-09-06)

**Never edit `greencross-command-center` or `greencross-gx-theme` from this chat.** Both belong to
core-admin. It is here because it was broken, not because it was theorized: two sessions sharing one
Dropbox checkout shipped an unreviewed GX Core change as library v284.

Two sessions cannot share a git checkout. Neither can see the other, `git checkout -b` is not atomic
against a second process, and the loser finds out afterwards by reading the log.

**So from Leaderboard: `add_note` to `core-admin` with what you need and why, and stop.** Requests are
welcome and quick, and the hub session holds the repo alone while it works.

**Where the line is, because over-applying this is its own failure:**

- **Reading the hub is fine and often necessary** — `gx_core.gs` is the source of truth for every
  route Leaderboard calls, and guessing a payload shape instead of reading it is how this suite invented a
  `spiff_payouts` tab that never existed. Read freely; run `./gxpins.sh`; diff against it.
- **Calling GX Core's HTTP routes is not editing it.** `deploy.sh`, `gxengine.sh`, `set_config`,
  `bug_update`, `resolve_note`, `add_note` and the rest are the documented interface, secret-gated and
  designed for exactly this. Changing a *setting* through `set_config` is a config change Leaderboard owns;
  changing *code* is not.
- **Do not restyle a shared component from inside Leaderboard either.** A local rule that beats `.gx-btn-green`
  wins here and silently diverges from the other five — that is how the suite ended up with six
  different login screens. The test is *"should all six get this?"*
- **Leaderboard's own engine and repo are still yours.** `clasp push` / `./deploy.sh` here touch only this app.

Hist: "The HUB is core-admin's".
