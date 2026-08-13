// ============================================================
//  Green Cross — Historical Snapshots  (snapshot.gs)
//  Nightly EOD snapshot capture, backfill utilities, and
//  the historical director data reader.
// ============================================================

// ── EOD Snapshot ──────────────────────────────────────────────────────────────
// Captures full end-of-day data for all stores into a Google Sheet so the
// Director view can browse historical dates.
//
// Schema (one row per store per day):
//   date | store_slug | store_name | revenue | goal | pct_to_goal |
//   transactions | avg_order_value | hourly_data (JSON) | on_shift_data (JSON) | snapshot_ts
//
// Run installSnapshotTrigger() once from the GAS editor to register the nightly
// trigger (~11pm PT).  Use backfillSnapshot_('YYYY-MM-DD') to recover a missed day.

var SNAPSHOT_SHEET_ID_KEY = 'GC_SNAPSHOT_SHEET_ID';
var SNAPSHOT_SHEET_NAME   = 'EOD_Snapshots';
var SNAPSHOT_COLS = [
  'date','store_slug','store_name','revenue','goal','pct_to_goal',
  'transactions','avg_order_value','hourly_data','on_shift_data','snapshot_ts'
];

/** Returns (or creates) the EOD_Snapshots sheet, wiring up headers on first run. */
function getSnapshotSheet_() {
  var props = PropertiesService.getScriptProperties();
  var ssId  = props.getProperty(SNAPSHOT_SHEET_ID_KEY);
  var ss;
  if (ssId) {
    try { ss = SpreadsheetApp.openById(ssId); } catch(e) { ssId = null; }
  }
  if (!ssId) {
    ss   = SpreadsheetApp.create('GC Sales EOD Snapshots');
    ssId = ss.getId();
    props.setProperty(SNAPSHOT_SHEET_ID_KEY, ssId);
    Logger.log('[snapshot] Created spreadsheet: https://docs.google.com/spreadsheets/d/' + ssId);
  }
  var sheet = ss.getSheetByName(SNAPSHOT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.getActiveSheet();
    sheet.setName(SNAPSHOT_SHEET_NAME);
    sheet.getRange(1, 1, 1, SNAPSHOT_COLS.length).setValues([SNAPSHOT_COLS]);
    sheet.setFrozenRows(1);
    // Widen the JSON columns for readability
    sheet.setColumnWidth(9,  350);  // hourly_data
    sheet.setColumnWidth(10, 350);  // on_shift_data
  }
  return sheet;
}

/** Build a single sheet row from a getStoreToday() result. */
function buildSnapshotRow_(date, store, data) {
  return [
    date,
    store.slug,
    store.name,
    data.revenue       || 0,
    data.goal          || 0,
    data.pctToGoal     || 0,
    data.transactions  || 0,
    data.avgOrderValue || 0,
    JSON.stringify(data.hourly  || []),
    JSON.stringify(data.onShift || []),
    new Date().toISOString()
  ];
}

/**
 * Normalise a date cell read from a Sheets getValues() call.
 * Sheets auto-converts 'YYYY-MM-DD' strings to Date objects; this
 * always returns a 'YYYY-MM-DD' string regardless of which form it was.
 */
function normDateCell_(cell) {
  if (cell instanceof Date) return Utilities.formatDate(cell, STORE_TZ, 'yyyy-MM-dd');
  return String(cell).trim();
}

/**
 * Write (or overwrite) one store's snapshot row for the given date.
 * Idempotent — if a row for date+slug already exists it is updated in place.
 */
function writeSnapshotRow_(sheet, date, store, data) {
  var allValues = sheet.getDataRange().getValues();
  var headers   = allValues[0];
  var dateCol   = headers.indexOf('date');
  var slugCol   = headers.indexOf('store_slug');
  var row       = buildSnapshotRow_(date, store, data);

  for (var i = 1; i < allValues.length; i++) {
    if (normDateCell_(allValues[i][dateCol]) === date && allValues[i][slugCol] === store.slug) {
      sheet.getRange(i + 1, 1, 1, SNAPSHOT_COLS.length).setValues([row]);
      return;
    }
  }
  sheet.appendRow(row);
}

/**
 * Snapshot all stores right now, tagged with today's PT date.
 * Called nightly by the time-based trigger.
 */
function snapshotAllStores_() {
  var sheet = getSnapshotSheet_();
  var date  = ptNow_().dateStr;   // 'YYYY-MM-DD' in PT

  STORES.forEach(function(store) {
    try {
      var data = getStoreToday(store, {});
      writeSnapshotRow_(sheet, date, store, data);
      Logger.log('[snapshot] ' + store.slug + ' → ' + date + ' $' + data.revenue);
    } catch(e) {
      Logger.log('[snapshot] ' + store.slug + ' FAILED: ' + e.message);
    }
  });
}

/**
 * Manual backfill: snapshot live data tagged as the specified date.
 * Useful when the nightly trigger missed a day — run before midnight on the
 * missed date, or as close as possible to catch the full-day numbers.
 *
 * Usage: call backfillSnapshot_('2026-05-26') from the GAS editor.
 */
function backfillSnapshot_(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    Logger.log('[backfill] Invalid date — pass a YYYY-MM-DD string, e.g. backfillSnapshot_("2026-05-26")');
    return;
  }
  var sheet = getSnapshotSheet_();
  Logger.log('[backfill] Snapshotting all stores as ' + dateStr);

  STORES.forEach(function(store) {
    try {
      var data = getStoreToday(store, {});
      writeSnapshotRow_(sheet, dateStr, store, data);
      Logger.log('[backfill] ' + store.slug + ' → ' + dateStr + ' $' + data.revenue);
    } catch(e) {
      Logger.log('[backfill] ' + store.slug + ' FAILED: ' + e.message);
    }
  });
}

/**
 * Read all store snapshots for a given date (YYYY-MM-DD) from the Sheet.
 * Returns { ok, date, stores: [ { slug, name, revenue, goal, pctToGoal,
 *   transactions, avgOrderValue, hourly, onShift, snapshotTs } ] }
 */
function getHistoricalDirector_(dateStr) {
  var sheet;
  try { sheet = getSnapshotSheet_(); } catch(e) {
    return { ok: false, error: 'Could not open snapshot sheet: ' + e.message };
  }

  var allValues = sheet.getDataRange().getValues();
  var headers   = allValues[0];
  var idx = {};
  headers.forEach(function(h, i) { idx[h] = i; });

  var rows = allValues.slice(1).filter(function(row) {
    return normDateCell_(row[idx['date']]) === dateStr;
  });

  if (rows.length === 0) {
    return { ok: false, error: 'No snapshot found for ' + dateStr + '. The nightly trigger runs at ~11pm PT — check that date is in the past and the trigger has run.' };
  }

  var stores = rows.map(function(row) {
    var hourly  = [];
    var onShift = [];
    try { hourly  = JSON.parse(row[idx['hourly_data']]  || '[]'); } catch(e) {}
    try { onShift = JSON.parse(row[idx['on_shift_data']] || '[]'); } catch(e) {}
    return {
      slug:          row[idx['store_slug']],
      name:          row[idx['store_name']],
      revenue:       Number(row[idx['revenue']])       || 0,
      goal:          Number(row[idx['goal']])          || 0,
      pctToGoal:     Number(row[idx['pct_to_goal']])   || 0,
      transactions:  Number(row[idx['transactions']])  || 0,
      avgOrderValue: Number(row[idx['avg_order_value']]) || 0,
      hourly:        hourly,
      onShift:       onShift,
      snapshotTs:    row[idx['snapshot_ts']] || ''
    };
  });

  return { ok: true, date: dateStr, stores: stores };
}

/**
 * Fetch real historical data for a specific past PT date (YYYY-MM-DD).
 * Returns the same shape as what buildSnapshotRow_ expects:
 *   { revenue, goal, pctToGoal, transactions, avgOrderValue, hourly, onShift }
 *
 * Uses the actual Dutchie UTC range for the given calendar date in PT,
 * so numbers reflect what really happened on that day — not today's live data.
 */
function getStoreForDate_(store, dateStr) {
  // PT midnight → PT end-of-day in UTC (DST-correct via ptDateToUtcMs_)
  var fromMs  = ptDateToUtcMs_(dateStr);
  var toMs    = fromMs + 24 * 60 * 60 * 1000 - 1;
  var fromUTC = new Date(fromMs).toISOString();
  var toUTC   = new Date(toMs).toISOString();

  var txns    = fetchStoreTransactions_(store.slug, fromUTC, toUTC);
  var agg     = aggregateTransactions_(txns);
  var hourMap = aggregateByHour_(txns);

  // Daily goal for the day-of-week on that past date (DST-safe noon probe)
  var d   = new Date(Date.UTC(Number(dateStr.slice(0,4)), Number(dateStr.slice(5,7))-1, Number(dateStr.slice(8,10)), 12));
  var dow = parseInt(Utilities.formatDate(d, STORE_TZ, 'u'), 10) % 7;  // Mon=1…Sun=0
  var goal = getDailyGoalForDow_(store.slug, dow);

  var pctToGoal = goal > 0 ? r3_(agg.sales / goal) : 0;

  // Hourly bar array (same shape as getStoreToday hourly, all bars are "final")
  var maxRevenue = 1;
  Object.keys(hourMap).forEach(function(h) { if (hourMap[h].revenue > maxRevenue) maxRevenue = hourMap[h].revenue; });
  var hourly = [];
  for (var h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
    var hd  = hourMap[h] || { revenue: 0, count: 0 };
    var lbl = h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p';
    hourly.push({
      hour:      lbl,
      revenue:   Math.round(hd.revenue),
      pct:       r1_(hd.revenue / maxRevenue * 100),
      current:   false,  // historical — no "current" bar
      projected: false,
    });
  }

  // onShift = employees who transacted that day, sorted by sales descending
  var _excluded = getExcluded_();
  var _nicks    = getNicknames_();
  var onShift = Object.values(agg.byEmployee)
    .filter(function(emp) { return !_excluded.has(nameToKey_(emp.name)); })
    .sort(function(a, b) { return b.sales - a.sales; })
    .map(function(emp) {
      return {
        initials:     emp.initials,
        name:         applyNickname_(emp.name, _nicks),
        nameKey:      nameToKey_(emp.name),  // pre-nickname canonical key — frontend uses this for initials + avatar lookup
        status:       'on',
        sales:        Math.round(emp.sales),
        transactions: emp.transactions || 0,
      };
    });

  return {
    revenue:       Math.round(agg.sales),
    goal:          goal,
    pctToGoal:     pctToGoal,
    transactions:  agg.transactions,
    avgOrderValue: agg.avgOrderValue,
    hourly:        hourly,
    onShift:       onShift,
  };
}

/**
 * Backfill real historical Dutchie data for each of the last N days.
 * Fetches actual transaction data for each past date — not today's live numbers.
 *
 * Usage: select backfillRecentDays in the GAS editor and click Run.
 * Change NUM_DAYS at the top if you want more or fewer days.
 */
// Public entry point so GAS editor can run it (functions ending in _ are private)
function backfillRecentDays() { backfillRecentDays_(); }

function backfillRecentDays_(numDays) {
  var NUM_DAYS = numDays || 7;  // ← adjust as needed (7 = full week)
  var sheet = getSnapshotSheet_();

  for (var d = 1; d <= NUM_DAYS; d++) {
    var pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - d);
    var dateStr = Utilities.formatDate(pastDate, STORE_TZ, 'yyyy-MM-dd');
    Logger.log('[backfill] Fetching real Dutchie data for ' + dateStr + ' …');

    STORES.forEach(function(store) {
      try {
        var data = getStoreForDate_(store, dateStr);
        writeSnapshotRow_(sheet, dateStr, store, data);
        Logger.log('[backfill]   ' + store.slug + ' → ' + dateStr + ' $' + data.revenue);
      } catch(e) {
        Logger.log('[backfill]   ' + store.slug + ' FAILED: ' + e.message);
      }
    });
  }

  Logger.log('[backfill] Done — ' + NUM_DAYS + ' days written to sheet.');
}

/**
 * Backfill real historical Dutchie data from fromDateStr through yesterday (or toDateStr).
 * Uses fetchAllStoresTransactionsMulti_ to fire all requests in parallel per 30-day chunk
 * so the whole year runs in ~2-3 minutes — well within GAS's 6-minute execution limit.
 *
 * Usage (run from GAS editor):
 *   backfillYear2026()           → Jan 1, 2026 → yesterday
 *   backfillDateRange('2026-01-01', '2026-03-31')  → custom range
 *
 * If you hit a timeout (rare) split it: run Jan–Jun first, then Jul–present.
 */
function backfillYear2026() { backfillDateRange_('2026-01-01'); }
function backfillDateRange(fromDateStr, toDateStr) { backfillDateRange_(fromDateStr, toDateStr); }

function backfillDateRange_(fromDateStr, toDateStr) {
  var sheet = getSnapshotSheet_();

  // Default toDateStr = yesterday (most recent complete day)
  if (!toDateStr) {
    var yd = new Date();
    yd.setDate(yd.getDate() - 1);
    toDateStr = Utilities.formatDate(yd, STORE_TZ, 'yyyy-MM-dd');
  }

  // Build the full list of dates to backfill
  var dates  = [];
  var curMs  = ptDateToUtcMs_(fromDateStr);
  var endMs  = ptDateToUtcMs_(toDateStr);
  while (curMs <= endMs) {
    dates.push(Utilities.formatDate(new Date(curMs), STORE_TZ, 'yyyy-MM-dd'));
    curMs += 24 * 60 * 60 * 1000;
  }

  Logger.log('[backfill] ' + fromDateStr + ' → ' + toDateStr
    + ' = ' + dates.length + ' days × ' + STORES.length + ' stores = '
    + (dates.length * STORES.length) + ' rows');

  // Read all existing sheet rows once so we can detect duplicates cheaply
  var allValues   = sheet.getDataRange().getValues();
  var headers     = allValues[0];
  var colIdx      = {};
  headers.forEach(function(h, i) { colIdx[h] = i; });
  var existingMap = {};   // 'YYYY-MM-DD:slug' → 1-based sheet row number
  for (var r = 1; r < allValues.length; r++) {
    var rd = normDateCell_(allValues[r][colIdx['date']]);
    var rs = allValues[r][colIdx['store_slug']];
    if (rd && rs) existingMap[rd + ':' + rs] = r + 1;
  }

  // Load lookup tables once — avoids a ScriptProperty read per iteration
  var _excluded = getExcluded_();
  var _nicks    = getNicknames_();

  var CHUNK_DAYS = 30;   // 30 days × 6 stores = 180 parallel requests per fetchAll
  var newRows = [];      // rows to append in one batch write
  var updRows = [];      // { sheetRow, row } for rows that already exist

  for (var ci = 0; ci < dates.length; ci += CHUNK_DAYS) {
    var chunk = dates.slice(ci, ci + CHUNK_DAYS);

    // Build UTC ranges for this chunk
    var ranges = chunk.map(function(ds) {
      var fromMs = ptDateToUtcMs_(ds);
      return {
        dateStr: ds,
        fromUTC: new Date(fromMs).toISOString(),
        toUTC:   new Date(fromMs + 24 * 60 * 60 * 1000 - 1).toISOString(),
      };
    });

    Logger.log('[backfill] Chunk ' + chunk[0] + ' – ' + chunk[chunk.length - 1]
      + ' (' + (chunk.length * STORES.length) + ' parallel requests)…');

    // Fire all (chunk × stores) requests in a single parallel fetchAll
    var fetchRanges = ranges.map(function(r) { return { fromUTC: r.fromUTC, toUTC: r.toUTC }; });
    var fetched = fetchAllStoresTransactionsMulti_(fetchRanges);

    ranges.forEach(function(range, ri) {
      var byStore = fetched[ri];

      // DOW is the same for all stores on a given date — compute once per date
      var probe = new Date(Date.UTC(
        Number(range.dateStr.slice(0, 4)),
        Number(range.dateStr.slice(5, 7)) - 1,
        Number(range.dateStr.slice(8, 10)), 12  // noon UTC → always correct PT date
      ));
      var dow = parseInt(Utilities.formatDate(probe, STORE_TZ, 'u'), 10) % 7; // Mon=1…Sun=0

      STORES.forEach(function(store) {
        var txns    = byStore[store.slug] || [];
        var agg     = aggregateTransactions_(txns);
        var hourMap = aggregateByHour_(txns);

        var goal = getDailyGoalForDow_(store.slug, dow);

        // Hourly bars — all bars are "final" (no current/projected for historical days)
        var maxRev = 1;
        Object.keys(hourMap).forEach(function(h) {
          if (hourMap[h].revenue > maxRev) maxRev = hourMap[h].revenue;
        });
        var hourly = [];
        for (var h = STORE_OPEN_HOUR; h < STORE_CLOSE_HOUR; h++) {
          var hd  = hourMap[h] || { revenue: 0, count: 0 };
          var lbl = h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p';
          hourly.push({
            hour: lbl, revenue: Math.round(hd.revenue),
            pct: r1_(hd.revenue / maxRev * 100), current: false, projected: false,
          });
        }

        // Employees who transacted on this date, sorted by sales
        var onShift = Object.values(agg.byEmployee)
          .filter(function(emp) { return !_excluded.has(nameToKey_(emp.name)); })
          .sort(function(a, b) { return b.sales - a.sales; })
          .map(function(emp) {
            return {
              initials:     emp.initials,
              name:         applyNickname_(emp.name, _nicks),
              status:       'on',
              sales:        Math.round(emp.sales),
              transactions: emp.transactions || 0,
            };
          });

        var data = {
          revenue:       Math.round(agg.sales),
          goal:          goal,
          pctToGoal:     goal > 0 ? r3_(agg.sales / goal) : 0,
          transactions:  agg.transactions,
          avgOrderValue: agg.avgOrderValue,
          hourly:        hourly,
          onShift:       onShift,
        };

        var row = buildSnapshotRow_(range.dateStr, store, data);
        var key = range.dateStr + ':' + store.slug;

        if (existingMap[key]) {
          updRows.push({ sheetRow: existingMap[key], row: row });
        } else {
          newRows.push(row);
          // Register in existingMap so a second chunk never re-adds the same row
          existingMap[key] = -1; // sentinel — actual row number not needed after this
        }
      });

      Logger.log('[backfill] ' + range.dateStr + ' ✓ (' + STORES.length + ' stores, chunk ' + (ri + 1) + '/' + chunk.length + ')');
    });
  }

  // Batch-append all new rows in a single sheet operation (vastly faster than appendRow loop)
  if (newRows.length > 0) {
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, newRows.length, SNAPSHOT_COLS.length).setValues(newRows);
    Logger.log('[backfill] Appended ' + newRows.length + ' new rows');
  }

  // Update existing rows (can't batch non-contiguous ranges — write individually)
  updRows.forEach(function(u) {
    sheet.getRange(u.sheetRow, 1, 1, SNAPSHOT_COLS.length).setValues([u.row]);
  });
  if (updRows.length > 0) Logger.log('[backfill] Overwrote ' + updRows.length + ' existing rows');

  Logger.log('[backfill] ✅ Complete — '
    + dates.length + ' days × ' + STORES.length + ' stores = '
    + (newRows.length + updRows.length) + ' total rows processed.');
}

/**
 * Run once from the GAS editor to register the nightly EOD snapshot trigger.
 * Fires daily at UTC 6:xx — that's 11pm PDT / 10pm PST, ~30–60 min after close.
 */
function installSnapshotTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'snapshotAllStores_'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('snapshotAllStores_')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .create();

  Logger.log('[snapshot] Trigger installed — fires daily at UTC 6:xx (~11pm PDT / 10pm PST)');
}

// ============================================================
//  Nightly EOD guardrail  (sales-cache tripwire)
// ============================================================
// The regression that eroded trust during the demo: GX Core's shared sales cache
// (GXCore.getSalesDaily net) silently drifted ~11% below the truth, while the app's OWN
// Dutchie /reporting/transactions totals (byStoreAggCached_) stayed correct — verified to
// match Dutchie's EOD Net Sales export to ~0.03%. A manager caught it, not the system.
//
// This tripwire compares the two nightly, per store, over the last few settled days. If any
// store's cache net drifts more than EOD_GUARD_THRESHOLD from the app's Dutchie total, it files
// a HIGH-priority bug on the Master Control board (via GXCore.gxIngestBug) so the regression is
// caught automatically — by the system, before a human. It's deduped (only re-alerts when the
// set of drifting store-days CHANGES) and self-clears (posts nothing once the cache is back in
// line, and re-arms for the next drift). Leaderboard reads its own Dutchie totals, so its own
// numbers are unaffected — this guards every app that reads the shared cache, and confirms when
// core-admin's fix lands.
var EOD_GUARD_THRESHOLD = 0.005;   // 0.5% — the drift that trips an alert
var EOD_GUARD_DAYS      = 3;       // check the last N settled days
var EOD_GUARD_MIN_NET   = 200;     // ignore near-zero days (closed/no-data), avoids false positives

/**
 * Compare GX Core cache net vs the app's Dutchie totals per store over the last few settled days.
 * @param {boolean} dryRun  true = compute + return drifts but DON'T file a bug (for on-demand testing)
 * @return {{ok, days, threshold, drifts:Array, alerted:boolean}}
 */
function eodGuardCheck_(dryRun) {
  var now     = ptNow_();
  var todayMs = ptDateToUtcMs_(now.dateStr);
  var id2slug = gxStoreIdToAppSlug_();
  var drifts  = [];

  for (var d = 1; d <= EOD_GUARD_DAYS; d++) {          // d=1 → yesterday, back N settled days
    var dayMs   = todayMs - d * 86400000;
    var dateStr = Utilities.formatDate(new Date(dayMs + 12 * 3600000), STORE_TZ, 'yyyy-MM-dd');

    // GX Core shared cache net, keyed by store_id → app slug
    var cacheNet = {};
    try {
      (GXCore.getSalesDaily('', dateStr, dateStr) || []).forEach(function(r) {
        var slug = id2slug[String(r.store)] || String(r.store);
        cacheNet[slug] = (cacheNet[slug] || 0) + Number(r.net || 0);
      });
    } catch (e) { Logger.log('[eodGuard] getSalesDaily ' + dateStr + ' failed: ' + e); }

    // App's own Dutchie /reporting/transactions total for the same day (settled → served from cache)
    var appAgg = {};
    try {
      appAgg = byStoreAggCached_({ fromUTC: new Date(dayMs).toISOString(), toUTC: new Date(dayMs + 86400000 - 1).toISOString() }, false);
    } catch (e) { Logger.log('[eodGuard] byStoreAggCached_ ' + dateStr + ' failed: ' + e); }

    STORES.forEach(function(s) {
      var app   = (appAgg[s.slug] || {}).sales || 0;
      var cache = cacheNet[s.slug];
      if (app >= EOD_GUARD_MIN_NET && cache != null) {
        var drift = Math.abs(cache - app) / app;
        if (drift > EOD_GUARD_THRESHOLD) {
          drifts.push({ date: dateStr, store: s.slug, app: Math.round(app), cache: Math.round(cache), pct: Math.round(drift * 1000) / 10 });
        }
      }
    });
  }

  // Dedupe: only alert when the SET of drifting store-days changes; self-clear when it resolves.
  var props   = getProps_();
  var sig      = drifts.map(function(x) { return x.date + ':' + x.store; }).sort().join('|');
  var lastSig  = props.getProperty('GC_EOD_GUARD_SIG') || '';
  var alerted  = false;

  if (drifts.length) {
    if (!dryRun && sig !== lastSig) {
      var title = '⚠️ EOD guard: GX Core sales cache off on ' + drifts.length +
                  ' store-day(s) (>' + (EOD_GUARD_THRESHOLD * 100) + '% vs Dutchie)';
      var detail = 'Automated tripwire: GXCore.getSalesDaily net drifted from the app’s Dutchie ' +
        '/reporting/transactions totals (which match Dutchie’s EOD Net Sales export). Any app reading the ' +
        'shared sales cache for revenue is affected; the Leaderboard reads its own Dutchie totals, so its ' +
        'displayed numbers are correct.\n\nDrifting store-days:\n' +
        drifts.map(function(x) {
          return '• ' + x.date + '  ' + x.store + ': cache $' + x.cache + ' vs Dutchie $' + x.app + '  (' + x.pct + '% off)';
        }).join('\n') +
        '\n\nThreshold ' + (EOD_GUARD_THRESHOLD * 100) + '% over the last ' + EOD_GUARD_DAYS + ' settled days. ' +
        'Auto-clears when the cache matches again.';
      try {
        GXCore.gxIngestBug('performance', 'eod-guard', { title: title, desc: detail, priority: 'high', store: drifts[0].store });
        props.setProperty('GC_EOD_GUARD_SIG', sig);
        alerted = true;
        Logger.log('[eodGuard] filed bug — ' + drifts.length + ' store-day(s) drifting');
      } catch (e) { Logger.log('[eodGuard] gxIngestBug failed: ' + e); }
    }
  } else if (lastSig) {
    props.deleteProperty('GC_EOD_GUARD_SIG');           // cache back in line → re-arm for next drift
    Logger.log('[eodGuard] drift cleared — re-armed');
  }

  return { ok: true, days: EOD_GUARD_DAYS, threshold: EOD_GUARD_THRESHOLD, drifts: drifts, alerted: alerted };
}

/**
 * Run once from the GAS editor (or via ?action=installeodguard) to register the nightly guardrail.
 * Fires daily at UTC 15:xx — ~8am PDT / 7am PST, well after GX Core's ~3am cache recompute and the
 * app's ~6am settle, so it compares fully-settled numbers on both sides.
 */
function installEodGuardTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'eodGuardCheck_'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('eodGuardCheck_')
    .timeBased()
    .atHour(15)
    .everyDays(1)
    .create();

  Logger.log('[eodGuard] Trigger installed — fires daily at UTC 15:xx (~8am PDT / 7am PST)');
}
