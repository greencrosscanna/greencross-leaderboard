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

### Add a token-less `gxRecordVersion` so apps can auto-record version + release note on deploy
**Ask (Sky):** "shipping a version → its release note in GX Core should be automatic, not a manual
Command Center popup step."

**Problem:** the only version-write path is `recordVersion(token, app, version, gitSha, notes)`
(`gx_core.gs:642`), which requires a **GX session token**. Apps deploy via clasp as `USER_DEPLOYING`
with **no GX session**, so they can't call it. (`gxImportVersions_` is private/underscore → not callable
via the library.) Result: every `app_versions` row is `deployed_by:"import"` — nothing auto-records.

**Fix (brain, in `gx_core.gs`):** add a **token-less trusted** function mirroring `gxIngestBug`'s
server-to-server pattern:
```js
// Trusted server-to-server: a bound app records its own deploy. Idempotent on (app, version).
function gxRecordVersion(app, version, gitSha, notes) {
  const a = gxSlug_(app); if (!a) return { ok:false, error:'app required' };
  if (!version) return { ok:false, error:'version required' };
  gxWrite_('app_versions', [{ app:a, version:String(version), git_sha:String(gitSha||''),
    deployed_at: gxNowIso_(), deployed_by:'app', notes:String(notes||'') }], ['app','version']);
  return { ok:true, app:a, version:String(version) };
}
```
Same trust rationale as `gxIngestBug` (already token-less and in use by Leaderboard). Dedupe key
`['app','version']` makes redeploys of the same version update-in-place (safe to call every deploy).

**Then (this app):** Leaderboard wires its deploy to call
`GXCore.gxRecordVersion('performance', GC.VERSION, gitSha, notes)` — the release note I already write at
deploy time gets pushed in the same step, no manual popup. Notes stay editorial (whoever deploys writes
them), but it becomes **one action**. Blocked until `gxRecordVersion` exists. Bump the GXCore pin if the
function lands in a version > 17.

### Heads-up for the Inventory chat: namespace its `gc_wn_seen` localStorage key too
Inventory + Leaderboard share the `greencrosscanna.github.io` origin, so the bare `gc_wn_seen` key
**collides** — Inventory's `v2.54` was suppressing Leaderboard's What's New popup. Leaderboard is fixed
(now `gc_wn_seen_performance`, v1.424). Inventory still uses the bare key; it should namespace to
`gc_wn_seen_inventory` (or its app key) so a third same-origin app can't collide with it either.

---

## Archive

### 2026-08-08 — Fix What's New localStorage collision (namespace the seen-key per app)
Inventory + Leaderboard share the GitHub Pages origin and both used a bare `gc_wn_seen`; Inventory's
`v2.54` clobbered Leaderboard's marker, permanently suppressing its What's New popup. Namespaced both
read (`checkWhatsNew`) and write (`closeChangelog`) to **`gc_wn_seen_performance`**. Verified live: the
popup now fires (reads our own key, ignores Inventory's `v2.54`); dismissing sets `gc_wn_seen_performance
= v1.380`. Deployed **v1.424**, commit `a60789b`. (Inventory-side namespacing noted back to the brain.)

### 2026-08-08 — Centralize the changelog: read release notes from GX Core, delete local copy
Done. `index.html` no longer hardcodes `GC.CHANGELOG`; on load it JSONP-fetches the GX Core
`version_history` route (`…/exec?action=version_history&app=performance&callback=…`, public/read-only)
and adapts each entry → `{v, date, items}` (`version`→`v`, `deployed_at`→`Mon D, YYYY` parsed **local**
to avoid a TZ day-shift, `notes.split('\n')`→`items`). `checkWhatsNew` now sets its `_wnChecked` guard
**after** the role + empty-changelog checks, and the fetch callback re-invokes it so the "What's New"
popup still fires once notes land (any load order). Graceful fallback: unreachable → `GC.CHANGELOG=[]`,
popup silently skipped, manual changelog shows a friendly "momentarily unavailable" line. `GC.VERSION`
kept (badge + bug reports). **Verified** on live director login: 19 entries load from GX Core (v1.380 →
v1.1), matching the cockpit; hardcoded copy gone. Deployed **v1.422**, commit `7e3102d`.
**Going forward:** ship a version → bump `GC.VERSION` here + add that version's note ONCE in the
Command Center version popup. This app only *reads* notes now.

### 2026-08-08 — GX Core binding bumped v12 → v17
Leaderboard now binds **GX Core v17** (was v12), pinned in `appsscript.json`. Motivation: v12 ran the
pre-refactor `gxIngestBug`; v13 refactored bug intake and v14–17 improved the cockpit bug/version panel.
No scope change (5 oauthScopes already explicit) → **no re-auth needed**. Verified end-to-end: a live bug
submission returned `{ok:true}` and forwarded via `gxIngestBug('performance', …)`. Deployed **v1.418**,
commit `89f35a2`.
