# Brain Notes — from the GX Command Center

Coordination notes the **GX Command Center** (the "brain" — GX Core) chat left for this app's chat.
Items under **Pending** surface automatically at session start (via the SessionStart hook). Handle
one, then move it to **Archive** with the date + commit hash. This app owns the app-local UI/verify/
deploy; the brain owns the shared GX Core seam.

---

## Pending

_(none — in sync)_

---

## Notes back to the brain

### Define the "GX Core — Sales Cache" contract before Leaderboard migrates (Phase 2)
Sheet `1Lr9fCBTSGLC0plV3jpTV82m3P2VIjNLGwJQOHiTKSVI` ("GX Core — Sales Cache") is being written under
GX Core (owner Sky, actively updated 2026-08-10). Leaderboard does **not** use it yet. Before migrating
Sales & Performance onto it, the brain should define the shared contract: **schema** (per store/day:
date TEXT PT, store_id, net sales, transactions, AOV, total discounts, ideally discretionary-discount
basis; hourly + on-shift optional), **write side** (writer, cadence, Dutchie source, settlement +
retroactive-return handling), **read side** (a `GXCore` library reader like `getSalesDaily`/`getSalesRange`
or endpoint — NOT direct sheet reads), and **retention** cap. Then Leaderboard retires its own
`/reporting/transactions` pulls + `GC_DAYAGG` CacheService aggregate + nightly `EOD_Snapshots` sheet and
reads the shared cache. Full spec handed to Sky as a paste-in prompt for the Command Center chat
(2026-08-10).

### Add the Leaderboard "Sky wall" as an App button in GX Command Center
Add a launcher/App button in the Command Center for the Leaderboard's **Sky wall** (the owner iPad/TV
wall — every store's live pace + the company aggregate + rolling sales ticker, on one screen).
**URL:** `https://greencrosscanna.github.io/greencross-leaderboard/#/sky`
App key `performance`; route `#/sky` (roles: owner/director). It's a full-screen always-on display, so a
"open in new tab / fullscreen" style button fits. (Sky requested this 2026-08-09.)

### Heads-up for the Inventory chat: namespace its `gc_wn_seen` localStorage key too
Inventory + Leaderboard share the `greencrosscanna.github.io` origin, so the bare `gc_wn_seen` key
**collides** — Inventory's `v2.54` was suppressing Leaderboard's What's New popup. Leaderboard is fixed
(now `gc_wn_seen_performance`, v1.424). Inventory still uses the bare key; it should namespace to
`gc_wn_seen_inventory` (or its app key) so a third same-origin app can't collide with it either.

---

## Archive

### 2026-08-09 — Store colors now sourced from GX Core (single source)
Leaderboard now reads store colors from the GX Core stores registry instead of hardcoding its own.
Added a public backend action `gxstores` → `GXCore.getStores()` (cached 15 min) returning
`{store_id, display_name, dutchie_name, color, sort_order}`. On boot, `GC.loadStoreColors()` overlays
the live colors: sets the `--store-<slug>` CSS vars (instant, no re-render) AND `GC.STORES[slug].color`
(re-renders the current view only on a genuine change — case-insensitive compare, since GX Core hex is
uppercase / our fallback lowercase). **Gotcha found + fixed:** the app had TWO store-color sources — the
JS `GC.STORES[*].color` AND CSS vars `--store-*` (lines ~62-67, used by `.store-dot.<slug>` on the Sky
wall). Both were updated to the GX Core palette (Baseline #6366F1, Center #3B82F6, Century #22D3EE,
Commercial #A855F7, Portland #D946EF, River #EC4899) as the first-paint/offline fallback. Join is by
`display_name.toLowerCase()` == app slug. **Verified** on the live Sky wall: all six dots now match the
Command Center palette. A future CC color edit propagates on next load with no deploy.
Deployed **v1.436→v1.438**, commit `9b27b6d`.
**Follow-up (v1.441, `9294222`):** the always-on Sky wall (`#/sky`) never reloads, so it now re-pulls
store colors every **5 min** (silent: CSS-var dots update live, the wall's own 30s repaint picks up the
rest — no disruptive re-render). Server `gxstores` cache lowered 15→**5 min** to match. So a CC color
edit reaches the wall within ~5–10 min, no reload. Timer torn down in the wall's `onLeave`.

### 2026-08-08 — Migrate to GX Core's central `deploy_version` endpoint (retire local `recordversion`)
Folded the prototype back into the shared endpoint. `deploy.sh` now curls GX Core
`action=deploy_version&app=performance` (was this app's own `recordversion`). Deleted the `recordversion`
web action + `handleRecordVersion_` from `dutchie_proxy.gs` (bug forwarding via `GXCore.gxIngestBug`
untouched; GXCore pin stays v19 for that). My local `.gx_deploy_secret` already matches GX Core's
`GC_DEPLOY_SECRET` (verified via an idempotent re-send of v1.428 → `ok:true`), so nothing else changed.
**Verified:** plain `bash deploy.sh` → v1.432 recorded through the central endpoint (`deployed_by:'app'`,
sha `145ad70`, empty notes → cockpit telemetry only); the old `recordversion` action now falls through to
the auth gate (gone from the live backend). Deployed **v1.432**, commit `145ad70`.
**Leftover (harmless, optional):** this project's Script Property `GC_DEPLOY_SECRET` is now orphaned
(nothing reads it) — Sky can delete it in the editor (Project Settings → Script Properties) at leisure.

### 2026-08-08 — Auto-record deploys to GX Core (no more manual release-note step)
Wired the deploy to publish release notes to the single source automatically. Bumped the GXCore pin
**v17 → v19** (no re-auth), added a **secret-gated public** web action `recordversion` →
`GXCore.gxRecordVersion('performance', version, sha, notes)` (in `dutchie_proxy.gs`, placed ABOVE the
`requireAuth_` gate since the deploy has no session; gated by a shared secret with trust-on-first-use so
the public exec URL can't spam the version log — secret lives only in Script Property `GC_DEPLOY_SECRET`
+ untracked `.gx_deploy_secret`, never in git/GAS source). `deploy.sh` now curls `recordversion` after
every push with `version` + `sha` + optional `GX_NOTES`. Also fixed the changelog `fmtDate` to render
`deployed_at` in **Pacific** (an evening deploy stamped `01:42Z` was showing tomorrow's date). **Verified**
end-to-end: v1.427 + v1.428 auto-recorded (`deployed_by:'app'`, correct sha, notes), appear in the app's
What's New with correct Aug 8 PT dates. Deployed **v1.427** (`33b04c7`, wiring) + **v1.428** (`fffc6f4`,
PT date fix). **Going forward:** ship a version → `GX_NOTES=$'Line 1\nLine 2' bash deploy.sh "msg"` for a
notable release (plain `deploy.sh` records version-only, filtered out of What's New). No Command Center
popup needed — this app both writes (on deploy) and reads (What's New) through GX Core.

### 2026-08-08 — Fix What's New localStorage collision (namespace the seen-key per app)
Inventory + Leaderboard share the GitHub Pages origin and both used a bare `gc_wn_seen`; Inventory's
`v2.54` clobbered Leaderboard's marker, permanently suppressing its What's New popup. Namespaced both
read (`checkWhatsNew`) and write (`closeChangelog`) to **`gc_wn_seen_performance`**. Verified live: the
popup now fires (reads our own key, ignores Inventory's `v2.54`); dismissing sets `gc_wn_seen_performance
= v1.380`. Deployed **v1.424**, commit `a60789b`. (Inventory-side namespacing noted back to the brain.)

### 2026-08-08 — Centralize the changelog: read release notes from GX Core, delete local copy
Done. `index.html` no longer hardcodes `GC.CHANGELOG`; on load it JSONP-fetches the GX Core
`version_history` route (`…/exec?action=version_history&app=performance&callback=…`, public/read-only)
and adapts each entry → `{v, date, items}`. `checkWhatsNew` sets its `_wnChecked` guard **after** the
role + empty-changelog checks, and the fetch callback re-invokes it so the "What's New" popup still fires
once notes land (any load order). Graceful fallback: unreachable → `GC.CHANGELOG=[]`, popup skipped,
manual changelog shows a "momentarily unavailable" line. `GC.VERSION` kept (badge + bug reports).
**Verified** on live director login: 19 entries load from GX Core (v1.380 → v1.1), matching the cockpit;
hardcoded copy gone. Deployed **v1.422**, commit `7e3102d`.

### 2026-08-08 — GX Core binding bumped v12 → v17
Leaderboard now binds **GX Core v17** (was v12), pinned in `appsscript.json`. Motivation: v12 ran the
pre-refactor `gxIngestBug`; v13 refactored bug intake and v14–17 improved the cockpit bug/version panel.
No scope change (5 oauthScopes already explicit) → **no re-auth needed**. Verified end-to-end: a live bug
submission returned `{ok:true}` and forwarded via `gxIngestBug('performance', …)`. Deployed **v1.418**,
commit `89f35a2`. (Superseded by the v19 bump above.)
