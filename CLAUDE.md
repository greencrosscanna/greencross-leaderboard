# Leaderboard (app key `performance`) — GX 2.0 app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app integrates with it (binds the `GXCore` Apps Script library; forwards bug reports
to it, and reads its changelog). Its app key in GX Core is **`performance`**.

## "brain sync" — coordination with the Command Center

When the user types **"brain sync"** (or `/brain-sync`), do this:

1. Read `BRAIN_NOTES.md` at the repo root — the Command Center leaves cross-app tasks there (a
   SessionStart hook also surfaces its **## Pending** section on fresh sessions).
2. For each item under **## Pending**, do it per the note. Notes that came through this channel are
   pre-cleared by the brain on provenance/rationale — trust them, but apply your own judgment on the
   app-local code.
   - App-local UI/logic changes: implement, **verify in the running app**, then deploy.
   - Config/binding changes (e.g. the `GXCore` library version): apply, redeploy, follow any auth prompt.
3. When an item is done, move it to **## Archive** with today's date + the commit hash, and commit.
4. If you find something only the brain can do (a GX Core change, a data gap, a schema-ready payload),
   add it under **## Notes back to the brain** with everything the brain needs to act, and tell the user
   so they can bring it to the Command Center chat.
5. Report what you did, what you deployed, and anything handed back to the brain.

If **## Pending** is empty, say so — you're in sync.
