# Changelog

## v1.331 — 2026-06-02 — Architecture hardening pass

A systematic senior-engineer review and behavior-preserving refactor across the
GAS backend and the single-file frontend. Ten work groups plus several bug fixes
found along the way. Every change was verified against live behavior; the one
regression introduced (pagination) was caught by testing and reverted before it
could matter.

### 🔒 Security
- **Redacted plaintext credentials from source** (`bootstrapAllUsers`,
  `bootstrapDirectors`, `bootstrapStoreKeys`). User passwords and Dutchie API
  keys now live only in ScriptProperties.
  - ⚠️ **Follow-up for the team:** the old commits still contain these secrets in
    git history. Rotate every user password and the Dutchie API keys when
    convenient (and optionally scrub history with BFG / `git filter-repo`).

### 🧱 Backend GAS structure
- **Split the 4,400-line `dutchie_proxy.gs` monolith into 6 focused files:**
  `auth.gs`, `dutchie_fetch.gs`, `goals.gs`, `endpoints.gs`, `cache.gs`,
  `snapshot.gs` (constants, router, utilities, setup stay in `dutchie_proxy.gs`).
- Removed a duplicate `const DUTCHIE_BASE` declaration from `user_admin.gs`.

### ⚡ Backend correctness & performance
- **`currentPPStart_()`** — extracted the pay-period offset math that was
  duplicated in 5 places; eliminates a class of off-by-one risk.
- **`getProps_()`** — request-scoped ScriptProperties singleton; cut ~11
  redundant `PropertiesService.getScriptProperties()` reads per cold request.
- **Fixed `aggregateByDay_()` being called twice per loop iteration** in the YoY
  goal computations.
- **Named magic numbers:** `DUTCHIE_TAKE` (5000), `STORE_TODAY_TTL_S` (55),
  `PP_DAYS` usage in `getDateRange_('pp')`.
- **Fixed `refreshTargetsAll` crash** — `now` was undefined (`ReferenceError`),
  which had the daily 3 AM target-refresh trigger at a 100% error rate. Now uses
  `new Date()`.
- **Corrected `getDateRange_().totalDays` off-by-one** (was over-counting by 1
  because `toMs` is end-of-day).

### 🚩 MTD "behind plan" alert — fixed (behavior change)
The alert proration divided by *days-elapsed* instead of *days-in-month*, so it
demanded ~⅔ of the whole month's sales by the 2nd and flagged **every store at
−92% to −94% every day** — pure noise. Replaced with **`getProratedMonthGoalToDate_()`**,
a day-of-week-weighted expectation for completed days. Verified live: all 6 stores
went from "−93% FLAG" to a correct +72% to +117% (0 flagged). Alerts now carry
real signal.

### 🖥 Frontend (index.html)
- **Shared helpers** (de-duplicated): `GC.renderKpiBlock`, `GC.discountCell`,
  `GC.sparklineCell`; standardised the five copies of the local `e()` escape alias.
  Fixed a latent `NaN%` bug in the leaderboard KPI deltas in the process.
- **`GC.state`** — sort / filter / period selections now persist across
  navigation within a browser session (sessionStorage); cleared on logout.
- **Router `onLeave` teardown hook** — kiosk poll/leaderboard/clock timers and the
  confetti resize listener are now torn down on navigation. Verified: timer count
  stays flat (2) across repeated kiosk↔director navigation instead of leaking 3
  per kiosk visit.
- **Gauge pace arc** — dark-green day-fraction arc behind the bright-green
  progress fill (director + kiosk), with a `GC.dayFrac()` client fallback so it
  renders regardless of cache age. Rounded line caps.
- **Director "Today" card** shows `+$N Over Goal` in green when over 100%.
- Removed ID-specific CSS selectors for sparkline animation (now class-based).

### 🛠 Build & deploy
- **Version badge fixed** — was frozen at `v1.204` because `src/version.js` was
  never loaded. `deploy.sh` now stamps the version directly into `index.html`.
- **Removed dead `src/*.js` / `*.css` module files** (~8,200 lines) and the no-op
  inlining build step — `index.html` is the canonical monolith; `clasp` pushes it
  directly. (`src/fixtures/*.json` kept for `USE_FIXTURES` demo mode.)
- **`deploy.sh` hardened** — `trap`-based atomic restore so a failed `clasp push`
  can never leave the built file committed as source; pre-commit corruption guard;
  proactive GAS version-limit warning (currently ~98/200).
- **`watch_deploy.sh`** — notifies (desktop + push) when the GitHub Pages build of
  the pushed commit goes live, so you know when to hard-refresh.

### ✅ Tests
- **`tests.gs`** — 68-assertion backend suite for the pure functions where a
  silent bug corrupts revenue/goals/rankings (rounding, tx-field extraction,
  aggregation, date ranges, PP math, DOW counting). Run `runAllTests` from the
  Script Editor.
- **`tests.html`** — 52-assertion frontend suite that loads the app in a hidden
  iframe and asserts against the real `GC.*` utilities (no build, no npm). Open
  from the Pages URL or `python3 serve.py`.
- **Diagnostics:** `diagAlertProration` (per-store actual vs expected) and
  `diagPagination` (per-store 30-day fetch counts).

### 🔁 Data fetching — pagination investigation (reverted)
Attempted Skip/Take pagination to fix a hypothetical 5,000-record truncation. The
live diagnostic immediately exposed that **Dutchie ignores the `Skip` offset** on
`/reporting/transactions` — the loop re-fetched Commercial's ~6,100 transactions
~10× (61,000). Reverted to single-fetch (the API returns the full result set in
one call) and added a truncation-detection warning that fires only if Dutchie ever
starts enforcing a real cap (at which point the correct fix is date-window
splitting, not Skip/Take). Net win: the three fetch functions now share one engine
(`fetchTxnPagesByKey_`) instead of three copy-pasted blocks.

### Infra notes
- GAS proactive cache trigger (`refreshDirectorCache`, every 5 min) verified
  100% Completed.
- Daily target-refresh trigger (`refreshTargetsAll`, 3 AM) fix confirmed; rolling
  error rate trending 100% → 50% → 0% as pre-fix failures age out.
