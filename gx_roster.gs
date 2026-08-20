/**
 * gx_roster.gs — GX Core is the point of truth for PEOPLE.
 *
 * Crew owns the employee roster: nicknames (preferred_name), avatars (avatar_config), job titles
 * (role_title) and employment status. This file is how Leaderboard READS that roster. Nothing here
 * writes; Crew is the only editor.
 *
 * WHY THIS EXISTS
 * Leaderboard used to keep its own copies of all four in Script Properties, edited from its own
 * Settings page. That is how "Skyler Poteet" rendered as "Skylar", and how a nickname set in Crew
 * appeared to revert — two stores of the same fact, and the kiosk read the stale one. The Settings
 * editors are being removed; this file replaces the data they used to maintain.
 *
 * THE JOIN, AND WHY IT IS NOT ON NAMES
 * Dutchie transactions carry `employeeId`, and every one of GX Core's active employees has a
 * `dutchie_employee_id`. That numeric id is the join. Matching on names is what breaks: a rename in
 * Crew silently orphans whatever was keyed to the old spelling — the bug that scrambled avatar seeds
 * (Crew now pins those to employee_number) and the bug that still drops the EoM star today.
 * Name matching survives here ONLY as a fallback for roster entries with no id, and it is counted so
 * we can see whether it is still carrying anyone.
 *
 * SHAPE
 * The resolvers return maps keyed by Leaderboard's own nameKey, because that is what every existing
 * call site looks up by. The id join happens inside; callers are unchanged.
 *
 * MIGRATION POSTURE
 * GX Core wins wherever it has a value; the old local Script Properties fill gaps for anyone it does
 * not cover. That makes the switch lossless without first auditing the local copies, and there is no
 * flag day. Once gxRosterCoverage() reports nothing falling back, the local reads can be deleted.
 */

// 10 minutes. Long enough that a kiosk polling every few seconds does not hit the Sheets API each
// time (a GX Core read is a Sheets call — slow, and rate-limited), short enough that a nickname
// added in Crew shows up on the floor while the person who typed it is still looking at the screen.
const GC_GX_ROSTER_CACHE_KEY = 'gc_gx_roster_v1';
const GC_GX_ROSTER_TTL_SEC   = 600;

/**
 * The GX Core roster, indexed for Leaderboard's use. Cached.
 * Returns { byKey: { nameKey: rec }, retiredKeys: [nameKey], stats: {...} }
 * where rec = { employeeId, displayName, preferredName, fullName, avatarConfig, roleTitle, status }
 */
function gxRoster_() {
  try {
    const raw = CacheService.getScriptCache().get(GC_GX_ROSTER_CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through and rebuild */ }

  const built = gxRosterBuild_();
  try {
    CacheService.getScriptCache().put(GC_GX_ROSTER_CACHE_KEY,
      JSON.stringify(built), GC_GX_ROSTER_TTL_SEC);
  } catch (e) { /* cache is an optimisation, not a requirement */ }
  return built;
}

/** Force the next read to re-pull from GX Core. Call after Crew reports a change. */
function gxRosterBust_() {
  try { CacheService.getScriptCache().remove(GC_GX_ROSTER_CACHE_KEY); } catch (e) {}
}

function gxRosterBuild_() {
  let rows = [];
  try {
    rows = GXCore.getEmployees() || [];
  } catch (e) {
    // GX Core unreachable. Return an EMPTY roster rather than throwing: every resolver below falls
    // back to the local Script Properties, so the kiosk keeps rendering the names it rendered
    // yesterday instead of showing a blank board.
    return { byKey: {}, retiredKeys: [], stats: { ok: false, error: String(e), rows: 0 } };
  }

  // dutchie_employee_id -> GX Core row, and a name index for the fallback path.
  const byDutchieId = {};
  const byFullNameKey = {};
  rows.forEach(function (r) {
    const rec = {
      employeeId:    String(r.employee_id || '').trim(),
      fullName:      String(r.full_name || '').trim(),
      preferredName: String(r.preferred_name || '').trim(),
      roleTitle:     String(r.role_title || '').trim(),
      status:        String(r.status || 'active').trim().toLowerCase(),
      avatarConfig:  gxParseJson_(r.avatar_config),
    };
    rec.displayName = gxDisplayNameOf_(rec);
    const did = String(r.dutchie_employee_id || '').trim();
    if (did) byDutchieId[did] = rec;
    if (rec.fullName) byFullNameKey[nameToKey_(rec.fullName)] = rec;
  });

  // Walk Leaderboard's own Dutchie roster so the result is keyed by the nameKey the rest of the app
  // already uses. The roster entry carries the Dutchie id; that is what we join on.
  const byKey = {};
  const retiredKeys = [];
  let matchedById = 0, matchedByName = 0, unmatched = 0;
  const roster = getEmployeeRoster_();

  Object.keys(roster).forEach(function (slug) {
    (roster[slug] || []).forEach(function (emp) {
      const name = String(emp.name || '');
      if (!name || name === 'Unknown') return;
      const key = nameToKey_(name);
      if (byKey[key]) return;                       // same person seen at another store

      const id  = String(emp.id || '').trim();
      let rec = id ? byDutchieId[id] : null;
      if (rec) { matchedById++; }
      else {
        rec = byFullNameKey[key] || null;           // fallback: no id on this roster entry
        if (rec) matchedByName++; else unmatched++;
      }
      if (!rec) return;

      byKey[key] = rec;
      // 'retired' is Crew saying this person has left. 'merged'/'deleted' are duplicate rows that
      // resolved to somebody else. None of them belong on a board the whole shop is looking at.
      if (rec.status === 'retired' || rec.status === 'merged' || rec.status === 'deleted') {
        retiredKeys.push(key);
      }
    });
  });

  return {
    byKey: byKey,
    retiredKeys: retiredKeys,
    stats: {
      ok: true, rows: rows.length,
      matchedById: matchedById, matchedByName: matchedByName, unmatched: unmatched,
      builtAt: new Date().toISOString(),
    },
  };
}

/** nickname + surname, matching GX Core's own derivation, so one person reads the same everywhere. */
function gxDisplayNameOf_(rec) {
  if (!rec.preferredName) return rec.fullName;
  const parts = String(rec.fullName || '').split(/\s+/).filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  return last ? (rec.preferredName + ' ' + last) : rec.preferredName;
}

function gxParseJson_(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

/**
 * Diagnostic: is anything still relying on the name fallback, or unmatched entirely?
 * When matchedByName and unmatched are both 0 for active staff, the local Script Property copies
 * are dead weight and the fallbacks in getNicknames_/getAvatarConfigs_/getRoles_ can be deleted.
 */
function gxRosterCoverage() {
  gxRosterBust_();
  const r = gxRosterBuild_();
  Logger.log(JSON.stringify(r.stats, null, 2));
  Logger.log('mapped nameKeys: ' + Object.keys(r.byKey).length +
             '  retired/merged: ' + r.retiredKeys.length);
  return r.stats;
}

/**
 * One warning per execution when the roster could not be read.
 *
 * The resolvers deliberately swallow errors so a GX Core outage falls back to the local copies
 * rather than blanking the board. That same catch would also swallow the ReferenceError you get
 * when this very file is not deployed -- which nearly happened: .claspignore is an ALLOWLIST, and
 * a new .gs is skipped silently unless it is named there. The failure looked like "the change did
 * nothing" rather than an error. This makes it visible in the execution log.
 */
var _gxRosterWarned = false;
function gxRosterWarn_(e) {
  if (_gxRosterWarned) return;
  _gxRosterWarned = true;
  try { Logger.log('[gx_roster] roster unavailable, using local fallback: ' + (e && e.message || e)); } catch (_) {}
}
