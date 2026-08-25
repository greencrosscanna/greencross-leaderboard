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

## Incentive is moving to GX Crew — sequence matters

Incentive/compensation is being pulled **out of** this app into **GX Crew** (decision 2026-08-16; Incentive
was formerly a Leaderboard view). GX Crew is the HR system-of-record and **feeds** this app, not the reverse.

The bonus math needs **per-employee, per-transaction** data *with discretionary-discount classification*,
and that engine still lives **here**, app-side — it is **not** in the GX Core daily cache, which is
per-store daily only. So the split is sequenced: **first** promote the per-employee metrics and the
discretionary-discount definition to a canonical shared home, **then** cut Crew over. **Don't move the UI
before the math has a shared home.** Coordinate with `core-admin`.

~~This app reads **`spiff_payouts`** through GX Core — a written column contract, never app-to-app.~~

*Corrected 2026-08-25: **there is no `spiff_payouts` tab and this app never read one.** It is not in
`GX_TABS`, nothing writes it, nothing reads it — the claim was invented in documentation and repeated
across the suite until it read as fact. SPIFF keeps its payout data in its own sheet. The real
Leaderboard↔Core contract is `goal_publications` (Leaderboard publishes, Sales consumes), covered by
`tests/cross_app_goals_contract_test.js`.*

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX Core
— the sync protocol lives in that one command, not copied here. **"brain sync" / "sync brain"** = the
reconcile-and-report step alone (skips orientation).

Coordination is now the **central brain-notes inbox** in GX Core (this repo's `BRAIN_NOTES.md` was retired and has now been deleted): `/gxbrain` reads notes addressed to `to_app=performance`, resolves done ones (`resolve_note`), and
writes note-backs to any app (`add_note`). The SessionStart hook surfaces the same inbox.

App-specific facts for the sync check: app key **`performance`** in GX Core; integrated via bug forwarding
(`gxIngestBug` + `tab`), changelog read from `version_history`, and auto-record on deploy (central
`deploy_version` endpoint + shared untracked `.gx_deploy_secret`); `appsscript.json` pins `GXCore`
**v225** — but a call runs the version the live DEPLOYMENT snapshotted, so **ask the running app**
(`?action=libversion`), never this line. It said **v19** until 2026-08-22, wrong by 169 versions, and
**v211** until 2026-08-25, wrong by two moves (215 then 220). Twice now the pin advanced and this line
did not, which is the whole reason it tells you not to trust it. The move to **v225** (2026-08-25) is
the first one this app cannot survive being wrong about: `GXCore.setAvatar` — the single avatar write
— **does not exist before 225**, so an un-deployed re-pin is not a stale note, it is every avatar save
on the kiosk throwing.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) if you need its id.
