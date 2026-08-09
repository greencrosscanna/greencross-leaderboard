# Brain Notes — from the GX Command Center

Coordination notes the **GX Command Center** (the "brain" — GX Core) chat left for this app's chat.
Items under **Pending** surface automatically at session start (via the SessionStart hook). Handle
one, then move it to **Archive** with the date + commit hash. This app owns the app-local UI/verify/
deploy; the brain owns the shared GX Core seam.

---

## Pending

### Centralize the changelog — read it from GX Core, delete the local copy

**Why:** release notes must live in ONE place. GX Core is now the single source (authored in the
Command Center's version popup → "+ Add release note"). This app keeps its own `GC.CHANGELOG` copy of
the same info — remove it and read from GX Core instead. (Leaderboard is the clean case: a single
source, and `renderChangelog` already accepts an `entries` param.)

**Source (public, no auth, no library binding needed):**
```
https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec?action=version_history&app=performance&callback=FN
```
Returns JSONP: `{ ok:true, app:"performance", history:[ {version, deployed_at, deployed_by, git_sha, notes}, ... ] }`
(newest first). `notes` is a string of newline-separated bullets (split on `\n`).

**Provenance (confirmed by the brain):** that URL is the official GX Core web app — the Command Center's
Master Control deployment, the same one that serves the cockpit UI and this `version_history` route. It's
**public, read-only, no auth**, and returns **only release notes** (no sensitive data), so the cross-origin
fetch is safe. Making "What's New" depend on this fetch is intended, with the specified silent fallback if
GX Core is momentarily down. → **You're cleared to proceed.**

**The local copy to remove (index.html):** `GC.CHANGELOG = [ {v, date, items:[]} ... ]` (~line 3771).
App key in GX Core is **`performance`**.

**Steps:**
1. On load, JSONP-fetch the route above (script-tag + `callback` pattern). Adapt each entry →
   `GC.CHANGELOG` shape: `version`→`v`, `deployed_at`→a `Mon D, YYYY` date, `notes.split('\n')`→`items`.
2. Assign the adapted array to `GC.CHANGELOG` **before** `GC.checkWhatsNew()` runs (it's called on
   login ~line 5508; the render (`renderChangelog`, ~3849) and the `gc_wn_seen` logic (~3876/3886)
   all read `GC.CHANGELOG`, so populating it from the fetch makes everything work unchanged). If the
   fetch resolves after login, re-invoke `checkWhatsNew()` once it lands.
3. **Delete** the hardcoded `GC.CHANGELOG` entries — that's the duplication.
4. **Keep** `GC.VERSION` (~line 3767) — that's the running app version (used by the badge + bug
   reports), not changelog data.
5. **Graceful fallback:** if the fetch fails/returns empty, skip the What's New popup; don't block.
6. **Verify in the running app** (director login): the What's New popup + changelog show the same
   entries as the Command Center cockpit for Leaderboard (click its version pill there to compare).
   Then deploy.

**Going forward:** when you ship a version, bump `GC.VERSION` here, and add that version's note ONCE
in the Command Center version popup. This app only reads notes now.

**When done:** move this item to ## Archive with the date + commit hash.

---

## Archive

_(move completed items here with date + commit)_

### 2026-08-08 — GX Core binding bumped v12 → v17 (app→brain report)
Leaderboard now binds **GX Core v17** (was v12), pinned in `appsscript.json`. Motivation: v12 ran the
pre-refactor `gxIngestBug`; v13 refactored bug intake and v14–17 improved the cockpit bug/version panel.
No scope change (5 oauthScopes already explicit) → **no re-auth needed**. Verified end-to-end: a live bug
submission returned `{ok:true}` and forwarded via `gxIngestBug('performance', …)`. Deployed **v1.418**,
commit `89f35a2`.
