# Leaderboard (app key `performance`) — GX 2.0 app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app integrates with it (binds the `GXCore` Apps Script library; forwards bug reports
to it, and reads its changelog). Its app key in GX Core is **`performance`**.

## Stack & local loop

**No build step — the file on disk IS the app.** This is the **all-staff kiosk**, the most visible surface
in the suite; ship accordingly.

| | |
|---|---|
| frontend | `index.html` (~12k lines, monolith) on GitHub Pages |
| backend | `.gs` files at the repo root, deployed with clasp: `auth.gs`, `cache.gs`, `discounts.gs`, `dutchie_fetch.gs`, `dutchie_proxy.gs`, `endpoints.gs`, `goals.gs`, `gx_roster.gs`, `snapshot.gs` |
| tests | **`tests/*_test.js`** (node) — covers the pure functions where a silent bug would corrupt revenue, goals or rankings. `tests.gs` is now editor-only Dutchie diagnostics |
| run | `python3 serve.py` → <http://localhost:8181> (`--lan` for a kiosk/phone) |
| ship | commit → push (Pages) → `./deploy.sh` records the release to `version_history` |

**The tests gate the push.** `node tests/<name>_test.js` runs one suite; `gx-preflight.sh` (the pre-push
hook) runs every `tests/*_test.js` and **refuses the push** on a failure. Run them after touching any
revenue, goal or ranking math — 90 assertions across four files:

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
2026-08-22 so the name says archive rather than source. `src/fixtures` backs fixture mode.

The dev server talks to the **live** backend; `gx-dev.js` blocks writes until armed. `gx-preflight.sh` runs
as a **pre-push hook** and refuses dev leftovers (fixtures on, writes armed, localhost URLs, `@devonly`).

**Shared files** (`deploy.sh`, `serve.py`, `gx-preflight.sh`, `.claude/gx-brain-notes.sh`) come from
**gx-theme** via `./gx-sync.sh`. Edit them **there**, then re-sync. This CLAUDE.md is **not** synced.

## Incentive lives in GX Crew — the old engine here was retired (2026-09-14)

Incentive/compensation moved **out of** this app into **GX Crew** (decision 2026-08-16). The sequence
was: promote the per-employee metrics and discretionary-discount classification to a shared home
first, then cut Crew over. Both happened — GX Core computes the slice (`incentive_perf`) and Crew
has read it since `cfg.incentiveEngine` flipped to `gxcore` on 2026-09-01.

**So the old engine is gone from here.** Removed: the `incentive`, `saveincentive`, `incentiveperf`,
`frozenperiod`, `frozenperiods` and `applydiscounttargets` routes, `getIncentiveData_`,
`computeIncentivePerf_`, `saveIncentiveInputs_`, the sky/mike access gate and its tests. Before
removal, all 28 frozen closed-period snapshots were compared byte-for-byte (sha256) against GX
Core's `incentive_frozen` archive and matched; the 29th key is the superseded v1 snapshot for
2026-06-22. **The Script Properties themselves were left in place** (`GC_INC_PERF_*`,
`GC_INCENTIVE_INPUTS_JSON`) — code only, no pay data deleted.

**What stays, and must:** `discounts.gs` (the registry and classification, published to Core kv
`discountRegistry`), the `discountrules` route (Crew's fallback read — keep it until this app is
deleted outright), and `getIncentiveThresholds_` / `incentiveDefaults_`, which the kiosk still uses
for its discount color target.

~~This app reads **`spiff_payouts`** through GX Core — a written column contract, never app-to-app.~~

*Corrected 2026-08-25: **there is no `spiff_payouts` tab and this app never read one.** It is not in
`GX_TABS`, nothing writes it, nothing reads it — the claim was invented in documentation and repeated
across the suite until it read as fact. SPIFF keeps its payout data in its own sheet. The real
Leaderboard↔Core contract is `goal_publications` (Leaderboard publishes, Sales consumes), covered by
`tests/cross_app_goals_contract_test.js`.*

**There IS a SPIFF contract now, and it is the other direction (2026-09-08).** SPIFF publishes each pay
period's finished per-employee sell-through and payout to GX Core's **`spiff_publications`** tab after
every hourly refresh; this app reads it back with `GXCore.publishedSpiffProgress(secret, scope)` and folds
it onto the kiosk staff cards. Before that, `spiff.gs` called SPIFF's `/exec` directly — knowingly
app-to-app, and documented as such in its own header. The numbers and the payload shape did not change.

Two things about it that are not guessable from the code:

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
  `payload.programs[]`, **one entry per program, joined by `program_id`**. This app shipped a reader
  for row columns first; it would have found nothing forever and drawn a card with every block
  missing, with no error anywhere. SPIFF caught it by reading the live payload back from Core. The
  spellings: `programs[].product`, `store_goals[store_id]` (a MAP, not a number — `bt_goals[store_id]`
  is the per-person goal and the one the bars are drawn against), `payout` + `payout_type`, `tips` (a
  real array), and `payload.refreshed_at` — **there is no `measured_at`**. `payout_type` is the one
  that costs money if ignored: on `per_unit` the payout is **per unit sold with no threshold at all**,
  so "$0.75 when you hit it" is a wrong dollar figure on a wall screen. Gated end-to-end by
  `tests/spiff_sidecar_contract_test.js`, which builds the sidecar with SPIFF's **own** `programsFor_`
  off its shipped source and renders it with the shipped `GC.spiffPanel` — a fixture of ours would
  only re-assert the shape we already believed in, which is how this went wrong the first time.

**The kiosk's SPIFF button opens SPIFF's own per-store board** (`store.html?t=<token>`) in a popup
Leaderboard DRAWS — a card over the dimmed board, not `window.open` (Sky, 2026-09-11: "maybe that's
being blocked, what about an overlay that is acting like a popup"). *Corrected 2026-09-13: this said
"Leaderboard renders none of it", which stopped being true the same day it was written.* SPIFF's page
is the fallback now, not the destination — `spiffPanelHasSpiffCopy_` hands over to Leaderboard's own
panel the moment every program in the payload carries a product or tips, so **the data flips it, not a
deploy**, and a kiosk picks it up on its next 5-minute refresh.

**And the panel is now SPIFF's redesigned board, drawn here (Sky's decision, 2026-09-16).** SPIFF
redesigned `store.html`, then found no kiosk was drawing it — the copy had arrived, so
`spiffPanelHasSpiffCopy_` was already true everywhere and the framed page had stopped being
reachable. Sky's call was to ADOPT the redesign in our panel rather than go back to framing, and
the reason is coupling: `store.html` calls SPIFF's engine for its own data, so framing it puts
SPIFF's uptime in front of the most visible screen in the company. **The panel reads Core's
published copy, which AGES rather than dies** — and `spiff.gs` already refuses a scope older than
the watchdog threshold, so it cannot go quietly stale either. Publish, don't proxy, applied to the
popup and not only to the numbers.

**The source of truth for the LOOK is SPIFF's handoff bundle**,
`greencross-spiff/design_handoff_spiff_kiosk_board/README.md` — not this repo's CSS and not
`store.css`. Three stacked cards: the program (vendor, name, what to sell, and three figures — what
it pays, units to hit your bonus, days left), then the BOARD as the centerpiece, then Tawny's tips.
Four things about it that are not guessable from the code:

- **The board was a footnote and is now the point.** Ranked by units descending with rank numbers,
  46px rows, and everyone at the store on it *including everyone at zero* — a board listing only
  sellers cannot tell you whether you are behind or simply not in this one.
- **No earnings per person, and that fixed something real.** The old panel printed "· +$25" beside
  anyone who had hit. A kiosk is a shared screen a customer can read over the counter, which is why
  SPIFF's own `storeView` returns no earnings, cost, investment or ROI at all. The figure is still
  on our payload; it no longer reaches the screen.
- **The bars went green and are clamped at the goal.** They used to be the staff cards' own bars —
  gold on a hit, plus a hash showing by how much the target was beaten. The handoff specifies green,
  and the overshoot is already stated in words one column right ("11/8"), so the hash carried
  nothing the row did not say. **Gold still means money on the cards; on this panel it is reserved
  for days left at three or fewer** — the one thing here that is running out. A per-unit program has
  no goal to be a fraction of, so its bars scale against the LEADER, which makes the bar a
  comparison rather than a promise.
- **The store-attainment track takes the store's live registry color**, through the
  `--store-<slug>` var `GC.loadStoreColors()` has already overlaid with GX Core values — so a
  Command Center edit reaches the wall without a deploy and a seventh store inherits its own color
  instead of nothing. The slug comes off the URL hash and goes inside a style attribute, so it is
  whitelisted to the shape a slug can have rather than escaped: `--store-<anything>` is a var name,
  and an escaper built for text is the wrong tool for one.

**The page-level store name and the "as of" stamp are gone**, which also closed Sky's bug of
2026-09-16 ("we can remove the top header text Century 1 program running since this is embedded in
Century's kiosk"). The popup's own bar already says SPIFF and names the store. `measuredAt` still
arrives on the payload and is simply not drawn.

**The iframe fallback is GONE (2026-09-17), and the paragraph here that kept it was wrong.**

It said the frame was "already unreachable on the normal path" and worth keeping as a net under a
one-day-old redesign. It was reachable, and it was the net that failed. **`renderSpiffOverlay`
painted the frame VISIBLE and our panel HIDDEN whenever the store had a token** — the pre-decision
default, with `openSpiffBoard` correcting it on the way in. So a full re-render while the popup was
OPEN (`checkRemoteRefresh` → `renderKiosk`) restored that default and put SPIFF's page on a kiosk
mid-read. Sky caught it the same day: *"after 60 seconds on screen, it reloaded the contents and
then the layout was wrong."*

**It read as a layout bug, not a wrong-page bug, because SPIFF's page is built from the same
handoff.** The only tells were their vendor-prefixed title ("Hellavated - Carts & Cloud Bars", from
their `programLabel()`) and their full names ("Ayla McArthur"), where ours shows the plain program
name and the kiosk's first names. Worth knowing for next time: **two faithful implementations of one
design are nearly indistinguishable on a screenshot, so the data is what tells you which you are
looking at.** The first theory here was that the 5-minute refresh route returned un-nicknamed
people; both routes were asked live and returned identical payloads, which killed it.

The fix was removal, not a third place that fixes the state — `applySpiffLink`,
`spiffPanelHasSpiffCopy_`, the iframe, its warming and `.kso-frame` are all gone. **A view chosen in
three places is wrong in whichever one nobody re-reads.** The store's token is still minted by
`spiffKioskUrl_` and still in `cfg.spiffKiosk.<core store_id>`, for the direct link Sky or Tawny
opens by hand; the kiosk no longer reads it. This also ends the cost the old paragraph named —
SPIFF's page is no longer loaded on six wall screens for a popup nobody framed.

Gated by `tests/spiff_popup_test.js`, rewritten for a one-view popup: it asserts the overlay markup
contains no second rendering and that the panel is never painted hidden, and both were proven red by
putting the frame-first markup back.

Gated by `tests/spiff_panel_test.js` and `tests/spiff_sidecar_contract_test.js`, which drive the
shipped `GC.spiffPanel`; all eight new guards were proven red individually, including the one that
matters most for a wall screen — that nobody's pay can reach it. **The frame is loaded at
kiosk paint and left loaded** — `storeView` takes ~4s over JSONP, and lazy loading meant every tap
bought a blank card ("the data takes too long to load"). The cost is SPIFF's own 10-minute refresh
running on six wall screens all day; that trade is deliberate and SPIFF has been told. One permanent token per store, held in GX Core kv as
`cfg.spiffKiosk.<core store_id>`; all six are set. Leaderboard reads the token live on every poll, so
a rotation reaches a running kiosk in ~60s rather than at the 04:00 reload.

*Corrected 2026-09-11: this said "no token, no button", which stopped being true on 2026-09-10.*
**Settings → Include SPIFF is the one switch for the button** — the same switch as the staff-card
rows, so the setting and the button cannot disagree. The token decides only what the button OPENS: a
window on SPIFF's page where there is one, Leaderboard's own panel where there is not, and SPIFF's
page embedded in an overlay where the browser refuses the popup — and, since SPIFF started publishing
the program sidecar, Leaderboard's own panel wherever the copy is complete. Covered by
`tests/spiff_popup_test.js` (*named `spiff_store_window_test.js` here until 2026-09-13; no such file
has ever existed*), which also holds the reason the window must close with the board: a wall screen
has no chrome, so a popup nobody can dismiss is the board gone for the shift.

## The name on a tile is DERIVED, and only disambiguates when it has to (2026-09-15)

A kiosk tile has no room for a surname, so the board shows first names — **except** where two people
on the live roster would read the same, and those get GX Core's `short_name` ("Nate S", "Zach B").
Sky's call over initials for all 42. The comparison is on the **casual** form, which is `short_name`
with Core's trailing initial taken back off; grouping on `preferred_name` instead would see "Zach B"
and "Zach R" as two different names and find no collision at all. A name can therefore change when
somebody ELSE is hired or leaves — that is the point, not a bug.

**Why it is not simply `preferred_name`.** Before a short form existed the disambiguator was written
INTO the nickname — "Zach B" for Zachary Babcock — which is right here and wrong in every app that
also shows a surname ("Zach B Babcock"). Core derives `short_name` for exactly this surface, so the
kiosk takes that and `preferred_name` goes back to the plain nickname suite-wide.

**`gxShortNameOf_` carries a stopgap: delete it when Core's data is clean.** Until `preferred_name`
is cleared to plain "Zach", Core derives `short_name` as **"Zach B B"**, so we collapse a doubled
trailing initial locally. That is what let this ship WITHOUT a coordination window — the board reads
right on either side of core-admin's data write, in either order. It goes inert the moment Core
strips the repeat itself or the data is corrected; it is not load-bearing after that.

**One name per person, one place that decides it.** The ticker used to carry its own disambiguator,
counting first names across a single store's roster, and once the card's name was derived suite-wide
the two could only disagree: it added a period the card has not ("Zach R."), and where the twin does
not work at that store it truncated back to "Nate" under a card reading "Nate S". It is gone;
`makeTicker_` uses the name it was given.

**The initial comes back OFF wherever a surname is shown (2026-09-16).** The disambiguator exists
for a surface with NO surname. Put it back next to one and it reads "Zach B Babcock" — the initial
answering a question the surname has already answered. Sky filed that the day after the tile fix
shipped. `gxWithSurname_` in `gx_roster.gs` is the one rule, used by `gxDisplayNameOf_` and by the
director's staff table (which pairs the nickname with the surname **Dutchie** holds, not the one
Core holds — two callers, and they were allowed to differ). It drops a trailing lone initial only
when that initial is the surname's own first letter, so a nickname that genuinely ends in a letter
survives, and it goes inert once Core derives `short_name` for everyone.

*The first shape of that fix carried a second casual-name map as well, and it was decoration:*
backing it out on its own left every test green, because the nickname is only ever found by matching
the Dutchie name, and then the two surnames agree by construction. It was deleted rather than
shipped as belt-and-braces — a branch no test can fail is a branch nobody can trust.

Gated by `tests/short_name_test.js`, which asserts BOTH data states, drives the real `getStoreToday`
for the ticker and the real `getDirectorStaff` for the table, and was proven red against each guard
individually. `getNicknames_` is in `goals.gs`; the helpers are in `gx_roster.gs`.

## A number never reads "+0%" or "−0%" (2026-09-16)

There is no amount of below-zero that displays as zero. Every readout rounds, and each one used to
decide the sign from the RAW value and then print the ROUNDED one, so a value that survived `< 0`
and then rounded away left a minus sign in front of a zero. Sky, off the director screen: *"how can
a number be +0% or -0%, shouldn't it just be 0%"*.

**`GC.fmtSignedPct(frac, decimals)` is the one definition** — it asks "does this round to zero at
the precision THIS surface shows?", which no single epsilon could answer, because the gauges round
to whole percent and the store table to one decimal. There were **six** hand-rolled copies of
`(p >= 0 ? '+' : '−') + Math.abs(...)` — the store table's vs.-plan column, the director and kiosk
pace gauges, the sparkline badge, the historical store cards and the Sky wall — so fixing the panel
in the screenshot would have left five. The same rule in other units: `fmtDeltaNum` judges the
rounded value (a Sales/Hour delta of −$0.30 printed "▼ −$0"), and the standings rows sign off
rounded dollars.

**Three KPI deltas hardcoded `▲ +` and then printed the raw number**, so a period that discounted
LESS than the one before read "▲ +-$412.00" — an up arrow, a plus and a minus, on a decline. Avg
UPT, Total Discounts and Discount Rate now go through `fmtDeltaDecimal` / `fmtDeltaCurrency` /
`fmtDeltaPts`.

`tests/signed_zero_test.js` drives every call site and the real `GC.renderKpiBlock`, not just the
helper — the three prefixes were in the WIRING, and a helper-only assertion would have passed with
them still there. It also greps for a **two-way** sign split (plus or minus, no branch for zero),
which is the shape that cannot print a bare 0% whatever it is fed; a three-way split on a rounded
value is the fix, not the bug. All eleven guards were proven red individually.

## A secret must never reach the screen inside an error (2026-09-15)

Three of this app's URLs carry a secret **in the query string**: `dutchie_keys?connector_secret=`
(`GX_CONNECTOR_SECRET` — the key that unlocks the Dutchie credentials), and `app_roster` and
`gxCoreRoute_`, both with `GX_DEPLOY_SECRET`. **`muteHttpExceptions: true` silences a STATUS code,
not a transport failure** — an unreachable host still throws, and Google's own message is
`Address unavailable: <the whole url>`. Unscrubbed, that renders in the kiosk's error banner in
front of the shop. Reported by SPIFF through core-admin.

`scrubSecrets_` (in `dutchie_proxy.gs`, next to `jsonOut`) is applied at **both router catches and at
all three fetches** — at source so nothing secret is ever inside a thrown message, at the router as
the backstop that covers the route added next year. Source matters on its own: several handlers
catch and return `{ok:false, error}` straight into `jsonOut` without ever reaching `doGet`'s catch.

**Two things the obvious regex gets wrong, and this app is bitten by both.** It must not be anchored
to `?`/`&` — the highest-value secret here travels as `connector_**secret**=`, where `secret=`
follows an underscore, so an anchor-only form matches nothing. And it must cover **every name the
session token arrives under**: `requireAuth_` accepts `token`, `session` *or* `auth`, so knowing only
`token=` leaves two thirds of the door open (ours did, for an hour). `tests/error_scrub_test.js`
asserts both — it runs an anchor-only regex on the real URL and requires it to leak.

**Derive the names from `requireAuth_`, and do not copy another app's regex — not even the best
one.** This section named Inventory's `SECRET_PARAM_RE_` as the shape to copy for about an hour, and
core-admin's comparison then showed that Inventory, Sales and Crew *all* miss `session=` (two also
miss `auth=`), although each of their own auth call sites reads the same three names. The suite had
converged on a good-looking regex nobody had checked against the door it guards — the same miss as
ours, one layer up, and copying it into GX Core would have reproduced it where every key lives.

Crew's is anchor-only, which is safe *in Crew* — it carries no prefixed secret parameter at all —
and wrong to copy anywhere that does. Prefixed parameters by app, counted 2026-09-15: leaderboard 7,
inventory 9, core-admin 5, and crew, sales, spiff, pricecards 0. **If `requireAuth_` ever learns a
fourth name, it goes in `scrubSecrets_` in the same commit.**

That suite **never greps a file for the scrub**, which is how SPIFF's own version passed while
proving nothing (it matched a scrub inside a different function). It drives the real `doGet` and
`doPost` and reads the served body, and every one of the five scrubs was proven red by removing it.

## A part period is compared against the same PART of the one before (2026-09-16)

`getDateRange_('pp')` runs to `ppEndMs` — the end of the **whole** fortnight, including days that
have not happened. The prior range was that full width shifted back, so on day three the director's
card held three days of trade up against fourteen: Transactions and Total Discounts opened every pay
period deeply negative and climbed back to level by the end, which is the calendar, not a signal.
Sales / Hour was worse and not a judgment call at all — it divided fourteen days of prior takings by
**three days** of open hours, reporting the chain ~$19,000/hour down.

**`getPriorRange_` is now the elapsed-aligned window; `getPriorFullRange_` is the whole period.**
Aligning on elapsed days also aligns the **weekdays**, which is why it is the right comparison and
not just a fairer one: a pay period is a whole number of weeks, so day N of this one is the same
weekday as day N of the last. Three days against three is Mon-Tue-Wed against Mon-Tue-Wed; against a
whole period folds in two weekends.

**Totals use the aligned window, rates use the full period, and that split is deliberate.** An AOV
or a discount rate is not distorted by how long you measure it, and the longer window is the steadier
benchmark — Sky's own read in the same report ("AOV seems to make sense that it compares to the
average AOV over the last period, that sets the benchmark"). Sales / Hour is the exception among the
rates: it is aligned, because the weekday argument above beats the steadiness one inside a period.

**The card SAYS which basis each number used** (`summary.comparison` → the `.kpi-basis` line). Half
of "these KPI over/unders are confusing" was the arithmetic; the other half was a card that never
told you what it was comparing you to. When a caller pre-fetched the aligned window and not the full
one, the rates fall back to the aligned window and `rateDays` reports that, so a narrower benchmark
is labeled rather than silent — going and fetching would put a live Dutchie call inside a path whose
contract is "I already have the data".

Gated by `tests/kpi_comparison_window_test.js`: the windows, the DST close instant (a window
containing the fall-back must end at PT midnight, not an hour early), the February clamp, the
registry-driven period length, and the summary end to end with numbers chosen so each basis gives a
different answer. Nine guards, each proven red alone. Note the two places a wrong divisor passes by
accident — the Sales/Hour divisor only differs from `daysElapsed` when the window is **clamped**,
and `toLocal` survives naive ms arithmetic because PT midnight is 07:00/08:00 UTC either way. The
first version of this suite missed both.

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX Core
— the sync protocol lives in that one command, not copied here. **"brain sync" / "sync brain"** = the
reconcile-and-report step alone (skips orientation).

Coordination is now the **central brain-notes inbox** in GX Core (this repo's `BRAIN_NOTES.md` was retired and has now been deleted): `/gxbrain` reads notes addressed to `to_app=performance`, resolves done ones (`resolve_note`), and
writes note-backs to any app (`add_note`). The SessionStart hook surfaces the same inbox.

App-specific facts for the sync check: app key **`performance`** in GX Core; integrated via bug forwarding
(`gxIngestBug` + `tab`), changelog read from `version_history`, and auto-record on deploy (central
`deploy_version` endpoint + shared untracked `.gx_deploy_secret`); `appsscript.json` pins `GXCore`
**v330** — but a call runs the version the live DEPLOYMENT snapshotted, so **ask the running app**
(`?action=libversion`), never this line. It said **v19** until 2026-08-22, wrong by 169 versions,
**v211** until 2026-08-25, wrong by two moves (215 then 220), and **v225** until 2026-09-09, by which
point the pin had moved ninety versions past it. Three times now the pin advanced and this line
did not, which is the whole reason it tells you not to trust it. The move to **v225** (2026-08-25) is
the first one this app cannot survive being wrong about: `GXCore.setAvatar` — the single avatar write
— **does not exist before 225**, so an un-deployed re-pin is not a stale note, it is every avatar save
on the kiosk throwing.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) when you need its id for the `curl` — but **refer to it by its `title`, never its id**. `job_mtg9vyxs_ewd9` means nothing to Sky; every job carries the to-do text in the same response the id came from, so say that instead, summarized if it's long ("the employee email column"). Same for `bug_…` and note ids. **Then re-list what's open, numbered `[1] [2] [3]…`, instead of proposing a next task** — re-fetch `action=whats_next` (the board moved while you worked) and let Sky pick by number rather than from memory.


## The HUB is core-admin's — send a note, don't edit (rule from Sky, 2026-09-02 · applied here 2026-09-06)

**Never edit `greencross-command-center` or `greencross-gx-theme` from this chat.** Both belong to
core-admin. It is here because it was broken, not because it was theorized.

On 2026-09-02 a spoke session made a small, correct, tested fix to GX Core and put it on a branch for
Sky to merge, because Core library cuts are PR-gated. **Another Claude session had the same repo open
at the same time.** These repos are Dropbox-synced, so the two sessions shared one working tree and
one HEAD: the branch was switched out from under the first session, its commit landed on `main`
instead, and the other session pushed `main` and shipped it. The change went out as library v284 with
no PR and no review. The code was fine — that is the point. Nothing failed, nothing warned, and the
gate on the highest-stakes repo in the suite simply was not there that time.

Two sessions cannot share a git checkout. Neither can see the other, `git checkout -b` is not atomic
against a second process, and the loser finds out afterwards by reading the log.

**So from Leaderboard: `add_note` to `core-admin` with what you need and why, and stop.** Requests are welcome
and quick, and the hub session holds the repo alone while it works.

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
