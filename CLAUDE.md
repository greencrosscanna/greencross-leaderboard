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
| tests | **`tests.gs`** — covers the pure functions where a silent bug would corrupt revenue, goals or rankings |
| run | `python3 serve.py` → <http://localhost:8181> (`--lan` for a kiosk/phone) |
| ship | commit → push (Pages) → `./deploy.sh` records the release to `version_history` |

**Running the tests is not a shell command** — open the project in the Apps Script editor, select
`runAllTests` in the function dropdown, Run, then View → Logs for the PASS/FAIL summary. Run it after
touching any revenue, goal or ranking math.

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

This app reads **`spiff_payouts`** through GX Core — a written column contract, never app-to-app.

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX Core
— the sync protocol lives in that one command, not copied here. **"brain sync" / "sync brain"** = the
reconcile-and-report step alone (skips orientation).

Coordination is now the **central brain-notes inbox** in GX Core (this repo's `BRAIN_NOTES.md` was retired and has now been deleted): `/gxbrain` reads notes addressed to `to_app=performance`, resolves done ones (`resolve_note`), and
writes note-backs to any app (`add_note`). The SessionStart hook surfaces the same inbox.

App-specific facts for the sync check: app key **`performance`** in GX Core; integrated via bug forwarding
(`gxIngestBug` + `tab`), changelog read from `version_history`, and auto-record on deploy (central
`deploy_version` endpoint + shared untracked `.gx_deploy_secret`); `appsscript.json` pins `GXCore`
**v194** — but a call runs the version the live DEPLOYMENT snapshotted, so **ask the running app**
(`?action=libversion`), never this line. It said **v19** until 2026-08-22, which was wrong by 169
versions: the pin had moved and the prose had not.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) if you need its id.
