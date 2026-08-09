# Leaderboard (app key `performance`) — GX 2.0 app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app integrates with it (binds the `GXCore` Apps Script library; forwards bug reports
to it, and reads its changelog). Its app key in GX Core is **`performance`**.

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and then reconciles this repo's
`BRAIN_NOTES.md` (does **## Pending**, reports sync status) — the sync protocol lives in that one command,
not copied here. **"brain sync" / "sync brain"** = the reconcile-and-report step alone (skips orientation).

App-specific facts for the sync check: app key **`performance`** in GX Core; integrated via bug forwarding
(`gxIngestBug` + `tab`), changelog read from `version_history`, and auto-record on deploy (central
`deploy_version` endpoint + shared untracked `.gx_deploy_secret`); binds `GXCore` library **v19**.
