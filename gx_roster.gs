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
// Request-scoped memo, same pattern as _goalsCache_ in dutchie_proxy.gs. The eligibility helpers
// below are called once PER TRANSACTION on a busy store's ticker, and CacheService.get() is a real
// round trip -- without this the store gate would cost thousands of cache reads per kiosk poll.
var _gxRosterMemo_ = null;

function gxRoster_() {
  if (_gxRosterMemo_) return _gxRosterMemo_;
  try {
    const raw = CacheService.getScriptCache().get(GC_GX_ROSTER_CACHE_KEY);
    if (raw) return (_gxRosterMemo_ = JSON.parse(raw));
  } catch (e) { /* fall through and rebuild */ }

  const built = gxRosterBuild_();
  try {
    CacheService.getScriptCache().put(GC_GX_ROSTER_CACHE_KEY,
      JSON.stringify(built), GC_GX_ROSTER_TTL_SEC);
  } catch (e) { /* cache is an optimisation, not a requirement */ }
  return (_gxRosterMemo_ = built);
}

/** Force the next read to re-pull from GX Core. Call after Crew reports a change. */
function gxRosterBust_() {
  _gxRosterMemo_ = null;
  try { CacheService.getScriptCache().remove(GC_GX_ROSTER_CACHE_KEY); } catch (e) {}
}

/** retired / merged / deleted all mean "not somebody the board should be showing today". */
function gxIsLive_(status) {
  const s = String(status || '').trim().toLowerCase();
  return s !== 'retired' && s !== 'merged' && s !== 'deleted';
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

  const gxRecOf_ = function (r) {
    const rec = {
      employeeId:    String(r.employee_id || '').trim(),
      fullName:      String(r.full_name || '').trim(),
      preferredName: String(r.preferred_name || '').trim(),
      roleTitle:     String(r.role_title || '').trim(),
      status:        String(r.status || 'active').trim().toLowerCase(),
      // Crew's home_store, which is a GX Core store_id ('hillsboro'), NOT this app's slug
      // ('baseline'). The two genuinely differ for four of the six stores. Never compare this to
      // store.slug directly -- gxBelongsToStore_ translates it through the shared registry.
      homeStore:     String(r.home_store || '').trim().toLowerCase(),
      avatarConfig:  gxParseJson_(r.avatar_config),
    };
    rec.displayName = gxDisplayNameOf_(rec);
    return rec;
  };

  // dutchie_employee_id -> GX Core row, and a name index for the fallback path.
  //
  // A LIVE ROW ALWAYS WINS THE ID, and that is not a nicety. A merged duplicate carries the same
  // dutchie id as the person it was merged into -- both Wydick rows are 44905, both Malia rows are
  // 45705 -- so indexing blind hands the id to whichever row was read last. That is how the board
  // showed "Nate Wydick" while Crew showed "Robert Wydick", and with the status filter below it
  // would have been worse than cosmetic: an active person would have been dropped off the board
  // because a dead row owned their id.
  const byDutchieId = {};
  const byFullNameKey = {};
  rows.forEach(function (r) {
    const rec  = gxRecOf_(r);
    const live = gxIsLive_(rec.status);
    const did  = String(r.dutchie_employee_id || '').trim();
    if (did && (!byDutchieId[did] || (live && !gxIsLive_(byDutchieId[did].status)))) {
      byDutchieId[did] = rec;
    }
    const nk = rec.fullName ? nameToKey_(rec.fullName) : '';
    if (nk && (!byFullNameKey[nk] || (live && !gxIsLive_(byFullNameKey[nk].status)))) {
      byFullNameKey[nk] = rec;
    }
  });

  // Walk Leaderboard's own Dutchie roster so the result is keyed by the nameKey the rest of the app
  // already uses. The roster entry carries the Dutchie id; that is what we join on.
  const byKey = {};
  const retiredKeys = [];
  let matchedById = 0, matchedByName = 0, unmatched = 0;
  const byNameKeys = [], unmatchedKeys = [];
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
        if (rec) { matchedByName++; byNameKeys.push(key + ' (dutchie id ' + (id || 'none') + ' -> ' + rec.fullName + ')'); }
        else { unmatched++; unmatchedKeys.push(name + ' (dutchie id ' + (id || 'none') + ')'); }
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

  // byKey only covers people in the 30-day SALES roster. Corporate staff never ring a transaction,
  // so Sky, Tawny and Mike were never merged in and their avatars were coming from the local copy --
  // removing that fallback would have dropped them to initials in the director header. They ARE in
  // GX Core; index them by their own name so a Core value reaches them too. Roster entries still
  // win, because that join is on the Dutchie id rather than on a name.
  const byCoreKey = {};
  rows.forEach(function (r) {
    const st = String(r.status || 'active').trim().toLowerCase();
    if (st === 'merged' || st === 'deleted') return;      // duplicate rows resolved to somebody else
    const rec = gxRecOf_(r);
    // Index under BOTH names. Lookups arrive keyed either way: the kiosk derives its key from the
    // Dutchie name (the legal one), while the director header derives it from the session's display
    // name. Sky is "Skyler Pinnick" in Core and "Sky Pinnick" on screen -- indexing only the legal
    // name meant his own avatar resolved to nothing.
    // NOT indexed by the nickname alone, tempting as it is: three people share "Nate", so that key
    // would hand somebody else's face to whichever row happened to be read first.
    [nameToKey_(rec.fullName), nameToKey_(rec.displayName)].forEach(function (nk) {
      if (nk && !byCoreKey[nk]) byCoreKey[nk] = rec;
    });
  });

  // WHO IS NOT ON THE BOARD TODAY.
  //
  // retiredKeys above only covers people this app's own 30-day SALES roster happens to contain, and
  // that roster is rebuilt from Dutchie -- which lags Crew by however long it takes Mike to
  // deactivate someone. Ten people were retired in GX Core and still active in Dutchie, Rebeka Perez
  // among them, so status never reached the board. This index is built from every Core row instead,
  // so a retirement takes effect on the next roster read rather than on the next Dutchie sync.
  // (green_cross, the house account, is retired in Core and drops out here for the same reason.)
  //
  // MINUS ANYTHING A LIVE ROW CLAIMS. A merged duplicate shares its name -- and its dutchie id --
  // with the person it resolved into. Excluding "Nate Wydick" because the merged Nathan row carries
  // that display name would take the live Robert Wydick off the board with it.
  const liveNameKeys = {};
  rows.forEach(function (r) {
    if (!gxIsLive_(r.status)) return;
    const rec = gxRecOf_(r);
    [rec.fullName, rec.displayName].forEach(function (n) {
      const nk = n ? nameToKey_(n) : '';
      if (nk) liveNameKeys[nk] = true;
    });
  });

  const excludedKeys = {};
  retiredKeys.forEach(function (k) { excludedKeys[k] = true; });
  rows.forEach(function (r) {
    if (gxIsLive_(r.status)) return;
    const rec = gxRecOf_(r);
    [rec.fullName, rec.displayName].forEach(function (n) {
      const nk = n ? nameToKey_(n) : '';
      if (nk && !liveNameKeys[nk]) excludedKeys[nk] = true;
    });
  });

  // home_store is what the trophy gate runs on, and the gate FAILS OPEN -- so if the column ever
  // stops arriving (a Core schema change, an older pinned library version), the gate quietly stops
  // gating and Zach B is back on Center's trophies with nothing in the log to say why. Count it.
  const withHomeStore = rows.filter(function (r) { return String(r.home_store || '').trim(); }).length;
  if (rows.length && !withHomeStore) {
    Logger.log('[gx_roster] GX Core returned ' + rows.length + ' employees and NONE carry home_store — ' +
               'the store-crew gate on trophies is inert. Check the GXCore pin in appsscript.json.');
  }

  return {
    byKey: byKey,
    byCoreKey: byCoreKey,
    byDutchieId: byDutchieId,
    excludedKeys: excludedKeys,
    retiredKeys: retiredKeys,
    withHomeStore: withHomeStore,
    stats: {
      ok: true, rows: rows.length,
      matchedById: matchedById, matchedByName: matchedByName, unmatched: unmatched,
      byNameKeys: byNameKeys, unmatchedKeys: unmatchedKeys,
      builtAt: new Date().toISOString(),
    },
  };
}


/**
 * Every person GX Core knows, keyed by this app's nameKey, as { nameKey: rec }.
 *
 * Two sources, and the order matters: start from byCoreKey (matched on the person's own name, which
 * covers everyone in Core including staff who never ring a sale), then let byKey overwrite (matched
 * on the Dutchie id, which is authoritative and is what the kiosk actually renders from).
 */
function gxAllRecs_() {
  const r = gxRoster_();
  const out = {};
  const core = r.byCoreKey || {};
  Object.keys(core).forEach(function (k) { out[k] = core[k]; });
  const roster = r.byKey || {};
  Object.keys(roster).forEach(function (k) { out[k] = roster[k]; });
  return out;
}

// ── Who is on the board right now ────────────────────────────────────────────────────────────────
// Two questions, one answer each, both asked of GX Core rather than of Dutchie. Sky's rule: "we
// don't want them showing up in the Leaderboard if they're gone, that's messy to the staff" -- so
// the roster decides who appears, not whichever record Dutchie has got around to deactivating.
//
// BOTH ARE FOR THE CURRENT-PERIOD BOARD ONLY. A retired person's past sales genuinely happened, and
// a historical view must still attribute them or last month's numbers change retroactively. Do not
// wire these into the standings/history paths -- getStandings_ deliberately does not exclude.

/** GX Core's record for whoever rang a transaction: {id, name} from txEmployee_ or agg.byEmployee. */
function gxRecForEmp_(emp) {
  const r  = gxRoster_();
  const id = String((emp && emp.id) || '').trim();
  if (id) {
    const byId = (r.byDutchieId || {})[id];
    if (byId) return byId;
  }
  const key = nameToKey_((emp && emp.name) || '');
  if (!key) return null;
  return (r.byKey || {})[key] || (r.byCoreKey || {})[key] || null;
}

/**
 * Has GX Core said this person is gone (retired / merged / deleted)?
 *
 * THE ID SETTLES IT WHEN THERE IS ONE. Dutchie's employeeId joins straight to a Core row, and that
 * row's status is the answer -- no name matching, so a rename cannot orphan it and a merged
 * duplicate cannot answer for the live person it resolved into. The name index is the fallback for
 * roster entries and transactions that carry no id.
 */
function gxIsExcluded_(emp) {
  const id = String((emp && emp.id) || '').trim();
  if (id) {
    const rec = (gxRoster_().byDutchieId || {})[id];
    if (rec) return !gxIsLive_(rec.status);
  }
  const key = nameToKey_((emp && emp.name) || '');
  return !!key && !!(gxRoster_().excludedKeys || {})[key];
}

/**
 * Is this person part of THIS store's crew, per Crew's home_store?
 *
 * Trophies are the store's own awards, so a budtender covering a shift from another store should
 * not carry one off with them -- Zach B is Baseline's and was turning up on Center's "This Week's
 * Trophies". Their sales still count toward the store's revenue and still show on today's board;
 * this gate is only about who the awards belong to.
 *
 * FAILS OPEN, DELIBERATELY, in all three not-knowable cases: no Core record, no home_store on it, or
 * a cold store registry. A trophy shown for the wrong store is a visible bug someone reports; a
 * trophy that silently vanishes because a lookup was cold is a worse one nobody can see.
 */
function gxBelongsToStore_(emp, store) {
  const rec = gxRecForEmp_(emp);
  if (!rec || !rec.homeStore) return true;

  // home_store is a Core store_id ('hillsboro'); this app's slug is its display name ('baseline').
  // gxStoreIdToAppSlug_ is the one registry-backed translation -- do not hand-map the four that
  // differ, that is exactly the hardcoding that breaks on a rename.
  const id2slug = gxStoreIdToAppSlug_();
  if (!id2slug || !Object.keys(id2slug).length) return true;   // registry cold -- do not judge

  const home = id2slug[rec.homeStore] || '';
  if (!home) return false;   // a real home store that is not one of the six (corporate) -- not crew
  return home === String((store && store.slug) || '').trim().toLowerCase();
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
 * The same question gxBoardEligibility() answers, as counts with no names, so it can be asked over
 * HTTP instead of from the Apps Script editor (action=rosterhealth).
 *
 * WHY IT EXISTS. The gates below all fail open on purpose, which means the way they break is by
 * quietly doing nothing — exactly the failure core-admin warns about with library pins: a GXCore.x()
 * call runs the snapshot of the version THIS app pins, so reading Core's current source and
 * concluding you are covered proves nothing. libVersion() reports what we are ACTUALLY running and
 * withHomeStore reports whether the column the trophy gate needs is really arriving. If home_store
 * is 0, the crew gate is inert and the pin is the first thing to look at.
 *
 * Counts only — no names, nothing the kiosk does not already show the whole shop.
 */
function gxRosterHealth_() {
  const r = gxRoster_();
  let libVersion = null;
  try { if (typeof GXCore.libVersion === 'function') libVersion = GXCore.libVersion(); } catch (e) {}

  const perStore = {};
  const roster = getEmployeeRoster_();
  STORES.forEach(function (store) {
    let crew = 0, gone = 0;
    const visiting = [];
    (roster[store.slug] || []).forEach(function (e) {
      if (gxIsExcluded_(e)) { gone++; return; }
      if (!gxBelongsToStore_(e, store)) {
        // NAMED, unlike gone. A visitor is an ACTIVE employee whose name the kiosk already shows the
        // whole shop, and the name is the only useful part: a corporate visitor means the gate is
        // working, while a budtender who really transferred means their home_store is stale in Crew
        // and they are being denied a trophy at their own store. Those two need telling apart.
        // `gone` stays a count — a public list of who has left is not the board's to publish.
        const rec = gxRecForEmp_(e);
        visiting.push({
          name: (rec && rec.displayName) || e.name || '',
          homeStore: (rec && rec.homeStore) || '(none)',
        });
        return;
      }
      crew++;
    });
    perStore[store.slug] = { crew: crew, visiting: visiting.length, gone: gone, visitors: visiting };
  });

  return {
    ok:             !!(r.stats && r.stats.ok),
    libVersion:     libVersion,
    coreRows:       (r.stats && r.stats.rows) || 0,
    withHomeStore:  r.withHomeStore || 0,
    crewGateActive: (r.withHomeStore || 0) > 0,
    excludedKeys:   Object.keys(r.excludedKeys || {}).length,
    matchedById:    (r.stats && r.stats.matchedById) || 0,
    matchedByName:  (r.stats && r.stats.matchedByName) || 0,
    unmatched:      (r.stats && r.stats.unmatched) || 0,
    perStore:       perStore,
    builtAt:        (r.stats && r.stats.builtAt) || null,
  };
}

/**
 * Diagnostic: who is on each store's board, and who did the two gates take off it?
 *
 * The unit test for this logic runs against a stubbed roster; this is the same question asked of the
 * real deployment, where GXCore.getEmployees() is the live library at the version this app pins.
 * Run it from the editor after a re-pin -- if `home_store present` reads 0, the trophy gate is inert
 * and the pin is the reason. Read-only.
 */
function gxBoardEligibility() {
  gxRosterBust_();
  const r = gxRosterBuild_();
  _gxRosterMemo_ = r;

  Logger.log('GX Core rows: ' + (r.stats && r.stats.rows) + '   home_store present: ' + r.withHomeStore);
  Logger.log('off the board (retired/merged/deleted): ' + Object.keys(r.excludedKeys || {}).length + ' name keys');
  Logger.log('');

  STORES.forEach(function (store) {
    const roster = getEmployeeRoster_()[store.slug] || [];
    const on = [], gone = [], visiting = [];
    roster.forEach(function (e) {
      if (gxIsExcluded_(e)) gone.push(e.name);
      else if (!gxBelongsToStore_(e, store)) visiting.push(e.name);
      else on.push(e.name);
    });
    Logger.log(store.name + ' — ' + on.length + ' crew, ' + visiting.length + ' visiting, ' + gone.length + ' gone');
    if (visiting.length) Logger.log('   no trophy here (another store\'s crew): ' + visiting.join(', '));
    if (gone.length)     Logger.log('   off the board entirely:                 ' + gone.join(', '));
  });
  return r.stats;
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

/**
 * What is this app still showing that GX Core does not know about?
 *
 * The resolvers fall back to the old local Script Properties wherever GX Core has nothing. That made
 * the switch lossless, but it has a sting: a value that exists ONLY locally cannot be removed from
 * Crew. Clear an avatar there and the local copy simply resurfaces, because "GX Core has nothing"
 * looks identical to "GX Core has not been told yet". Zachary Rodriguez is the live example — he has
 * an avatar on the kiosk and none in Crew.
 *
 * This lists the gap so it can be closed deliberately: backfill these into GX Core, then delete the
 * fallbacks and let Crew be the only source. Read-only; run it from the editor.
 */
function gxRosterDelta() {
  gxRosterBust_();                       // never report on a stale cache
  var roster = gxRosterBuild_();
  var st     = roster.stats || {};
  // Measured against the SAME index the resolvers use, not just the sales roster — otherwise
  // corporate staff read as "local only" when GX Core has them perfectly well, which is exactly
  // the false alarm that nearly had me delete their avatars.
  var byKey  = {};
  var core   = roster.byCoreKey || {};
  Object.keys(core).forEach(function (k) { byKey[k] = core[k]; });
  Object.keys(roster.byKey || {}).forEach(function (k) { byKey[k] = roster.byKey[k]; });

  Logger.log('JOIN: ' + st.matchedById + ' by dutchie id, ' + st.matchedByName +
             ' by NAME (fragile), ' + st.unmatched + ' unmatched');
  (st.byNameKeys || []).forEach(function (l) { Logger.log('   name-matched: ' + l); });
  (st.unmatchedKeys || []).forEach(function (l) { Logger.log('   UNMATCHED:   ' + l); });
  Logger.log('');

  var localNicks = {};
  try {
    var rawN = getProps_().getProperty(GC_NICKNAMES_KEY);
    if (rawN) {
      var stored = JSON.parse(rawN) || {};
      Object.keys(stored).forEach(function (k) {
        var clean = k.replace(/\./g, '').trim();
        if (stored[k] && clean) localNicks[clean] = stored[k];
      });
    }
  } catch (e) {}

  var localAvatars = {};
  try {
    var rawA = PropertiesService.getScriptProperties().getProperty(GC_AVATAR_CONFIGS_KEY);
    if (rawA) localAvatars = JSON.parse(rawA) || {};
  } catch (e) {}

  var nickOnlyLocal = [], nickConflict = [], avatarOnlyLocal = [], avatarBoth = [];

  Object.keys(localNicks).forEach(function (k) {
    var rec = byKey[k];
    if (!rec || !rec.preferredName) nickOnlyLocal.push(k + ' = "' + localNicks[k] + '"' + (rec ? '' : '  (no GX Core match)'));
    else if (rec.preferredName !== localNicks[k]) nickConflict.push(k + ': local "' + localNicks[k] + '" vs Core "' + rec.preferredName + '"');
  });

  Object.keys(localAvatars).forEach(function (k) {
    if (!localAvatars[k]) return;
    var rec = byKey[k];
    if (!rec || !rec.avatarConfig) avatarOnlyLocal.push(k + (rec ? ('  -> ' + rec.fullName + ' (employee_id ' + rec.employeeId + ')') : '  (no GX Core match)'));
    else avatarBoth.push(k);
  });

  Logger.log('AVATARS that exist ONLY locally — these WOULD BE LOST now the fallback is gone (' + avatarOnlyLocal.length + '):');
  avatarOnlyLocal.forEach(function (l) { Logger.log('   ' + l); });
  Logger.log('AVATARS present in BOTH (Core wins, local is dead weight): ' + avatarBoth.length);
  Logger.log('NICKNAMES local-only (' + nickOnlyLocal.length + '):');
  nickOnlyLocal.forEach(function (l) { Logger.log('   ' + l); });
  Logger.log('NICKNAMES that DISAGREE — Core is winning, so the kiosk shows Core (' + nickConflict.length + '):');
  nickConflict.forEach(function (l) { Logger.log('   ' + l); });

  return { avatarOnlyLocal: avatarOnlyLocal.length, avatarBoth: avatarBoth.length,
           nickOnlyLocal: nickOnlyLocal.length, nickConflict: nickConflict.length };
}

/**
 * ONE-OFF: push the avatars and nicknames that exist ONLY in this app's Script Properties up into
 * GX Core, so Crew becomes the single place any of it is edited.
 *
 * Why this is needed: the resolvers fall back to the local copies wherever Core has nothing, which
 * made the migration lossless but means a local-only value cannot be REMOVED from Crew — clearing
 * it there just lets the local copy resurface. Zachary Rodriguez is the live example: an avatar on
 * the kiosk, none in Crew. Backfilling closes that, and then the fallbacks can be deleted.
 *
 * SAFETY, because this writes to shared HR data:
 *   - DRY RUN unless you pass true. Read the log first.
 *   - Only ever FILLS AN EMPTY FIELD. If Core already has a value it is left alone, always.
 *   - Writes COMPLETE rows. gxWrite_ replaces the whole row from the object it is given, so any
 *     column missing from that object is blanked. That is what destroyed two employee records
 *     before. Every row here starts as a copy of the live row with one field laid on top.
 *   - Anything that cannot be resolved to an employee_id is reported, never guessed at.
 *
 * Run from the editor: gxBackfillToCore()      -> shows what it would do
 *                      gxBackfillToCore(true)  -> writes
 */
function gxBackfillToCore(commit) {
  var byKey = gxRoster_().byKey || {};

  var localNicks = {};
  try {
    var rawN = getProps_().getProperty(GC_NICKNAMES_KEY);
    if (rawN) {
      var st = JSON.parse(rawN) || {};
      Object.keys(st).forEach(function (k) {
        var clean = k.replace(/\./g, '').trim();
        if (st[k] && clean) localNicks[clean] = st[k];
      });
    }
  } catch (e) {}

  var localAvatars = {};
  try {
    var rawA = PropertiesService.getScriptProperties().getProperty(GC_AVATAR_CONFIGS_KEY);
    if (rawA) localAvatars = JSON.parse(rawA) || {};
  } catch (e) {}

  // Live rows, indexed by employee_id — each write starts from one of these, never from scratch.
  var live = {};
  GXCore.getEmployees().forEach(function (r) {
    var id = String(r.employee_id || '').trim();
    if (id) live[id] = r;
  });

  var planned = {}, skipped = [], unresolved = [];

  function target(nameKey, what) {
    var rec = byKey[nameKey];
    if (!rec || !rec.employeeId) { unresolved.push(what + ' ' + nameKey + ' — no GX Core match'); return null; }
    var row = live[rec.employeeId];
    if (!row) { unresolved.push(what + ' ' + nameKey + ' — employee_id ' + rec.employeeId + ' not in Core'); return null; }
    if (!planned[rec.employeeId]) planned[rec.employeeId] = Object.assign({}, row);   // FULL row
    return { id: rec.employeeId, row: planned[rec.employeeId], live: row };
  }

  Object.keys(localAvatars).forEach(function (k) {
    var cfg = localAvatars[k];
    if (!cfg) return;
    var t = target(k, 'avatar');
    if (!t) return;
    if (String(t.live.avatar_config || '').trim()) { skipped.push('avatar ' + k + ' — Core already has one'); return; }
    t.row.avatar_config = (typeof cfg === 'string') ? cfg : JSON.stringify(cfg);
    t.row._why = (t.row._why || '') + ' avatar';
    t.row._setAvatar = true;
  });

  Object.keys(localNicks).forEach(function (k) {
    var t = target(k, 'nickname');
    if (!t) return;
    if (String(t.live.preferred_name || '').trim()) { skipped.push('nickname ' + k + ' — Core already has "' + t.live.preferred_name + '"'); return; }
    t.row.preferred_name = localNicks[k];
    t.row._why = (t.row._why || '') + ' nickname';
    t.row._setNick = true;
  });

  var rows = Object.keys(planned).map(function (id) { return planned[id]; })
                   .filter(function (r) { return r._why; });

  // Log ONLY what actually changes. The first version echoed whatever the row already held, which
  // read as though an existing nickname were being rewritten — it was not.
  Logger.log(rows.length + ' employee row(s) would be updated:');
  rows.forEach(function (r) {
    var changes = [];
    if (r._setNick)   changes.push('preferred_name="' + r.preferred_name + '"');
    if (r._setAvatar) changes.push('avatar_config (' + String(r.avatar_config).length + ' chars)');
    Logger.log('   ' + (r.full_name || r.employee_id) + '   setting: ' + changes.join(' + '));
  });
  Logger.log('skipped (Core already has a value): ' + skipped.length);
  skipped.forEach(function (l) { Logger.log('   ' + l); });
  Logger.log('unresolved: ' + unresolved.length);
  unresolved.forEach(function (l) { Logger.log('   ' + l); });

  if (commit !== true) {
    Logger.log('DRY RUN — nothing written. Call gxBackfillToCore(true) to apply.');
    return { dryRun: true, wouldUpdate: rows.length, skipped: skipped.length, unresolved: unresolved.length };
  }

  rows.forEach(function (r) { delete r._why; delete r._setNick; delete r._setAvatar; });
  GXCore.gxUpsertEmployees(rows);        // safe here ONLY because each row is a complete live row
  gxRosterBust_();                       // so the next read reflects it immediately
  Logger.log('WROTE ' + rows.length + ' row(s).');
  return { dryRun: false, updated: rows.length, skipped: skipped.length, unresolved: unresolved.length };
}

/**
 * Apply the backfill. Pick THIS from the editor's function dropdown, not gxBackfillToCore.
 *
 * The editor's Run button invokes with NO arguments, so gxBackfillToCore(true) typed into the
 * dropdown still runs as gxBackfillToCore() — a dry run that completes cleanly and writes nothing.
 * It looks like it worked. Same shape as the rule that trigger handlers must be no-arg wrappers.
 *
 * Run gxBackfillToCore() first and read the log; this does exactly what that previewed.
 */
function gxBackfillApplyNow() {
  return gxBackfillToCore(true);
}
