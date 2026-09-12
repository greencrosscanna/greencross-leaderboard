// ============================================================
//  Green Cross — SPIFF progress for kiosk staff cards (spiff.gs)
//
//  Reads SPIFF's finished per-employee sell-through FROM GX CORE and folds it onto
//  each budtender's kiosk card: units toward the vendor's target, and the payout once hit.
//
//  SPIFF OWNS THE NUMBERS. This file measures nothing. SPIFF sets the targets,
//  counts the units and decides what a person earned; we render a finished
//  figure. Computing it a second time here would be a second answer to "what
//  does this person get", and the vendor is being paid SPIFF's number.
//
//  NO LONGER APP-TO-APP (2026-09-08). This used to call SPIFF's /exec directly — the third
//  hop for the same per-employee data, and knowingly against the suite rule that everything
//  cross-app goes through GX Core. Step 2 of the consolidation closed that: SPIFF now
//  publishes each pay period's finished payload to Core's `spiff_publications` after every
//  hourly refresh, and we read it back with GXCore.publishedSpiffProgress. The payload is
//  byte-for-byte the shape ?action=progress already served, deliberately, so this file's
//  filtering, joining and card-shaping below are UNCHANGED — only the source moved.
//
//  THE FILE STAYS. The note announcing the route said Leaderboard "can delete spiff.gs",
//  reading its old header, which promised deletion when Core exposed the slice. That header
//  was about the FETCH, which is now eight lines of library call. Everything else here —
//  the overlap window, the active-status filter, the Dutchie-id join, choosing which of a
//  person's programs a card leads with — is Leaderboard's own display logic, lives nowhere
//  else, and is what puts the tick on the card. Deleting the file removes the feature.
//
//  THE NEW FAILURE MODE, AND WHAT WE DO ABOUT IT. Core stores the payload verbatim and
//  never recomputes it. If SPIFF goes quiet the payload simply gets OLDER and nothing throws
//  anywhere — a consumer that does not check would draw a fortnight-old bar and look healthy
//  doing it. So every scope we take rows from must be fresh (spiffStaleMinutes_), and a stale
//  one is dropped with its reason recorded rather than rendered. On a kiosk, no SPIFF row is
//  a visibly missing feature; a wrong SPIFF row is a budtender told they are at 4 of 5 when
//  the program ended last fortnight.
// ============================================================

var SPIFF_CACHE_KEY  = 'gc_spiff_progress_v2';  // v2: the payload now comes from Core, not SPIFF
var SPIFF_TTL_OK     = 900;   // 15 min. SPIFF's own refresh trigger is hourly, so this is fresh.
var SPIFF_TTL_FAIL   = 120;   // Cache FAILURES too, briefly — see spiffFetchRaw_.

/* HOW MANY PAY PERIODS BACK TO READ, and why this is not 1.
 *
 * Core files a published payload under a SCOPE, and SPIFF derives that scope from the
 * PROGRAM'S START DATE — not from today. A program that began last fortnight and is still
 * running is therefore filed under the PREVIOUS scope, so asking only for the current one
 * would drop it from every card while it is still live. That is the exact case
 * spiffFilterRows_ exists for: a SPIFF runs concurrent to the pay period without being
 * required to line up with it.
 *
 * Three periods covers any program whose start is within the last ~6 weeks. A program
 * running longer than that would fall off the kiosk — diagSpiff_ reports the scopes read and
 * what each contributed, so that shows up as an answer rather than as a mystery.
 */
var SPIFF_LOOKBACK_PERIODS = 3;

/* Fallback for cfg.spiffStaleHours, matching GX Core's own default so the watchdog that
 * emails about a stale publication and the kiosk that stops drawing it agree on the number. */
var SPIFF_STALE_HOURS_DEFAULT = 6;

/**
 * Is the SPIFF row switched on for the kiosk?
 *
 * DEFAULT OFF. A SPIFF program is a vendor arrangement that is not always running — SPIFF had
 * exactly one live on 2026-08-29 — so defaulting on would put an empty row on most cards at most
 * stores, which is worse than no row. Directors turn it on in Settings for the periods it matters.
 *
 * Stored as TEXT 'true'/'false' and compared as a string: the suite rule exists because a Sheets
 * or Properties round-trip turns booleans into text, and `Boolean('false')` is true.
 */
function spiffShowEnabled_() {
  try {
    return String(PropertiesService.getScriptProperties()
      .getProperty(GC_SPIFF_SHOW_KEY) || 'false') === 'true';
  } catch (e) { return false; }
}

/**
 * How old a published payload may be before we refuse to draw it, in MINUTES.
 *
 * ONE NUMBER, HELD IN THE COMMAND CENTER. GX Core's spiff_freshness watchdog already reads
 * cfg.spiffStaleHours to decide when to shout about a stale publication; the kiosk reads the
 * same key to decide when to stop showing one. A second threshold here would mean the alert
 * and the screen could disagree about whether the data is usable, which is the worst of both.
 */
function spiffStaleMinutes_() {
  var hours = SPIFF_STALE_HOURS_DEFAULT;
  try {
    var v = GXCore.getKv('cfg.spiffStaleHours');
    if (v && isFinite(+v) && +v > 0) hours = +v;
  } catch (e) { /* a kiosk that cannot reach Core still needs a threshold */ }
  return Math.round(hours * 60);
}

/**
 * The scopes to read: this pay period's start, then the SPIFF_LOOKBACK_PERIODS - 1 before it.
 *
 * Built by shifting CALENDAR DAYS off the current start, never by subtracting milliseconds —
 * the same trap currentPPStart_ documents at length. An hour either side of PT midnight
 * formats to the wrong DAY, and a scope is matched by exact string equality in Core.
 */
function spiffScopes_() {
  var pp = currentPPStart_();
  var n  = ppDays_();
  var out = [];
  for (var i = 0; i < SPIFF_LOOKBACK_PERIODS; i++) out.push(ptDateShift_(pp.ppStartStr, -i * n));
  return out;
}

/**
 * One scope, read back from Core. NEVER THROWS.
 *
 * "NOTHING PUBLISHED" IS NOT A FAILURE. Core answers ok:false with a "nothing published…"
 * error when no payload exists for a scope, and for a pay period in which no SPIFF program
 * STARTED that is the correct and ordinary answer — most fortnights, for most of the lookback.
 * Treating it as an outage would put a constantly-polled kiosk into the short failure-cache
 * loop and log an error every time, which is exactly the mistake the old code documented
 * about ?status=active and then would have re-made here.
 *
 * A STALE PAYLOAD IS DROPPED, NOT DRAWN — see the header. The reason is carried back so
 * diagSpiff_ can say "SPIFF stopped publishing 9 hours ago" instead of showing an empty board.
 *
 * @return {{ scope:string, rows:Array, used:boolean, reason:string, age_minutes:(number|null),
 *            published_at:string, refreshed_at:string }}
 */
function spiffReadScope_(secret, scope, maxAgeMin) {
  var base = { scope: scope, rows: [], programs: [], used: false, reason: '',
               age_minutes: null, published_at: '', refreshed_at: '' };
  var res;
  try {
    res = GXCore.publishedSpiffProgress(secret, scope);
  } catch (e) {
    base.reason = 'GX Core threw: ' + String((e && e.message) || e);
    return base;
  }
  if (!res || !res.ok) {
    base.reason = (res && res.error) || 'GX Core refused';
    return base;
  }

  base.age_minutes  = (res.age_minutes == null) ? null : Number(res.age_minutes);
  base.published_at = String(res.published_at || '');

  var payload = res.payload || {};
  base.refreshed_at = String(payload.refreshed_at || '');

  /* An envelope with no age is not proof of freshness — it means published_at was unreadable,
     which is the one case where we cannot tell the difference between an hour old and a month
     old. Refuse it, for the same reason a stale one is refused. */
  if (base.age_minutes == null) {
    base.reason = 'published_at missing or unreadable, so freshness cannot be checked';
    return base;
  }
  if (base.age_minutes > maxAgeMin) {
    base.reason = 'stale: published ' + base.age_minutes + ' min ago, limit ' + maxAgeMin;
    return base;
  }

  base.rows = payload.rows || [];
  /* SPIFF'S PROGRAM SIDECAR — one entry per program, not repeated on every employee row. It holds
     the four things a per-person row cannot say: the product in words, each store's goal, what the
     program pays, and Tawny's tips. See spiffProgramsForStore_ for the join and for why reading it
     off the row (which is what this app tried first) finds nothing. */
  base.programs = payload.programs || [];
  base.used = true;
  return base;
}

/**
 * Every fresh published row across the lookback, memoized in CacheService.
 *
 * NEVER THROWS, and never lets a SPIFF or Core problem reach the kiosk. Every failure
 * returns { ok:false, error } and the caller renders staff cards without SPIFF —
 * this is the all-staff screen, and a vendor-bonus widget is not worth a blank board.
 *
 * FAILURES ARE CACHED (briefly) on purpose. The kiosk polls standings continuously;
 * without this, an outage would mean one blocking read per poll per screen, turning
 * somebody else's downtime into our latency.
 *
 * ok:true WITH ZERO ROWS IS A NORMAL FORTNIGHT — nobody is running a SPIFF — and must not be
 * routed through the failure path. Only a missing secret, which no read can recover from,
 * is ok:false here.
 *
 * NO pay_period FILTER, and this is not an oversight. SPIFF stores pay_period as a
 * human-readable RANGE ("2026-08-17 - 2026-08-30") on the row itself, so matching it as a
 * date matches nothing and every card reads zero: indistinguishable from a fortnight where
 * nobody sold anything. The SCOPE the payload is filed under is the derived, trustworthy
 * one; the row's own column is not. We place rows by their WINDOW in spiffFilterRows_ —
 * the fact, not its formatting.
 */
function spiffFetchRaw_() {
  var cache = CacheService.getScriptCache();
  var hit   = cache.get(SPIFF_CACHE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var out;
  var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!secret) {
    // Per-employee money: Core gates this read on the deploy secret, same as SPIFF did.
    out = { ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' };
  } else {
    var maxAge  = spiffStaleMinutes_();
    var scopes  = spiffScopes_().map(function (sc) { return spiffReadScope_(secret, sc, maxAge); });
    var rows    = [];
    var programs = [];
    var freshest = '';
    scopes.forEach(function (s) {
      if (!s.used) return;
      rows = rows.concat(s.rows || []);
      programs = programs.concat(s.programs || []);
      if (s.refreshed_at > freshest) freshest = s.refreshed_at;
    });
    out = {
      ok: true,
      rows: rows,
      programs: programs,
      refreshed_at: freshest,
      maxAgeMinutes: maxAge,
      // Kept on the cached object so diagSpiff_ answers "why is this card empty" from the
      // SAME read the kiosk did, rather than re-running one that might succeed differently.
      scopes: scopes.map(function (s) {
        return { scope: s.scope, used: s.used, rows: (s.rows || []).length,
                 age_minutes: s.age_minutes, published_at: s.published_at,
                 refreshed_at: s.refreshed_at, reason: s.reason };
      }),
    };
    var dropped = out.scopes.filter(function (s) { return !s.used && s.age_minutes != null; });
    if (dropped.length) {
      Logger.log('spiffFetchRaw_: dropped ' + dropped.length + ' stale scope(s): '
                 + dropped.map(function (s) { return s.scope + ' (' + s.reason + ')'; }).join('; '));
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
 * SPIFF (fixed there 2026-08-29, spiff f640a8c, after Date objects normalized in LA time
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
 * Keep only rows whose program SPIFF says is ACTIVE.
 *
 * WHY THIS EXISTS. spiffFilterRows_ keeps a row whose program WINDOW overlaps the pay
 * period, and nothing else. A closed program keeps its dates, so it keeps passing: on
 * 2026-08-30 SPIFF had exactly one program running ("Green Cross - Test4") while the
 * CLOSED "BeGoat Energy Drinks" — dated Aug 1 → Aug 31 — still overlapped and drew on 23
 * of 40 live kiosk cards, mostly as a "+1 more" hanging off somebody else's row.
 *
 * `status` IS A REAL FIELD NOW. This shipped first as an inference off `pay_period` being
 * stamped, because the payload carried nothing else to go on. SPIFF added the field the
 * same day (engine @68, 59b5c9b, in reply to our note): every row carries
 * status = draft | active | closed, RESOLVED AT READ TIME by joining the programs tab —
 * not stored on the cached row, which matters, because the hourly sweep is active-only and
 * a stored column would read 'active' forever for a program closed since its last
 * refresh. Verified live 2026-08-30: 38 active (Test4) / 25 closed (BeGoat), the identical
 * split the inference was producing, so this swap was a no-op on screen and correct by
 * contract rather than by luck.
 *
 * WE FILTER HERE, and since 2026-09-08 there is nowhere else to do it. The rows arrive from
 * Core's published payload, which SPIFF files UNFILTERED on purpose so every consumer sees the
 * same thing; SPIFF's old server-side ?status=active filter is not reachable through Core and
 * we would not want it anyway — it answered ok:false when nothing was active, and "no program
 * is running this fortnight" is a normal steady state, not an outage. The payload also carries
 * a by_employee roll-up we deliberately ignore: it is computed over ALL rows in the scope,
 * including closed ones, while spiffIndexByEmployee_ sums `earned` over the rows we KEEP. That
 * is what stops a finished program inflating a card's totalEarned with money nobody can bank.
 *
 * UNKNOWN IS NOT ACTIVE. If a cached row's program has vanished from the programs tab,
 * SPIFF reports status '' and names the id in `orphan_program_ids`. An orphan fails the
 * equality below and is dropped — SPIFF's own recommendation, and the safe reading on a
 * kiosk: showing a program nobody can look up is worse than showing none.
 *
 * FAILS SAFE. If NO row carries a status at all, the field is GONE — a SPIFF regression, not
 * a fortnight where everything is closed — and we return the rows untouched rather than
 * blanking the SPIFF row on every card at every store. That degrades to the old behavior (a
 * closed program may reappear), which is a visible cosmetic wrong rather than a silent
 * empty kiosk. Note the asymmetry with the orphan rule above: an absent status is only
 * treated as "not active" when OTHER rows prove the field is being populated.
 */
function spiffActiveRows_(rows) {
  var all = rows || [];
  var hasField = all.some(function (r) {
    return r && String(r.status == null ? '' : r.status).trim() !== '';
  });
  if (!hasField) return all;
  return all.filter(function (r) {
    return r && String(r.status == null ? '' : r.status).trim().toLowerCase() === 'active';
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
 * Every program running at one store, with everyone in it: what the kiosk's SPIFF panel lists
 * when a budtender taps the SPIFF button (Sky chose this over opening SPIFF's own store page,
 * 2026-09-10).
 *
 * THE SAME ROWS AS THE CARDS, grouped the other way. The cards group by PERSON and keep one lead
 * program; this groups by PROGRAM and keeps everyone. Both are built from the rows spiffForStore_
 * has already filtered to active, this store and this pay period's window, so the panel cannot
 * list a program the cards have dropped, or the reverse.
 *
 * STILL NO MATH OF OUR OWN. Units, targets, hit and earned are SPIFF's finished figures, copied.
 * The one derived value is `reward`: the payout for hitting the target, stated only when every
 * person who has hit it was paid the SAME amount at the SAME target. SPIFF does not publish the
 * bounty up front, so for a program nobody has hit yet it is null and the panel says "Sell N
 * units" rather than guessing. A number we inferred would be a bounty promised on a wall screen
 * that nobody agreed to.
 *
 * Ordered by the program ENDING SOONEST first, since that is the one worth acting on today, and
 * people within a program by how close they are to their target.
 */
function spiffProgramsForStore_(rows, sidecar, coreStoreId) {
  /* SPIFF's program sidecar, keyed by program_id. Built here rather than passed in already keyed so
     a caller that has no sidecar (an older payload, a test) simply gets the numbers and no copy. */
  var meta = Object.create(null);
  (sidecar || []).forEach(function (m) {
    if (m && m.program_id != null) meta[String(m.program_id)] = m;
  });
  var storeId = String(coreStoreId == null ? '' : coreStoreId).trim();

  var byProg = Object.create(null), order = [];
  (rows || []).forEach(function (r) {
    if (!r) return;
    var key = String(r.program_id == null ? '' : r.program_id).trim()
           || (String(r.vendor || '') + '|' + String(r.program_name || ''));
    var p = byProg[key];
    if (!p) {
      p = byProg[key] = {
        id:       key,
        vendor:   String(r.vendor || ''),
        name:     String(r.program_name || ''),
        start:    String(r.start_date == null ? '' : r.start_date).slice(0, 10),
        end:      String(r.end_date == null ? '' : r.end_date).slice(0, 10),
        target:   Number(r.target) || 0,
        reward:   null,
        earned:   0,
        hitCount: 0,
        /* SPIFF'S OWN PROGRAM COPY, carried through untouched for the kiosk popup to render.
           Leaderboard cannot derive any of these — the product a program is on, the store-level
           goal, the stated payout and Tawny's selling lines live in SPIFF's sheet and only reach us
           if SPIFF publishes them on the row. ABSENT IS THE NORMAL STATE until it does, and the
           popup omits whatever block is missing rather than inventing one.

           `payout` is deliberately separate from `reward` below: reward is an INFERENCE from what
           people have already been paid, and it is null until somebody has hit. A stated payout is
           the real answer and wins wherever it is present. */
        product:  '',
        storeGoal: 0,
        payout:   null,
        tips:     [],
        measuredAt: '',
        people:   [],
      };
      order.push(key);
    }
    if (!p.measuredAt && r.refreshed_at) p.measuredAt = String(r.refreshed_at);

    var person = {
      employee_id: String(r.employee_id == null ? '' : r.employee_id).trim(),
      name:        String(r.name || ''),
      units:       Number(r.units)  || 0,
      target:      Number(r.target) || 0,
      hit:         !!r.hit,
      earned:      Number(r.earned) || 0,
    };
    p.people.push(person);
    p.earned += person.earned;
    if (person.hit) p.hitCount++;
  });

  var frac = function (x) { return x.target > 0 ? x.units / x.target : 0; };
  return order.map(function (k) {
    var p = byProg[k];

    /* THE SIDECAR JOIN. Keyed on program_id, and the goals inside it are keyed on GX Core's
       store_id — one program runs at six stores with six different goals, so reading the wrong
       store's number here would put a target on the kiosk that nobody at that store was given.
       Absent stays absent: a payload published before SPIFF v1.407 carries no sidecar at all, and
       the popup omits whichever block is missing rather than drawing a heading over a gap. */
    var m = meta[String(p.id)];
    if (m) {
      if (m.product) p.product = String(m.product);
      if (m.payout != null && m.payout !== '') p.payout = Number(m.payout) || 0;
      if (m.payout_type) p.payoutType = String(m.payout_type);
      var sg = m.store_goals && storeId ? m.store_goals[storeId] : null;
      if (Number(sg)) p.storeGoal = Number(sg);
      if (Object.prototype.toString.call(m.tips) === '[object Array]') {
        p.tips = m.tips.map(function (t) { return String(t).trim(); })
                       .filter(function (t) { return !!t; });
      }
    }
    var paid = p.people.filter(function (x) { return x.hit && x.earned > 0; });
    var sameTarget = p.people.every(function (x) { return x.target === p.target; });
    if (paid.length && sameTarget && paid.every(function (x) { return x.earned === paid[0].earned; })) {
      p.reward = paid[0].earned;
    }
    p.people.sort(function (a, b) {
      return (frac(b) - frac(a)) || (b.units - a.units) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    return p;
  }).sort(function (a, b) {
    return (a.end < b.end ? -1 : a.end > b.end ? 1 : 0)
        || (a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : 0);
  });
}

/**
 * Everything getStandings_ needs for one store: { ok, refreshed_at, byId: { dutchieId: card } }.
 *
 * `byId` is keyed by the Dutchie numeric id as a STRING, because that is what
 * aggregateTransactions_ puts on each employee record and JS object keys are strings
 * anyway — comparing 44905 to '44905' is exactly the silent miss this join exists to avoid.
 */
function spiffForStore_(store) {
  // Off means OFF: return before the fetch, so a disabled toggle costs nothing per kiosk poll
  // and doubles as the kill switch if SPIFF ever starts misbehaving.
  if (!spiffShowEnabled_()) return { ok: false, error: 'SPIFF row disabled in Settings', byId: {}, programs: [] };

  var raw = spiffFetchRaw_();
  if (!raw.ok) return { ok: false, error: raw.error, byId: {}, programs: [] };

  var pp   = currentPPStart_();
  // Closed programs first, then this store's window — order is irrelevant to the result
  // but this way the store filter never has to reason about staleness.
  var rows = spiffFilterRows_(spiffActiveRows_(raw.rows), coreStoreId_(store), pp.ppStartStr, pp.ppEndStr);
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
    // The SPIFF panel — same rows grouped by program, joined to SPIFF's program sidecar so the
    // popup can show the product, this store's goal, the payout and the tips.
    programs:     spiffProgramsForStore_(rows, raw.programs, coreStoreId_(store)),
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
  /* THE SCOPES, FIRST — because the commonest empty board is no longer "SPIFF is down" but
     "the payload Core holds went stale" or "the program is filed under a fortnight we did not
     read". Reported off the SAME cached read the kiosk used, so this cannot answer differently
     from the screen it is explaining. */

  var pp     = currentPPStart_();
  var coreId = coreStoreId_(store);
  /* SAME FILTER CHAIN AS THE KIOSK, in the same order — spiffActiveRows_ then the store window.
     This route existed to answer "what would the kiosk draw", and for one deploy it did not:
     it called spiffFilterRows_ on raw.rows, so closed programs it had just been taught to
     drop still appeared here. A diagnostic that disagrees with the thing it diagnoses is worse
     than no diagnostic — it is read precisely when somebody is deciding whether to switch the
     row ON, which is the moment a false answer costs the most. */
  var active = spiffActiveRows_(raw.rows);
  var rows   = spiffFilterRows_(active, coreId, pp.ppStartStr, pp.ppEndStr);
  // Deliberately NOT spiffForStore_ — that short-circuits when the row is switched off, and the
  // whole point of this route is checking the data BEFORE switching it on.
  var idx    = spiffIndexByEmployee_(rows);
  var byId   = Object.create(null);
  Object.keys(idx).forEach(function (id) {
    var pick = spiffLeadProgram_(idx[id]);
    if (pick && pick.lead) byId[id] = pick;
  });
  var res    = { byId: byId };

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
    showSpiff:       spiffShowEnabled_(),   // the usual answer to "why is there no row"
    coreStoreId:     coreId,
    /* What the kiosk's SPIFF button actually resolves to for this store, and which of the three
       answers it is. Exposed because it is unaskable from outside otherwise — the payload that
       carries it is session-gated, so "is the link empty right now" could only be guessed at from
       the screen. That guessing is what made the 2026-09-11 fallback take two rounds to find. */
    kioskUrl:        (function () { try { return spiffKioskUrl_(store); } catch (e) { return null; } })(),
    kioskUrlMeans:   (function () {
                       var u; try { u = spiffKioskUrl_(store); } catch (e) { return 'threw: ' + e; }
                       return u === null ? 'COULD NOT ASK — field is omitted, kiosk keeps what it has'
                            : u === ''   ? 'no token configured for ' + coreId + ' — kiosk shows our own panel'
                            :              'ok';
                     })(),
    payPeriod:       pp.ppStartStr + ' … ' + pp.ppEndStr,
    refreshedAt:     raw.refreshed_at || '',
    // Where the rows came from: one entry per pay period read, newest first, each saying
    // whether it was used and — when it was not — exactly why. `used:false` with a reason
    // starting "stale" means SPIFF has stopped publishing; "nothing published" for an older
    // scope is ordinary (no program started that fortnight), not a fault.
    source:          'gxcore:spiff_publications',
    staleLimitMin:   raw.maxAgeMinutes == null ? null : raw.maxAgeMinutes,
    scopesRead:      raw.scopes || [],
    rowsInCache:     (raw.rows || []).length,
    /* Dropped as not-active, named rather than silently missing: "SPIFF says 63 rows and the
       kiosk shows 38" is a question somebody will ask, and this is the answer. A count of 0
       when the cache holds closed programs means the status field went missing and the
       fail-safe in spiffActiveRows_ stood down. */
    rowsNotActive:   (raw.rows || []).length - (active || []).length,
    statusesInCache: (function () {
                       var c = Object.create(null);
                       (raw.rows || []).forEach(function (r) {
                         var k = String((r && r.status) == null ? '' : r.status).trim() || '(none)';
                         c[k] = (c[k] || 0) + 1;
                       });
                       return c;
                     })(),
    rowsThisStore:   rows.length,
    peopleWithSpiff: Object.keys(res.byId).length,
    matchedToRoster: matched,
    notOnRoster:     orphan,
    cards:           Object.keys(res.byId).reduce(function (o, id) {
                       var p = res.byId[id];
                       o[id] = { vendor: p.lead.vendor, program: p.lead.name, units: p.lead.units,
                                 target: p.lead.target, hit: p.lead.hit, earned: p.lead.earned,
                                 totalEarned: p.totalEarned, more: p.more };
                       return o;
                     }, Object.create(null)),
  };
}

/* ============================================================
 *  The SPIFF kiosk board — a LINK, not a second copy of the data
 * ============================================================
 *
 * Sky's ask: "We need unique store links for each store. We will then wire these to Leaderboard
 * so that BTs can open a window with the SPIFF details from their Kiosk." SPIFF shipped its half
 * on 2026-09-08 — a per-store page at store.html?t=<token> showing the running program, its
 * window, the store goal, the per-budtender goal, the bounty, the featured product and Tawny's
 * selling tips. Leaderboard's half is to open it.
 *
 * NOTHING IS RE-RENDERED HERE. We do not read the program, we do not draw the tips, we open
 * SPIFF's own page. A kiosk-shaped copy of a vendor program is a second thing to keep in step
 * with the agreement, and the first time it drifts a screen promises a bounty nobody agreed to.
 *
 * WHY THE TOKEN IS CONFIG AND NOT SOURCE. One PERMANENT token per store, identifying the SCREEN
 * rather than a program, so the same URL sits in a kiosk forever and resolves at read time to
 * whatever runs at that store that day — and says "No SPIFF running right now" when nothing does.
 * They are rotatable from SPIFF's Programs → Kiosk links panel, which makes them credentials with
 * a lifecycle, and a credential with a lifecycle does not belong in a file that needs a deploy to
 * change. So they live in the Command Center as kv, one key per store, and this app reads them.
 *
 * NO SIGN-IN ON THE FAR SIDE, DELIBERATELY. A kiosk is a shared screen nobody signs into, so the
 * token in the URL is the whole credential. That is why SPIFF's page carries NO person and NO
 * margin — no budtender names, no per-person units, no earnings, no vendor cost, no ROI. It is
 * safe on a screen facing the floor with a customer at the counter. The personal view is a
 * different page (flyer.html, which keeps its own sign-in); never point a kiosk at that one.
 */

// Where SPIFF's per-store kiosk page lives. Overridable from the Command Center (kv
// cfg.spiffKioskBase) so a repo rename or a move off Pages is a config change rather than a
// deploy in this app — the same reason the engine URLs are kv and not literals.
var SPIFF_KIOSK_BASE_DEFAULT = 'https://greencrosscanna.github.io/greencross-spiff/store.html';

/**
 * The SPIFF kiosk URL for one store: the URL, '' when this store has no token, or NULL when we
 * could not find out.
 *
 * THOSE LAST TWO ARE NOT THE SAME ANSWER, and folding them together broke the kiosk on
 * 2026-09-11. Every failure path here used to return '' — Core unreachable, a store we could not
 * identify, all of it — and '' means "this store's token was revoked" to the client, which drops
 * SPIFF's page and falls back to Leaderboard's own card. So one unlucky config read, on a route
 * the kiosk polls every 60 seconds, silently replaced the product, the store target and Tawny's
 * selling tips with a card that has none of them, until the next poll happened to succeed.
 *
 * null means "no answer", and the payload OMITS the field entirely rather than sending it — which
 * the client already treats as "change nothing". See GC.views.applySpiffLink, which has drawn that
 * distinction since the day it was written; this function simply never gave it the chance.
 *
 * (Five bugs in this suite have now had this exact shape: an unknown folded into a falsy. An
 * absence needs its own state.)
 *
 * '' IS THE OFF SWITCH, and it is the default. No key, no button — which is the right state for
 * a store whose link has never been minted, and the state every store is in until the six tokens
 * are pasted into the Command Center. A button that opens a broken page is worse than no button
 * on the most visible screen in the company.
 *
 * Keyed on the GX CORE store_id ('bend', 'river-rd'), not Leaderboard's own slug ('century'),
 * because SPIFF's store_links rows are keyed the same way its progress rows are. coreStoreId_ is
 * the one translation between the two, and it already exists for exactly this reason.
 */
function spiffKioskUrl_(store) {
  var id = '';
  try { id = String(coreStoreId_(store) || '').trim(); } catch (e) { return null; }
  if (!id) return null;           // we could not work out which store this is — not "no token"

  var token = '';
  try { token = String(GXCore.getKv('cfg.spiffKiosk.' + id) || '').trim(); }
  catch (e) { return null; }      // a kiosk that cannot reach Core still shows its board
  if (!token) return '';

  var base = SPIFF_KIOSK_BASE_DEFAULT;
  try {
    var b = String(GXCore.getKv('cfg.spiffKioskBase') || '').trim();
    if (/^https:\/\//.test(b)) base = b;    // https only: this ends up as a link on a kiosk
  } catch (e) {}

  return base + '?t=' + encodeURIComponent(token);
}
