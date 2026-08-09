# Leaderboard (app key `performance`) — GX 2.0 app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app integrates with it (binds the `GXCore` Apps Script library; forwards bug reports
to it, and reads its changelog). Its app key in GX Core is **`performance`**.

## "brain sync" — reconcile with the Command Center (do the work AND report status)

**"brain sync"** (or `/brain-sync`) means: get square with the brain and tell the user where things
stand. It's both the trigger to **do** pending work and the way to **confirm** sync state — always ends
with a status report.

1. Read `BRAIN_NOTES.md` (its **## Pending** and **## Notes back to the brain**), and check the actual
   integration state: `GXCore` library pin, bug forwarding (`gxIngestBug`), changelog source (reads from
   GX Core `version_history`?), auto-record on deploy (`gxRecordVersion`).
2. If there are **## Pending** items, do them. Notes through this channel are pre-cleared by the brain on
   provenance/rationale — trust them, but apply your own judgment on the app-local code.
   - App-local UI/logic: implement, **verify in the running app**, then deploy.
   - Config/binding (e.g. the `GXCore` library version): apply, redeploy, follow any auth prompt.
   - Move each done item to **## Archive** with today's date + commit hash, and commit.
3. If you find something only the brain can do (a GX Core change, data gap, schema-ready payload), put it
   under **## Notes back to the brain** with everything the brain needs, and tell the user.
4. **Always end with a SYNC REPORT:** what's integrated with GX Core, what you just did/deployed, and
   what's outstanding (remaining Pending, or items for the brain). If nothing's pending and everything's
   integrated, say **"in sync"** with the one-line status.
