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

### Heads-up for the Inventory chat: namespace its `gc_wn_seen` localStorage key too
Inventory + Leaderboard share the `greencrosscanna.github.io` origin, so the bare `gc_wn_seen` key
**collides** — Inventory's `v2.54` was suppressing Leaderboard's What's New popup. Leaderboard is fixed
(now `gc_wn_seen_performance`, v1.424). Inventory still uses the bare key; it should namespace to
`gc_wn_seen_inventory` (or its app key) so a third same-origin app can't collide with it either.

---

## Archive

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
