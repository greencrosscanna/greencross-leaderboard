// ============================================================
//  Green Cross — SPIFF progress for kiosk staff cards (spiff.gs)
//
//  Reads SPIFF's `progress` cache and folds each budtender's sell-through onto
//  their kiosk card: units toward the vendor's target, and the payout once hit.
//
//  SPIFF OWNS THE NUMBERS. This file measures nothing. SPIFF sets the targets,
//  counts the units and decides what a person earned; we render a finished
//  figure. Computing it a second time here would be a second answer to "what
//  does this person get", and the vendor is being paid SPIFF's number.
//
//  APP-TO-APP, AND KNOWN TO BE. The shared brain says everything cross-app goes
//  through GX Core. This is the THIRD hop for the same per-employee data
//  (Leaderboard incentiveperf -> Crew, SPIFF progress -> Crew, and now
//  SPIFF progress -> here). The brain notes asking core-admin to promote a
//  per-employee slice are open on both sides; Sky's call on 2026-08-29 was to
//  ship the kiosk now rather than wait. DELETE THIS FILE when GX Core exposes
//  the slice — same fate as the incentiveperf route in dutchie_proxy.gs.
// ============================================================

var SPIFF_CACHE_KEY  = 'gc_spiff_progress_v1';
var SPIFF_TTL_OK     = 900;   // 15 min. SPIFF's own refresh trigger is hourly, so this is fresh.
var SPIFF_TTL_FAIL   = 120;   // Cache FAILURES too, briefly — see spiffFetchRaw_.

/**
 * SPIFF's /exec URL, from GX Core kv key `spiffProgress`.
 *
 * Read from kv rather than hardcoded so a SPIFF redeploy is a config change in the
 * Command Center and not an edit in two repos. Crew reads the same key the same way.
 */
function spiffEngineUrl_() {
  try { return String(GXCore.getKv('spiffProgress') || '').trim(); }
  catch (e) { return ''; }
}

/**
 * Fetch SPIFF's progress cache, memoised in CacheService.
 *
 * NEVER THROWS, and never lets a SPIFF problem reach the kiosk. Every failure
 * returns { ok:false, error } and the caller renders staff cards without SPIFF —
 * this is the all-staff screen, and a vendor-bonus widget is not worth a blank board.
 *
 * FAILURES ARE CACHED (briefly) on purpose. The kiosk polls standings continuously;
 * without this, a SPIFF outage would mean one blocking UrlFetchApp per poll per
 * screen, turning their downtime into our latency.
 *
 * Deliberately does NOT call refreshProgress: that is a WRITE, ~9s per store against
 * a 60s /exec ceiling, which is why it hands back a plan for the caller to loop.
 * SPIFF's hourly trigger and Crew's on-demand refresh already drive it; a kiosk
 * polling it would fight both. We read, and trust `refreshed_at`.
 */
function spiffFetchRaw_() {
  var cache = CacheService.getScriptCache();
  var hit   = cache.get(SPIFF_CACHE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var out;
  var base = spiffEngineUrl_();
  if (!base) {
    out = { ok: false, error: 'no SPIFF engine URL in GX Core kv (key spiffProgress)' };
  } else {
    var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
    if (!secret) {
      out = { ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' };
    } else {
      /* NO pay_period FILTER — and this is not an oversight. SPIFF stores pay_period as a
         human-readable RANGE ("2026-08-17 - 2026-08-30"), not a start date, so asking for
         "2026-08-17" matches nothing and every card reads zero: indistinguishable from a
         fortnight where nobody sold anything. Crew hit exactly this and now filters on the
         WINDOW instead. We do the same in spiffFilterRows_ — the fact, not its formatting. */
      try {
        var res = UrlFetchApp.fetch(
          base + '?action=progress&secret=' + encodeURIComponent(secret),
          { muteHttpExceptions: true, followRedirects: true });
        if (res.getResponseCode() !== 200) {
          out = { ok: false, error: 'SPIFF returned HTTP ' + res.getResponseCode() };
        } else {
          var d = JSON.parse(res.getContentText());
          out = (!d || d.ok === false)
            ? { ok: false, error: (d && d.error) || 'SPIFF refused' }
            : { ok: true, rows: d.rows || [], refreshed_at: d.refreshed_at || '' };
        }
      } catch (e) {
        out = { ok: false, error: 'could not reach SPIFF: ' + String((e && e.message) || e) };
      }
    }
  }

  try { cache.put(SPIFF_CACHE_KEY, JSON.stringify(out), out.ok ? SPIFF_TTL_OK : SPIFF_TTL_FAIL); }
  catch (e) {}
  return out;
}

/**
 * Rows for one store whose program window OVERLAPS the pay period.
 *
 * OVERLAP, NOT EQUALITY. A SPIFF runs concurrent to the pay period but is not required
 * to line up with it — a program that starts mid-period still counts for the days it
 * covers. Matching pay_period as a string is the trap described in spiffFetchRaw_.
 *
 * Dates are compared as TEXT 'YYYY-MM-DD', per the suite rule: they arrive as text from
 * SPIFF (fixed there 2026-08-29, spiff f640a8c, after Date objects normalised in LA time
 * shifted the window a day) and lexicographic order on that format IS chronological order.
 * No Date object is constructed here, so there is nothing for a timezone to shift.
 *
 * @param {Array}  rows        SPIFF progress rows
 * @param {string} coreStoreId GX Core store_id (SPIFF's key — 'bend', not our slug 'century')
 * @param {string} ppStartStr  'YYYY-MM-DD'
 * @param {string} ppEndStr    'YYYY-MM-DD'
 */
function spiffFilterRows_(rows, coreStoreId, ppStartStr, ppEndStr) {
  var want = String(coreStoreId || '').trim().toLowerCase();
  var d10  = function (v) { return String(v == null ? '' : v).slice(0, 10); };
  var from = d10(ppStartStr), to = d10(ppEndStr);
  return (rows || []).filter(function (r) {
    if (!r) return false;
    if (String(r.store_id || '').trim().toLowerCase() !== want) return false;
    var a = d10(r.start_date), b = d10(r.end_date);
    if (a.length !== 10 || b.length !== 10) return false;   // undated row — cannot place it
    return a <= to && b >= from;
  });
}

/**
 * Group filtered rows by SPIFF's employee_id.
 *
 * THE JOIN: SPIFF's employee_id is DUTCHIE'S numeric id (44905), not a GX Core slug —
 * it attributes from Dutchie's own export. Leaderboard's own roster and every
 * transaction already carry that same id (txEmployee_().id), so we join on it directly
 * and never on a name. Crew reaches the same id the long way, through GX Core's
 * dutchie_employee_id column, because Crew is keyed by slug; we don't need the detour.
 * Matching on names is what breaks — a rename or a nickname silently reassigns money.
 *
 * ZERO IS NOT ABSENT. A budtender at 2 of 5 has earned 0 and MUST still be indexed: that
 * half-filled row is the whole point of putting this on a kiosk. Only someone SPIFF has
 * no row for at all is missing here.
 */
function spiffIndexByEmployee_(rows) {
  var idx = Object.create(null);
  (rows || []).forEach(function (r) {
    var id = String(r.employee_id == null ? '' : r.employee_id).trim();
    if (!id) return;
    var e = idx[id] || (idx[id] = { employee_id: id, name: r.name || '', earned: 0, programs: [] });
    e.earned += Number(r.earned) || 0;
    e.programs.push({
      program_id: r.program_id,
      vendor:     r.vendor || '',
      name:       r.program_name || '',
      units:      Number(r.units)  || 0,
      target:     Number(r.target) || 0,
      hit:        !!r.hit,
      earned:     Number(r.earned) || 0,
    });
  });
  return idx;
}

/**
 * The one program a card should lead with, when someone is in several.
 *
 * A kiosk card has room for one progress row, so the choice matters. Priority:
 *   1. Closest to target WITHOUT having hit it — the one they can still act on today.
 *      That is what a leaderboard is for: showing the thing still in reach.
 *   2. Otherwise the biggest payout already earned — nothing left to chase, so show
 *      the win rather than an arbitrary first row.
 * `more` carries the count so the card can say "+2 more" instead of quietly hiding them.
 */
function spiffLeadProgram_(entry) {
  var ps = (entry && entry.programs) || [];
  if (!ps.length) return null;
  var open = ps.filter(function (p) { return !p.hit && p.target > 0; });
  var lead;
  if (open.length) {
    lead = open.slice().sort(function (a, b) {
      return (b.units / b.target) - (a.units / a.target);
    })[0];
  } else {
    lead = ps.slice().sort(function (a, b) { return (b.earned || 0) - (a.earned || 0); })[0];
  }
  return { lead: lead, more: ps.length - 1, totalEarned: Number(entry.earned) || 0 };
}

/**
 * Everything getStandings_ needs for one store: { ok, refreshed_at, byId: { dutchieId: card } }.
 *
 * `byId` is keyed by the Dutchie numeric id as a STRING, because that is what
 * aggregateTransactions_ puts on each employee record and JS object keys are strings
 * anyway — comparing 44905 to '44905' is exactly the silent miss this join exists to avoid.
 */
function spiffForStore_(store) {
  var raw = spiffFetchRaw_();
  if (!raw.ok) return { ok: false, error: raw.error, byId: {} };

  var pp   = currentPPStart_();
  var rows = spiffFilterRows_(raw.rows, coreStoreId_(store), pp.ppStartStr, pp.ppEndStr);
  var idx  = spiffIndexByEmployee_(rows);

  var byId = Object.create(null);
  Object.keys(idx).forEach(function (id) {
    var pick = spiffLeadProgram_(idx[id]);
    if (!pick || !pick.lead) return;
    byId[id] = {
      vendor:      pick.lead.vendor,
      program:     pick.lead.name,
      units:       pick.lead.units,
      target:      pick.lead.target,
      hit:         pick.lead.hit,
      earned:      pick.lead.earned,
      totalEarned: pick.totalEarned,
      more:        pick.more,
    };
  });

  return {
    ok:           true,
    refreshed_at: raw.refreshed_at || '',
    ppStart:      pp.ppStartStr,
    ppEnd:        pp.ppEndStr,
    byId:         byId,
  };
}

/**
 * Read-only explanation of what SPIFF is returning and how much of it survives each
 * step — same spirit as emptargetdiag: answers "why is there no tick on this card"
 * with the inputs, not just an empty result. Reuses the same functions the kiosk runs.
 */
function diagSpiff_(storeSlug) {
  var store = null;
  STORES.forEach(function (s) { if (s.slug === storeSlug) store = s; });
  if (!store) return { ok: false, error: 'unknown store: ' + storeSlug };

  var raw = spiffFetchRaw_();
  if (!raw.ok) return { ok: false, error: raw.error, store: storeSlug, stage: 'fetch' };

  var pp     = currentPPStart_();
  var coreId = coreStoreId_(store);
  var rows   = spiffFilterRows_(raw.rows, coreId, pp.ppStartStr, pp.ppEndStr);
  var res    = spiffForStore_(store);

  var roster = (getEmployeeRoster_() || {})[storeSlug] || [];
  var known  = Object.create(null);
  roster.forEach(function (emp) { if (emp && emp.id) known[String(emp.id)] = emp.name; });

  var matched = [], orphan = [];
  Object.keys(res.byId).forEach(function (id) {
    if (known[id]) matched.push(known[id] + ' (' + id + ')');
    /* SPIFF is paying somebody this store's Dutchie roster does not know. Reported, never
       dropped: unpaid vendor money going unnoticed is the thing this feature exists to stop. */
    else orphan.push((res.byId[id].program || '?') + ' -> dutchie id ' + id);
  });

  return {
    ok:              true,
    store:           storeSlug,
    coreStoreId:     coreId,
    payPeriod:       pp.ppStartStr + ' … ' + pp.ppEndStr,
    refreshedAt:     raw.refreshed_at || '',
    rowsInCache:     (raw.rows || []).length,
    rowsThisStore:   rows.length,
    peopleWithSpiff: Object.keys(res.byId).length,
    matchedToRoster: matched,
    notOnRoster:     orphan,
    cards:           res.byId,
  };
}
