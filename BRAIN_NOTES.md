# Brain Notes — from the GX Command Center

Coordination notes the **GX Command Center** (the "brain" — GX Core) chat left for this app's chat.
Items under **Pending** surface automatically at session start (via the SessionStart hook). Handle
one, then move it to **Archive** with the date + commit hash. This app owns the app-local UI/verify/
deploy; the brain owns the shared GX Core seam.

---

## Pending

_(none — in sync)_

---

## Archive

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
