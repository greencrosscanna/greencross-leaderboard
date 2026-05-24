// ============================================================
//  Green Cross — Director View
//  Renders /director — all-stores command centre
//
//  Data flow:
//    GC.views.renderDirector()
//      → GC.api.fetchDirectorAll()
//      → director.render(data)     injects HTML into #app
//      → director.init(data)       wires interactivity
//
//  All render* functions return HTML strings.
//  init* functions attach event listeners after injection.
// ============================================================

window.GC = window.GC || {};

GC.views.renderDirector = function() {
  var app = document.getElementById('app');
  if (!app) return;

  // Show loading shell while data fetches
  app.innerHTML = director.renderLoading();

  // Start clock immediately (doesn't need data)
  director.startClock();

  GC.api.fetchDirectorAll('mtd')
    .then(function(data) {
      app.innerHTML = director.render(data);
      director.init(data);
    })
    .catch(function(err) {
      console.error('[director] fetch failed:', err);
      app.innerHTML = director.renderError(err.message);
    });
};

// ── Private module ─────────────────────────────────────────
var director = (function() {

  // ── State ──────────────────────────────────────────────
  var _data        = null;
  var _storeFilter = 'all';
  var _tagFilter   = null;
  var _clockTimer  = null;

  // ── Helpers ────────────────────────────────────────────

  function e(s) { return GC.esc(s); }

  function sparklineSvg(data, trendPct) {
    var cls    = GC.trendClass(trendPct);
    var stroke = GC.trendStroke(cls);
    var pts    = GC.sparklinePoints(data, 80, 22);
    var label  = GC.trendLabel(trendPct);
    return '<div class="sparkline-cell">'
      + '<svg width="80" height="22" viewBox="0 0 80 22" style="overflow:visible">'
      + '<polyline fill="none" stroke="' + stroke + '" stroke-width="1.5" points="' + pts + '"/>'
      + '</svg>'
      + '<span class="spark-delta ' + cls + '">' + e(label) + '</span>'
      + '</div>';
  }

  function discountCell(rate) {
    var cls = GC.discountSeverity(rate);
    var pct = GC.fmtPct(rate);
    var w   = Math.min(Math.round((rate / 0.12) * 100), 100);
    return '<span class="disc ' + cls + '">'
      + '<span class="disc-bar"><span style="width:' + w + '%"></span></span>'
      + pct
      + '</span>';
  }

  function rankPillHtml(rank, total) {
    var cls = GC.rankPillClass(rank, total);
    return '<span class="rank-pill ' + cls + '">#' + rank + '</span>';
  }

  function storeDotHtml(slug) {
    return '<span class="store-dot ' + e(slug) + '"></span>';
  }

  function tagsHtml(tags, tagLabels) {
    if (!tags || !tags.length) return '';
    var labels = tagLabels || tags;
    return '<span class="tags">'
      + tags.map(function(t, i) {
          return '<span class="tag ' + e(t) + '">' + e(labels[i] || t) + '</span>';
        }).join('')
      + '</span>';
  }

  function avatarHtml(initials, size) {
    var cls = size === 'lg' ? 'avatar lg' : 'avatar';
    return '<div class="' + cls + '">' + e(initials) + '</div>';
  }

  function vsPlanHtml(vsplan) {
    var cls   = vsplan >= 0.005 ? 'up' : vsplan <= -0.005 ? 'down' : 'flat';
    var arrow = vsplan >= 0.005 ? '▲' : vsplan <= -0.005 ? '▼' : '';
    var pct   = (vsplan >= 0 ? '+' : '−') + Math.abs(vsplan * 100).toFixed(1) + '%';
    return '<span class="vs-plan ' + cls + '">'
      + (arrow ? '<span class="vp-arrow">' + arrow + '</span>' : '')
      + e(pct) + '</span>';
  }

  function salesBarHtml(sales, maxSales) {
    var pct = maxSales > 0 ? Math.round((sales / maxSales) * 100) : 0;
    return '<div class="sales-cell">'
      + '<span class="sales-amt num">' + e(GC.fmtCurrency(sales)) + '</span>'
      + '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>'
      + '</div>';
  }

  // ── Render: Loading ────────────────────────────────────
  function renderLoading() {
    return '<div class="app-page">'
      + renderHeader(null)
      + '<div class="status-strip" style="height:54px"></div>'
      + '<div class="kpi-row large">'
      + '<div class="kpi loading-shimmer" style="height:80px"></div>'.repeat(3)
      + '</div>'
      + '<div class="kpi-row small">'
      + '<div class="kpi small loading-shimmer" style="height:68px"></div>'.repeat(6)
      + '</div>'
      + '</div>';
  }

  // ── Render: Error ──────────────────────────────────────
  function renderError(msg) {
    return '<div class="app-page"><div class="empty-state" style="padding:80px 20px">'
      + '<div style="font-size:32px;margin-bottom:12px">⚠️</div>'
      + '<div style="color:var(--text-dim);margin-bottom:8px">Could not load dashboard data</div>'
      + '<div style="color:var(--text-mute);font-size:11px">' + e(msg || 'Unknown error') + '</div>'
      + '</div></div>';
  }

  // ── Render: Header ─────────────────────────────────────
  function renderHeader(data) {
    var session = GC.auth.load();
    var range   = data ? GC.fmtDateRange(data.summary.dateRange.from, data.summary.dateRange.to) : '';
    var period  = data ? GC.periodLabel('mtd') : 'Month-to-Date';
    return '<header class="director-header">'
      + '<div class="gc-logo"><span class="green">GREEN</span>CROSS</div>'
      + '<span class="view-badge">Director · All Stores</span>'
      + '<span class="breadcrumb">Period: <b>' + e(period) + '</b>'
      + (range ? ' · ' + e(range) : '') + '</span>'
      + '<div class="header-right">'
      + '<div class="clock-mini">'
      + '<div class="cm-time" id="directorClock">—</div>'
      + '<div class="cm-date" id="directorDate">—</div>'
      + '</div>'
      + '<button class="btn-ghost" id="btnRefresh">↻ Refresh</button>'
      + '<button class="btn-ghost" id="btnExport">⤓ Export</button>'
      + (session
          ? '<span class="user-chip" id="userChip">'
            + '<span class="uc-avatar">' + e(session.initials || '??') + '</span>'
            + e(session.displayName || session.user || '') + '</span>'
          : '')
      + '</div>'
      + '</header>';
  }

  // ── Render: Store Status Strip ─────────────────────────
  function renderStatusStrip(stores) {
    var html = '<div class="status-strip">'
      + '<div class="ss-label">Today</div>';
    stores.forEach(function(s) {
      var dotCls = GC.paceDotClass(s.today.pace);
      var revenue = GC.fmtCurrency(s.today.revenue);
      var goal    = GC.fmtCurrency(s.today.goal);
      var pctNum  = s.today.pace;
      var pctCls  = pctNum >= 0.005 ? 'up' : pctNum <= -0.005 ? 'down' : 'flat';
      var pctStr  = (pctNum >= 0 ? '+' : '−') + Math.abs(Math.round(pctNum * 100)) + '%';
      html += '<div class="ss-store" data-slug="' + e(s.slug) + '">'
        + '<span class="ss-dot ' + dotCls + '"></span>'
        + '<div class="ss-info">'
        + '<span class="ss-name">' + e(s.name) + '</span>'
        + '<span class="ss-sub">' + e(revenue) + ' / ' + e(goal) + '</span>'
        + '</div>'
        + '<span class="ss-pct ' + pctCls + '">' + e(pctStr) + '</span>'
        + '</div>';
    });
    html += '</div>';
    return html;
  }

  // ── Render: KPI rows ───────────────────────────────────
  function renderKPIs(summary) {
    var d = summary.deltas;

    function bigKpi(label, value, deltaHtml, colorClass) {
      return '<div class="kpi">'
        + '<div class="kpi-label">' + e(label) + '</div>'
        + '<div class="kpi-value' + (colorClass ? ' ' + colorClass : '') + '">' + value + '</div>'
        + (deltaHtml ? '<div class="kpi-delta ' + (deltaHtml.startsWith('▲') ? 'up' : deltaHtml.startsWith('▼') ? 'down' : '') + '">' + deltaHtml + '</div>' : '')
        + '</div>';
    }

    function smallKpi(label, value, deltaHtml, colorClass) {
      return '<div class="kpi small">'
        + '<div class="kpi-label">' + e(label) + '</div>'
        + '<div class="kpi-value' + (colorClass ? ' ' + colorClass : '') + '">' + value + '</div>'
        + (deltaHtml ? '<div class="kpi-delta">' + deltaHtml + '</div>' : '')
        + '</div>';
    }

    var bigRow = '<div class="kpi-row large">'
      + bigKpi('Total Sales · MTD',    GC.fmtCurrency(summary.totalSales),   GC.fmtDeltaPct(d.totalSalesPct))
      + bigKpi('Transactions',         GC.fmtNum(summary.transactions),       GC.fmtDeltaNum(d.transactions, '') + ' vs. last month')
      + bigKpi('Avg Order Value',      GC.fmtCurrency(summary.avgOrderValue), GC.fmtDeltaCurrency(d.avgOrderValue), 'v-green')
      + '</div>';

    var discDelta = d.discountRatePts
      ? '▲ +' + (d.discountRatePts * 100).toFixed(1) + ' pts'
      : '';
    var flagSub  = summary.flaggedStaffBreakdown
      ? summary.flaggedStaffBreakdown.repeat + ' repeat · ' + summary.flaggedStaffBreakdown.new + ' new'
      : '';

    var smallRow = '<div class="kpi-row small">'
      + smallKpi('Avg UPT',         GC.fmtDecimal(summary.avgUPT),         '▲ +' + GC.fmtDecimal(d.avgUPT))
      + smallKpi('Total Discounts', GC.fmtCurrency(summary.totalDiscounts), '▲ +' + GC.fmtCurrency(d.totalDiscounts), 'v-amber')
      + smallKpi('Discount Rate',   GC.fmtPct(summary.discountRate),        discDelta, 'v-amber')
      + smallKpi('Flagged Staff',   String(summary.flaggedStaff),            flagSub, 'v-red')
      + smallKpi('Active Staff',    String(summary.activeStaff),             'across ' + summary.storeCount + ' stores')
      + smallKpi('Sales / Hour',    '$' + GC.fmtNum(summary.salesPerHour),  GC.fmtDeltaNum(d.salesPerHour, '$'))
      + '</div>';

    return bigRow + smallRow;
  }

  // ── Render: Store filter pills (above staff table) ────
  function renderFilterPills() {
    return '<div class="filter-row" id="filterRow">'
      + ['All Stores','Baseline','Center','Century','Commercial','Portland','River']
          .map(function(s, i) {
            var val = i === 0 ? 'all' : s.toLowerCase();
            var active = (i === 0 && _storeFilter === 'all') || _storeFilter === val;
            return '<button class="pill' + (active ? ' active' : '') + '" data-store="' + val + '">' + e(s) + '</button>';
          }).join('')
      + '<div class="filter-right">'
      + '<button class="pill" data-tag="top10">Top 10</button>'
      + '<button class="pill" data-tag="rising">Rising</button>'
      + '<button class="pill" data-tag="watch">Watch</button>'
      + '<button class="pill' + (_tagFilter === 'flag' ? ' active-red' : '') + '" data-tag="flag" id="flagPill">Flagged · ' + (_data ? _data.alerts.discountWatch.length : 0) + '</button>'
      + '</div>'
      + '</div>';
  }

  // ── Render: Store Leaderboard Table ───────────────────
  function renderStoreTable(stores) {
    var maxSales = stores.length ? stores[0].sales : 1;
    var total    = stores.length;

    var rows = stores.map(function(s) {
      var rpClass = GC.rankPillClass(s.rank, total);
      var tLabels = s.tagLabels || s.tags;
      return '<tr data-slug="' + e(s.slug) + '">'
        + '<td>' + rankPillHtml(s.rank, total) + '</td>'
        + '<td><div class="store-cell">'
          + storeDotHtml(s.slug)
          + '<div class="sc-meta"><div class="sc-name">' + e(s.name) + '</div><div class="sc-sub">' + e(s.address) + ' · ' + s.staffCount + ' staff</div></div>'
          + '</div></td>'
        + '<td><div class="who">'
          + avatarHtml(s.manager.initials)
          + '<div><div class="who-name">' + e(s.manager.name) + '</div><div class="who-sub">' + e(s.manager.roleLabel || 'Store Mgr') + '</div></div>'
          + '</div></td>'
        + '<td>' + salesBarHtml(s.sales, maxSales) + '</td>'
        + '<td>' + vsPlanHtml(s.vsplan) + '</td>'
        + '<td class="num">' + e(GC.fmtNum(s.transactions)) + '</td>'
        + '<td class="num' + (s.avgOrderValue > 79 ? ' v-green' : s.avgOrderValue < 74 ? ' v-red' : '') + '">'
          + e(GC.fmtCurrency(s.avgOrderValue)) + '</td>'
        + '<td class="num">' + e(GC.fmtDecimal(s.avgUPT)) + '</td>'
        + '<td>' + discountCell(s.discountRate) + '</td>'
        + '<td>' + sparklineSvg(s.trend30d, s.trendPct) + '</td>'
        + '<td>' + tagsHtml(s.tags, tLabels) + '</td>'
        + '</tr>';
    }).join('');

    return '<div class="section-head">'
      + '<h2>Store Leaderboard · MTD</h2><span class="sh-sep">/</span>'
      + '<span class="sh-meta">Click any store to drill down</span>'
      + '<a class="sh-link" id="configurePlan">Configure plan targets →</a>'
      + '</div>'
      + '<table class="gc-table" id="storeTable">'
      + '<thead><tr>'
      + '<th style="width:60px">Rank</th>'
      + '<th>Store</th>'
      + '<th>Manager</th>'
      + '<th>Sales</th>'
      + '<th>vs. Plan</th>'
      + '<th>Txns</th>'
      + '<th>AOV</th>'
      + '<th>UPT</th>'
      + '<th>Discount</th>'
      + '<th>Trend · 30d</th>'
      + '<th>Flags</th>'
      + '</tr></thead>'
      + '<tbody id="storeTableBody">' + rows + '</tbody>'
      + '</table>';
  }

  // ── Render: Cross-store Staff Table ───────────────────
  function renderStaffTable(staff) {
    var filtered = applyStaffFilters(staff);
    var maxSales = filtered.length ? filtered[0].sales : 1;
    var total    = staff.length;  // rank pill relative to full list

    var rows = filtered.map(function(s) {
      var isNew = GC.isNewHire(s.hireDate);
      var tags  = s.tags.slice();
      if (isNew && tags.indexOf('new') === -1) tags.push('new');
      return '<tr data-employee="' + e(s.id) + '">'
        + '<td>' + rankPillHtml(s.rank, total) + '</td>'
        + '<td><div class="who">'
          + avatarHtml(s.initials)
          + '<div>'
          + '<div class="who-name">' + e(s.name) + tagsHtml(tags) + '</div>'
          + '<div class="who-sub">' + e(s.hoursWorked) + 'h MTD</div>'
          + '</div></div></td>'
        + '<td><div class="store-cell">'
          + storeDotHtml(s.storeSlug)
          + '<span>' + e(s.storeName) + '</span>'
          + '</div></td>'
        + '<td>' + e(s.roleLabel) + '</td>'
        + '<td class="num">' + e(GC.fmtCurrency(s.sales)) + '</td>'
        + '<td class="num">' + e(GC.fmtNum(s.transactions)) + '</td>'
        + '<td class="num' + (s.avgOrderValue > 80 ? ' v-green' : '') + '">'
          + e(GC.fmtCurrency(s.avgOrderValue)) + '</td>'
        + '<td class="num' + (s.avgUPT >= 2.6 ? ' v-green' : '') + '">'
          + e(GC.fmtDecimal(s.avgUPT)) + '</td>'
        + '<td>' + discountCell(s.discountRate) + '</td>'
        + '<td>' + sparklineSvg(s.trend30d, s.trendPct) + '</td>'
        + '</tr>';
    }).join('');

    return '<div class="section-head">'
      + '<h2>Top Performers · All Stores · MTD</h2>'
      + '<span class="sh-sep">/</span>'
      + '<span class="sh-meta">Across ' + total + ' active staff</span>'
      + '<a class="sh-link" id="viewFullLeaderboard">View full leaderboard →</a>'
      + '</div>'
      + '<table class="gc-table" id="staffTable">'
      + '<thead><tr>'
      + '<th style="width:60px">Rank</th>'
      + '<th>Staff</th>'
      + '<th>Store</th>'
      + '<th>Role</th>'
      + '<th>Sales</th>'
      + '<th>Txns</th>'
      + '<th>AOV</th>'
      + '<th>UPT</th>'
      + '<th>Discount</th>'
      + '<th>Trend · 30d</th>'
      + '</tr></thead>'
      + '<tbody id="staffTableBody">' + rows + '</tbody>'
      + '</table>';
  }

  // ── Render: Alerts Panel ──────────────────────────────
  function renderAlerts(alertsData) {
    var items = alertsData.alerts.map(function(a) {
      return '<div class="alert-item sev-' + e(a.severity) + '" data-alert="' + e(a.id) + '">'
        + '<div class="alert-icon">' + a.icon + '</div>'
        + '<div class="alert-body">'
        + '<div class="alert-title">' + e(a.title) + '</div>'
        + '<div class="alert-desc">' + e(a.description) + '</div>'
        + '<div class="alert-when">' + e(a.when) + '</div>'
        + '</div>'
        + '<button class="alert-cta" data-target="' + e(a.ctaTarget || '') + '">' + e(a.ctaLabel) + '</button>'
        + '</div>';
    }).join('');

    return '<div class="card">'
      + '<h3>Needs Attention</h3>'
      + '<div class="card-sub">Auto-flagged across all stores · last 14 days</div>'
      + '<div class="alerts-list">' + items + '</div>'
      + '</div>';
  }

  // ── Render: Discount Watch ─────────────────────────────
  function renderDiscountWatch(alertsData) {
    // Sort worst (highest discount rate) to top
    var sorted = alertsData.discountWatch.slice().sort(function(a, b) {
      return b.discountRate - a.discountRate;
    });
    var rows = sorted.map(function(w) {
      var reasonMap = {
        veteran: '"veteran" comp',
        manager_comp: '"manager comp"',
        loyalty: '"loyalty stack"',
        medical: '"medical discount"',
        employee: '"employee discount"',
      };
      var reasonLabel = reasonMap[w.topReason] || w.topReason;
      var noteStr = w.reasonNote ? ' (' + w.reasonNote + ')' : '';
      return '<div class="watch-row">'
        + '<div class="watch-who">'
        + '<div class="who">'
        + avatarHtml(w.initials)
        + '<div><div class="who-name">' + e(w.name) + '</div>'
        + '<div class="who-sub">' + e(w.ordersOver15Pct) + ' orders &gt;15% off · ' + e(reasonLabel + noteStr) + '</div>'
        + '</div></div></div>'
        + '<span class="watch-store-tag">' + e(w.storeName) + '</span>'
        + '<span class="watch-pct">' + e(GC.fmtPct(w.discountRate)) + '</span>'
        + '</div>';
    }).join('');

    var chainAvg = alertsData.chainAvgDiscountRate;
    var emptyRow = '';
    if (sorted.length === 0) {
      emptyRow = '<div class="watch-row empty">'
        + '<div class="watch-who"><div class="who-name">No staff over threshold</div>'
        + '<div class="who-sub">Chain avg: ' + GC.fmtPct(chainAvg) + ' this week</div></div>'
        + '</div>';
    } else {
      emptyRow = '<div class="watch-row empty">'
        + '<div class="watch-who">'
        + '<div class="who-name" style="color:var(--text-dim)">No others over threshold</div>'
        + '<div class="who-sub">Chain avg discount rate this week: ' + GC.fmtPct(chainAvg) + '</div>'
        + '</div></div>';
    }

    return '<div class="card">'
      + '<h3>Discount Watch</h3>'
      + '<div class="card-sub">Staff above the ' + GC.fmtPct(GC.THRESHOLDS.discountWatch) + ' chain benchmark, 14-day rolling</div>'
      + '<div class="watch-list">' + rows + emptyRow + '</div>'
      + '</div>';
  }

  // ── Render: Today Aggregate Row ───────────────────────
  // Three widgets matching the kiosk hero cards — Goal arc, Pace gauge, Hourly chart.
  // SVG math identical to kiosk so the visuals are recognisable cross-view.

  var DIR_ARC_LEN = 308; // π × 98 ≈ 308  (same arc as kiosk)
  var DIR_PACE_RANGE = 80;

  function renderDirGoalCard(today) {
    var pct     = today.pctToGoal || 0;
    var pctDisp = Math.round(pct * 100) + '%';
    var capped  = Math.min(pct, 1);
    var offset  = Math.round(DIR_ARC_LEN * (1 - capped));
    var closed  = today.timeRemainingLabel === 'Closed';

    var soldStr = GC.fmtCurrency(today.revenue || 0);
    var toGoStr = GC.fmtCurrency(today.toGo   || 0);
    var remStr  = today.timeRemainingLabel || '—';

    return '<div class="dir-today-card">'
      + '<div class="kcard-label">Daily Goal · ' + e(GC.fmtCurrency(today.goal)) + '</div>'
      + '<div class="dir-gauge-wrap">'
      +   '<svg width="200" height="108" viewBox="0 0 240 130" style="overflow:visible">'
      +     '<path d="M 22 122 A 98 98 0 0 1 218 122" stroke="#232a27" stroke-width="14" fill="none" stroke-linecap="butt"/>'
      +     '<path d="M 22 122 A 98 98 0 0 1 218 122" stroke="#4ade80" stroke-width="14" fill="none"'
      +       ' stroke-linecap="round" stroke-dasharray="308" stroke-dashoffset="' + offset + '"'
      +       ' style="transition:stroke-dashoffset 1.4s cubic-bezier(.2,.7,.3,1)"/>'
      +   '</svg>'
      +   '<div class="dir-gauge-pct">' + e(pctDisp) + '</div>'
      +   '<div class="dir-gauge-sub">to goal</div>'
      + '</div>'
      + '<div class="kcard-stats">'
      +   '<div class="kstat"><div class="kstat-v num">' + e(soldStr) + '</div><div class="kstat-l">Sold</div></div>'
      +   '<div class="kstat"><div class="kstat-v num' + (closed ? '' : '') + '">' + e(toGoStr) + '</div><div class="kstat-l">To go</div></div>'
      +   '<div class="kstat"><div class="kstat-v num">' + e(remStr) + '</div><div class="kstat-l">Remain</div></div>'
      + '</div>'
      + '</div>';
  }

  function renderDirPaceCard(today) {
    var pace     = today.pace || 0;
    var clamped  = Math.max(-DIR_PACE_RANGE, Math.min(DIR_PACE_RANGE, pace * 100));
    var deg      = (clamped / DIR_PACE_RANGE) * 90;
    var zone     = deg <= -30 ? 'red' : deg >= 30 ? 'green' : 'amber';
    var zoneColor = zone === 'red' ? 'var(--red)' : zone === 'green' ? 'var(--green)' : 'var(--amber)';
    var pctStr   = (pace >= 0 ? '+' : '−') + Math.abs(Math.round(pace * 100)) + '%';
    var subLabel = zone === 'red' ? 'Behind plan' : zone === 'green' ? 'Ahead of plan' : 'Near plan';

    var proj     = today.revenue || 0;
    var gap      = today.toGo || 0;
    var gapCls   = gap > 0 ? ' down' : ' up';
    var gapStr   = GC.fmtCurrency(gap);

    return '<div class="dir-today-card">'
      + '<div class="kcard-label">Pace · vs. Plan</div>'
      + '<div class="dir-gauge-wrap">'
      +   '<svg width="200" height="108" viewBox="0 0 240 130" style="overflow:visible">'
      +     '<path d="M 22 122 A 98 98 0 0 1 218 122" stroke="#232a27" stroke-width="10" fill="none" stroke-linecap="butt"/>'
      +     '<path d="M 22 122 A 98 98 0 0 1 71 37"   stroke="var(--red)"   stroke-width="10" fill="none" stroke-linecap="butt" opacity="0.62"/>'
      +     '<path d="M 71 37  A 98 98 0 0 1 169 37"  stroke="var(--amber)" stroke-width="10" fill="none" stroke-linecap="butt" opacity="0.62"/>'
      +     '<path d="M 169 37 A 98 98 0 0 1 218 122" stroke="var(--green)" stroke-width="10" fill="none" stroke-linecap="butt" opacity="0.62"/>'
      +     '<line x1="120" y1="18" x2="120" y2="26" stroke="var(--text-mute)" stroke-width="2"/>'
      +     '<g id="dirPaceTick" style="transform-origin:120px 122px;transform:rotate(' + deg + 'deg);transition:transform 1.4s cubic-bezier(.2,.7,.3,1)">'
      +       '<rect x="113" y="11" width="14" height="26" rx="7" fill="#0a0e0d" opacity="0.55"/>'
      +       '<rect x="115" y="13" width="10" height="22" rx="5" fill="#e6ece9" stroke="#0a0e0d" stroke-width="1.5"/>'
      +     '</g>'
      +   '</svg>'
      +   '<div class="dir-gauge-pct zone-' + zone + '">' + e(pctStr) + '</div>'
      +   '<div class="dir-gauge-sub" style="color:' + zoneColor + '">' + e(subLabel) + '</div>'
      + '</div>'
      + '<div class="kcard-stats">'
      +   '<div class="kstat"><div class="kstat-v num">' + e(GC.fmtCurrency(proj)) + '</div><div class="kstat-l">Revenue</div></div>'
      +   '<div class="kstat' + gapCls + '"><div class="kstat-v num">' + e(gapStr) + '</div><div class="kstat-l">' + e(gap > 0 ? 'Short by' : 'Ahead by') + '</div></div>'
      + '</div>'
      + '</div>';
  }

  function renderDirHourlyCard(today) {
    var hourly = today.hourly || [];
    var bars   = hourly.map(function(h) {
      var cls     = h.current ? ' current' : h.projected ? ' proj' : '';
      var tipVal  = h.revenue > 0 ? GC.fmtCurrency(h.revenue) : '—';
      var tipHtml = h.projected
        ? '<div class="dir-hour-tip proj-tip"><span class="tip-hour">' + e(h.hour) + '</span><span class="tip-val">projected</span></div>'
        : '<div class="dir-hour-tip"><span class="tip-hour">' + e(h.hour) + '</span><span class="tip-val">' + e(tipVal) + '</span></div>';
      return '<div class="dir-hour-col' + cls + '">'
        +   tipHtml
        +   '<div class="dir-hour-bar-wrap">'
        +     '<div class="dir-hour-bar" style="height:' + h.pct + '%"></div>'
        +   '</div>'
        +   '<div class="dir-hour-lbl">' + e(h.hour) + '</div>'
        + '</div>';
    }).join('');

    return '<div class="dir-today-card dir-hourly-card">'
      + '<div class="kcard-label">Today by Hour</div>'
      + '<div class="dir-hourly-chart">' + bars + '</div>'
      + '</div>';
  }

  // ── Render: Full Director Page ─────────────────────────
  function render(data) {
    _data = data;

    var stores = data.stores.stores;
    var staff  = data.staff.staff;
    var sum    = data.summary;
    var alerts = data.alerts;
    var today  = data.today || {};

    return '<div class="app-page">'
      + renderHeader(data)
      + renderStatusStrip(stores)
      + (today.goal
          ? '<div class="dir-today-row">'
              + renderDirGoalCard(today)
              + renderDirPaceCard(today)
              + renderDirHourlyCard(today)
            + '</div>'
          : '')
      + renderKPIs(sum)
      + renderStoreTable(stores)
      + renderFilterPills()
      + renderStaffTable(staff)
      + '<div class="director-lower">'
      + renderAlerts(alerts)
      + renderDiscountWatch(alerts)
      + '</div>'
      + '<div class="footer-note director-footer">'
      + 'Mock data · Director · All Stores · '
      + '<span id="lastRefreshed">—</span>'
      + '</div>'
      + '</div>';
  }

  // ── Filtering / sorting ────────────────────────────────
  function applyStaffFilters(staff) {
    var result = staff.slice();

    // Store filter
    if (_storeFilter !== 'all') {
      result = result.filter(function(s) { return s.storeSlug === _storeFilter; });
    }

    // Tag filter
    if (_tagFilter && _tagFilter !== 'top10') {
      result = result.filter(function(s) { return s.tags && s.tags.indexOf(_tagFilter) !== -1; });
    }
    if (_tagFilter === 'top10') {
      result = result.slice(0, 10);
    }

    // Default sort: sales descending
    result.sort(function(a, b) { return (b.sales || 0) - (a.sales || 0); });

    return result;
  }

  // ── Re-render just the staff table body ───────────────
  function refreshStaffTable() {
    if (!_data) return;
    var tbody = document.getElementById('staffTableBody');
    if (!tbody) return;

    var staff    = _data.staff.staff;
    var filtered = applyStaffFilters(staff);

    filtered.forEach(function(s, i) {
      var isNew = GC.isNewHire(s.hireDate);
      var tags  = s.tags.slice();
      if (isNew && tags.indexOf('new') === -1) tags.push('new');
      var row = tbody.children[i];
      // Rather than fine-grained diffing, just replace all rows
    });

    // Full replace (simple and safe for this data size)
    var maxSales = filtered.length ? filtered[0].sales : 1;
    var total    = staff.length;
    tbody.innerHTML = filtered.map(function(s) {
      var isNew = GC.isNewHire(s.hireDate);
      var tags  = s.tags.slice();
      if (isNew && tags.indexOf('new') === -1) tags.push('new');
      return '<tr data-employee="' + e(s.id) + '">'
        + '<td>' + rankPillHtml(s.rank, total) + '</td>'
        + '<td><div class="who">'
          + avatarHtml(s.initials)
          + '<div><div class="who-name">' + e(s.name) + tagsHtml(tags) + '</div>'
          + '<div class="who-sub">' + e(s.hoursWorked) + 'h MTD</div>'
          + '</div></div></td>'
        + '<td><div class="store-cell">' + storeDotHtml(s.storeSlug) + '<span>' + e(s.storeName) + '</span></div></td>'
        + '<td>' + e(s.roleLabel) + '</td>'
        + '<td class="num">' + e(GC.fmtCurrency(s.sales)) + '</td>'
        + '<td class="num">' + e(GC.fmtNum(s.transactions)) + '</td>'
        + '<td class="num' + (s.avgOrderValue > 80 ? ' v-green' : '') + '">' + e(GC.fmtCurrency(s.avgOrderValue)) + '</td>'
        + '<td class="num' + (s.avgUPT >= 2.6 ? ' v-green' : '') + '">' + e(GC.fmtDecimal(s.avgUPT)) + '</td>'
        + '<td>' + discountCell(s.discountRate) + '</td>'
        + '<td>' + sparklineSvg(s.trend30d, s.trendPct) + '</td>'
        + '</tr>';
    }).join('');
  }

  // ── Clock ──────────────────────────────────────────────
  function startClock() {
    function tick() {
      var now = new Date();
      var ct  = document.getElementById('directorClock');
      var cd  = document.getElementById('directorDate');
      if (ct) ct.textContent = GC.fmtTime(now);
      if (cd) cd.textContent = GC.fmtDateShort(now);
    }
    tick();
    if (_clockTimer) clearInterval(_clockTimer);
    _clockTimer = setInterval(tick, 1000);
  }

  // ── Auto-refresh ───────────────────────────────────────
  var _refreshTimer = null;

  function scheduleRefresh() {
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(function() {
      doRefresh(false);
    }, 30000); // every 30s — matches kiosk polling interval
  }

  function doRefresh(showToast) {
    // If we've navigated away from the director view, stop refreshing
    var hash = window.location.hash || '#/director';
    if (hash !== '#/director' && hash !== '#/' && hash !== '') {
      if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
      return;
    }

    var btn = document.getElementById('btnRefresh');
    if (btn) btn.classList.add('spinning');

    GC.api.fetchDirectorAll('mtd')
      .then(function(data) {
        // Guard again in case route changed while the fetch was in-flight
        var currentHash = window.location.hash || '#/director';
        if (currentHash !== '#/director' && currentHash !== '#/' && currentHash !== '') {
          if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
          return;
        }
        _data = data;
        // Re-render dynamic sections only (avoid full page flash)
        var app = document.getElementById('app');
        if (app) {
          app.innerHTML = render(data);
          init(data);
        }
        if (showToast) GC.toast('Dashboard refreshed', 'success');
      })
      .catch(function(err) {
        if (showToast) GC.toast('Refresh failed: ' + err.message, 'error');
        if (btn) btn.classList.remove('spinning');
      });
  }

  // ── Wire Interactivity ─────────────────────────────────
  function init(data) {
    _data = data;
    startClock();
    scheduleRefresh();

    // Update last-refreshed label
    var lr = document.getElementById('lastRefreshed');
    if (lr) lr.textContent = 'Last refresh ' + GC.fmtTime(new Date());

    // Refresh button
    var btnRefresh = document.getElementById('btnRefresh');
    if (btnRefresh) btnRefresh.addEventListener('click', function() { doRefresh(true); });

    // Export (placeholder)
    var btnExport = document.getElementById('btnExport');
    if (btnExport) btnExport.addEventListener('click', function() {
      GC.toast('Export not yet wired to real API', 'info');
    });

    // User chip → logout
    var chip = document.getElementById('userChip');
    if (chip) chip.addEventListener('click', function() {
      if (confirm('Sign out?')) {
        GC.auth.clear();
        GC.router.navigate('#/login');
      }
    });

    // Store filter pills
    var filterRow = document.getElementById('filterRow');
    if (filterRow) {
      filterRow.addEventListener('click', function(ev) {
        var pill = ev.target.closest('.pill[data-store]');
        var tag  = ev.target.closest('.pill[data-tag]');

        if (pill) {
          _storeFilter = pill.dataset.store;
          filterRow.querySelectorAll('.pill[data-store]').forEach(function(p) {
            p.classList.toggle('active', p.dataset.store === _storeFilter);
          });
          refreshStaffTable();
        }

        if (tag) {
          var t = tag.dataset.tag;
          if (_tagFilter === t) {
            _tagFilter = null;
            tag.classList.remove('active', 'active-red');
          } else {
            filterRow.querySelectorAll('.pill[data-tag]').forEach(function(p) {
              p.classList.remove('active','active-red');
            });
            _tagFilter = t;
            tag.classList.add(t === 'flag' ? 'active-red' : 'active');
          }
          refreshStaffTable();
        }
      });
    }

    // Store table row → navigate to store kiosk
    var storeTable = document.getElementById('storeTable');
    if (storeTable) {
      storeTable.addEventListener('click', function(ev) {
        var row = ev.target.closest('tr[data-slug]');
        if (row) {
          GC.router.navigate('#/store/' + row.dataset.slug);
        }
      });
    }

    // Alert CTAs
    var appEl = document.getElementById('app');
    if (appEl) {
      appEl.addEventListener('click', function(ev) {
        var cta = ev.target.closest('.alert-cta[data-target]');
        if (cta) {
          var target = cta.dataset.target;
          if (target.startsWith('store:')) {
            GC.router.navigate('#/store/' + target.split(':')[1]);
          } else if (target === 'discount-watch') {
            // Scroll to discount watch panel
            var panel = document.querySelector('.watch-list');
            if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else if (target.startsWith('external:')) {
            GC.toast('Open ' + target.split(':')[1] + ' app', 'info');
          } else {
            GC.toast('Feature coming in v1.1', 'info');
          }
        }

        // Status strip store click
        var ssStore = ev.target.closest('.ss-store[data-slug]');
        if (ssStore) {
          GC.router.navigate('#/store/' + ssStore.dataset.slug);
        }

        // Configure plan targets link
        if (ev.target.id === 'configurePlan') {
          GC.toast('Plan configuration coming in v1.1', 'info');
        }

        // View full leaderboard link
        if (ev.target.id === 'viewFullLeaderboard') {
          GC.router.navigate('#/leaderboard');
        }
      });
    }
  }

  // Public API of the director module
  return {
    render:        render,
    renderLoading: renderLoading,
    renderError:   renderError,
    init:          init,
    startClock:    startClock,
  };
})();
