// ============================================================
//  Green Cross — Leaderboard View
//  Renders /leaderboard — cross-store staff table
//  Director+ only. Dense, table-driven.
// ============================================================

window.GC = window.GC || {};

GC.views.renderLeaderboard = function(period) {
  var app = document.getElementById('app');
  if (!app) return;
  period = period || 'mtd';
  app.innerHTML = '<div style="padding:60px;text-align:center;color:var(--text-dim)">Loading leaderboard…</div>';

  // Single round-trip reusing the directorall mega-batch
  GC.api.fetchDirectorAll(period)
    .then(function(data) {
      var lbData = lb.normalizeStaff(data.staff, data.avatarConfigs || {});
      app.innerHTML = lb.render(data.summary, data.alerts, lbData, period);
      lb.init(period);
    })
    .catch(function(err) {
      console.error('[leaderboard] fetch failed:', err);
      app.innerHTML = '<div style="padding:40px;color:var(--text-dim)">Failed to load leaderboard.</div>';
    });
};

// ── Private module ──────────────────────────────────────────
var lb = (function() {

  var _lbData   = null;
  var _summary  = null;
  var _alerts   = null;
  var _storeFilter = 'all';
  var _tagFilter   = null;
  var _search      = '';
  var _sortKey     = 'sales';
  var _sortDir     = -1;
  var _period      = 'mtd';

  function e(s) { return GC.esc(String(s)); }

  // ── Render: Nav ──────────────────────────────────────────
  function renderNav() {
    var sess = GC.auth.load() || {};
    var initials = sess.initials || '??';
    var displayName = sess.displayName || 'Director';

    return '<nav class="lb-nav">'
      + '<img class="gc-logo-img" src="' + GC.LOGO_PNG + '" alt="Green Cross" height="28">'
      + '<div class="lb-nav-tabs">'
      + '  <button class="lb-nav-tab" onclick="GC.router.navigate(\'#/director\')">← Director</button>'
      + '  <button class="lb-nav-tab active">Leaderboard</button>'
      + '</div>'
      + '<div class="lb-nav-right">'
      + '  <button class="btn-ghost" id="lbRefreshBtn">↻ Refresh</button>'
      + '  <div class="user-chip">'
      + '    <span class="uc-initials">' + e(initials) + '</span>'
      + '    <span class="uc-name">' + e(displayName) + '</span>'
      + '  </div>'
      + '</div>'
      + '</nav>';
  }

  // ── Render: KPI rows (reuse summary data) ────────────────
  function renderKPIs(summary) {
    var d = summary.deltas || {};

    function bigKpi(label, value, delta, cls) {
      return '<div class="kpi' + (cls ? ' ' + cls : '') + '">'
        + '<div class="kpi-label">' + e(label) + '</div>'
        + '<div class="kpi-value">' + e(value) + '</div>'
        + (delta ? '<div class="kpi-delta">' + e(delta) + '</div>' : '')
        + '</div>';
    }
    function smallKpi(label, value, delta, cls) {
      return '<div class="kpi small' + (cls ? ' ' + cls : '') + '">'
        + '<div class="kpi-label">' + e(label) + '</div>'
        + '<div class="kpi-value">' + e(value) + '</div>'
        + (delta ? '<div class="kpi-delta">' + e(delta) + '</div>' : '')
        + '</div>';
    }

    var bigRow = '<div class="kpi-row large">'
      + bigKpi('Total Sales · MTD',  GC.fmtCurrency(summary.totalSales),    '▲ +' + GC.fmtPct(d.totalSalesPct), 'v-green')
      + bigKpi('Transactions',       GC.fmtNum(summary.transactions),        '▲ +' + GC.fmtNum(d.transactions) + ' vs. last month')
      + bigKpi('Avg Order Value',    GC.fmtCurrency(summary.avgOrderValue),  GC.fmtDeltaCurrency(d.avgOrderValue), 'v-green')
      + '</div>';

    var discDelta = d.discountRatePts
      ? '▲ +' + (d.discountRatePts * 100).toFixed(1) + ' pts' : '';
    var flagSub = summary.flaggedStaffBreakdown
      ? summary.flaggedStaffBreakdown.repeat + ' repeat · ' + summary.flaggedStaffBreakdown.new + ' new' : '';

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

  // ── Render: Filters + controls ───────────────────────────
  function renderFilters(period) {
    period = period || 'mtd';
    var stores = ['Baseline','Center','Century','Commercial','Portland','River'];
    var storePills = stores.map(function(s) {
      return '<button class="pill store-pill" data-slug="' + s.toLowerCase() + '">' + e(s) + '</button>';
    }).join('');

    function opt(val, label) {
      return '<option value="' + val + '"' + (period === val ? ' selected' : '') + '>' + label + '</option>';
    }

    return '<div class="filter-row">'
      + '<button class="pill active" id="lbAllStores" data-slug="all">All Stores</button>'
      + storePills
      + '<div style="margin-left:auto;display:flex;gap:8px">'
      + '  <button class="pill tag-pill" data-tag="top">Top 10</button>'
      + '  <button class="pill tag-pill" data-tag="rising">Rising</button>'
      + '  <button class="pill tag-pill" data-tag="watch">Watch</button>'
      + '  <button class="pill tag-pill" data-tag="flag">Flagged</button>'
      + '</div>'
      + '</div>'
      + '<div class="controls">'
      + '  <input type="text" id="lbSearch" placeholder="Search staff or store…" />'
      + '  <select id="lbPeriod">'
      + opt('pp',    'Period: Pay Period (2-wk)')
      + opt('mtd',   'Period: Month-to-Date')
      + opt('today', 'Period: Today')
      + opt('wtd',   'Period: Week-to-Date')
      + opt('qtd',   'Period: Quarter-to-Date')
      + opt('ytd',   'Period: Year-to-Date')
      + '  </select>'
      + '  <select id="lbRole">'
      + '    <option value="">All Roles</option>'
      + '    <option value="Store Mgr">Store Mgr</option>'
      + '    <option value="Asst Mgr">Asst Mgr</option>'
      + '    <option value="Budtender">Budtender</option>'
      + '  </select>'
      + '  <select id="lbSort">'
      + '    <option value="sales,-1">Sort: Sales ↓</option>'
      + '    <option value="avgOrderValue,-1">AOV ↓</option>'
      + '    <option value="avgUPT,-1">UPT ↓</option>'
      + '    <option value="discountRate,1">Discount % ↑</option>'
      + '  </select>'
      + '</div>';
  }

  // ── Render: Staff table ──────────────────────────────────
  function renderTable(staffData) {
    var staff   = applyFilters(staffData.staff || []);
    var total   = staffData.totalStaff || staff.length;
    var maxSales = staff.length > 0 ? staff[0].sales : 1;

    var metaHtml = '<div class="lb-meta-row">'
      + '<span class="lb-showing">Showing ' + staff.length + ' of ' + total + ' staff</span>'
      + '<span id="lbLastRefresh" style="color:var(--text-mute)">Last refresh ' + GC.fmtTime(new Date()) + '</span>'
      + '</div>';

    var rows = staff.map(function(s) {
      var rankCls   = GC.rankPillClass(s.rank, total);
      var barPct    = maxSales > 0 ? Math.round((s.sales / maxSales) * 100) : 0;
      var discCls   = GC.discountSeverity(s.discountRate);
      var discW     = Math.min(Math.round((s.discountRate / 0.12) * 100), 100);
      var trendCls  = GC.trendClass(s.trendPct);
      var trendStroke = GC.trendStroke(trendCls);
      var trendLabel  = GC.trendLabel(s.trendPct);
      var pts       = GC.sparklinePoints(s.trend30d, 72, 20);

      var tagsHtml = (s.tags || []).map(function(t) {
        var labels = { top: 'TOP', rising: 'RISING', watch: 'WATCH', flag: 'FLAG', new: 'NEW' };
        return '<span class="tag ' + e(t) + '">' + e(labels[t] || t) + '</span>';
      }).join('');

      return '<tr>'
        + '<td><span class="rank-pill ' + e(rankCls) + '">#' + e(s.rank) + '</span></td>'
        + '<td>'
        + '  <div class="who">'
        + GC.lbAvaPuck(s.nameKey, s.avatarConfig, s.initials, true)
        + '    <div>'
        + '      <div class="who-name">' + e(s.name)
        +          (tagsHtml ? ' <span class="tags">' + tagsHtml + '</span>' : '')
        + '      </div>'
        + '      <div class="who-sub">' + e(s.role) + ' · ' + e(s.hours) + 'h MTD</div>'
        + '    </div>'
        + '  </div>'
        + '</td>'
        + '<td class="store-col lb-store-dot">'
        + '  <span class="store-dot ' + e(s.storeSlug) + '"></span>'
        + '  <span class="lb-store-label">' + e(s.storeName) + '</span>'
        + '</td>'
        + '<td>'
        + '  <div class="sales-cell">'
        + '    <span class="sales-amt num">' + e(GC.fmtCurrency(s.sales)) + '</span>'
        + '    <div class="bar-track"><div class="bar-fill" style="width:' + barPct + '%"></div></div>'
        + '  </div>'
        + '</td>'
        + '<td class="num">' + e(s.transactions) + '</td>'
        + '<td class="num">' + e('$' + s.avgOrderValue.toFixed(2)) + '</td>'
        + '<td class="num">' + e(s.avgUPT.toFixed(1)) + '</td>'
        + '<td>'
        + '  <span class="disc ' + e(discCls) + '">'
        + '    <span class="disc-bar"><span style="width:' + discW + '%"></span></span>'
        + e(GC.fmtPct(s.discountRate))
        + '  </span>'
        + '</td>'
        + '<td>'
        + '  <div class="sparkline-cell">'
        + '    <svg width="72" height="20" viewBox="0 0 72 20" style="overflow:visible">'
        + '      <polyline fill="none" stroke="' + e(trendStroke) + '" stroke-width="1.5" points="' + e(pts) + '"/>'
        + '    </svg>'
        + '    <span class="spark-delta ' + e(trendCls) + '">' + e(trendLabel) + '</span>'
        + '  </div>'
        + '</td>'
        + '<td class="actions-col">'
        + '  <button class="row-action-btn" title="More">⋯</button>'
        + '</td>'
        + '</tr>';
    }).join('');

    var tableHtml = '<table class="gc-table lb-table">'
      + '<thead><tr>'
      + '  <th style="width:60px">RANK</th>'
      + '  <th>STAFF</th>'
      + '  <th class="store-col">STORE</th>'
      + '  <th>SALES</th>'
      + '  <th>TXNS</th>'
      + '  <th>AOV</th>'
      + '  <th>UPT</th>'
      + '  <th>DISCOUNT</th>'
      + '  <th>TREND · 30D</th>'
      + '  <th class="actions-col"></th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>';

    return metaHtml + tableHtml;
  }

  // ── Render: Discount Watch panel ─────────────────────────
  function renderWatchPanel(alerts) {
    var watchList = (alerts && alerts.discountWatch) || [];
    if (!watchList.length) return '';

    var items = watchList.map(function(w) {
      var discCls = GC.discountSeverity(w.discountRate);
      var detail = w.ordersOver15Pct
        ? w.ordersOver15Pct + ' orders >15% off'
          + (w.topReason  ? ' · "' + w.topReason + '"' : '')
          + (w.reasonNote ? ' · ' + w.reasonNote       : '')
        : (w.detail || '');
      var storeName = w.storeName || w.store || '';
      return '<div class="watch-row">'
        + '<div class="user-chip" style="background:transparent;padding:0;border:none">'
        + '  <span class="uc-initials">' + e(w.initials || w.name.slice(0,2).toUpperCase()) + '</span>'
        + '  <div style="display:flex;flex-direction:column;gap:1px">'
        + '    <span style="font-weight:600;font-size:12px">' + e(w.name) + '</span>'
        + '    <span style="font-size:10px;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.8px">' + e(storeName) + '</span>'
        + '  </div>'
        + '</div>'
        + '<div class="watch-detail" style="margin-top:6px;font-size:11px;color:var(--text-mute)">' + e(detail) + '</div>'
        + '<span class="watch-pct disc ' + e(discCls) + '" style="margin-top:6px;display:inline-block">' + e(GC.fmtPct(w.discountRate)) + '</span>'
        + '</div>';
    }).join('');

    return '<div class="lb-watch-panel">'
      + '<div class="lb-watch-head">'
      + '  <h3>Discount Watch</h3>'
      + '  <span class="lb-watch-sub">Staff above the 6.5% chain benchmark · 14-day rolling</span>'
      + '</div>'
      + '<div class="lb-watch-grid">' + items + '</div>'
      + '</div>';
  }

  // ── Apply filters ────────────────────────────────────────
  function applyFilters(staff) {
    var result = staff.slice();

    if (_storeFilter !== 'all') {
      result = result.filter(function(s) { return s.storeSlug === _storeFilter; });
    }
    if (_tagFilter) {
      result = result.filter(function(s) { return (s.tags || []).indexOf(_tagFilter) !== -1; });
    }
    if (_roleFilter) {
      var rq = _roleFilter.toLowerCase();
      result = result.filter(function(s) { return (s.role || '').toLowerCase().indexOf(rq) !== -1; });
    }
    if (_search) {
      var q = _search.toLowerCase();
      result = result.filter(function(s) {
        return s.name.toLowerCase().indexOf(q) !== -1
          || (s.storeName || '').toLowerCase().indexOf(q) !== -1
          || (s.role || '').toLowerCase().indexOf(q) !== -1;
      });
    }

    result.sort(function(a, b) {
      var av = a[_sortKey] != null ? a[_sortKey] : 0;
      var bv = b[_sortKey] != null ? b[_sortKey] : 0;
      return _sortDir * (av - bv);
    });

    // Re-rank after filter
    result.forEach(function(s, i) { s._displayRank = i + 1; });

    return result;
  }

  // ── Normalize: directorall.staff → leaderboard shape ────────
  // directorall returns staff with totalActive / hoursWorked / roleLabel.
  // The table expects totalStaff / hours / role.
  function normalizeStaff(staffData, avatarConfigs) {
    if (!staffData) return { totalStaff: 0, showing: 0, staff: [] };
    avatarConfigs = avatarConfigs || {};
    var staff = (staffData.staff || []).map(function(s) {
      var nameKey = GC.nameToKey(s.name || '');
      return {
        rank:          s.rank          || 0,
        initials:      s.initials      || '',
        name:          s.name          || '',
        nameKey:       nameKey,
        avatarConfig:  avatarConfigs[nameKey] || null,
        role:          s.roleLabel     || s.role || '',
        hours:         s.hoursWorked   || s.hours || 0,
        storeSlug:     s.storeSlug     || '',
        storeName:     s.storeName     || '',
        sales:         s.sales         || 0,
        transactions:  s.transactions  || 0,
        avgOrderValue: s.avgOrderValue || 0,
        avgUPT:        s.avgUPT        || 0,
        discountRate:  s.discountRate  || 0,
        trendPct:      s.trendPct      || 0,
        trend30d:      s.trend30d      || [],
        tags:          s.tags          || [],
      };
    });
    return {
      totalStaff: staffData.totalActive || staffData.totalStaff || staff.length,
      showing:    staff.length,
      staff:      staff,
    };
  }

  // ── Full render ──────────────────────────────────────────
  function render(summary, alerts, lbData, period) {
    _summary = summary;
    _alerts  = alerts;
    _lbData  = lbData;
    _period  = period || 'mtd';

    var periodLabels = { today: 'Today', wtd: 'WTD', mtd: 'MTD', qtd: 'QTD', ytd: 'YTD' };
    var periodLabel  = periodLabels[_period] || _period.toUpperCase();

    return '<div class="lb-page">'
      + renderNav()
      + renderKPIs(summary)
      + renderFilters(_period)
      + '<div id="lbTableWrap">' + renderTable(lbData) + '</div>'
      + renderWatchPanel(alerts)
      + '<div class="lb-footer">Live data · All Stores · ' + e(periodLabel) + ' · '
      + '<span id="lbFooterRefresh">Last refresh ' + GC.fmtTime(new Date()) + '</span>'
      + '</div>'
      + '</div>';
  }

  // ── Re-render table only ─────────────────────────────────
  function refreshTable() {
    var wrap = document.getElementById('lbTableWrap');
    if (wrap && _lbData) wrap.innerHTML = renderTable(_lbData);
  }

  var _roleFilter = '';

  // ── init ─────────────────────────────────────────────────
  function init(period) {
    _period = period || 'mtd';

    // Refresh button — full reload via directorall
    var refreshBtn = document.getElementById('lbRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function() {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '↻ Refreshing…';
        GC.api.fetchDirectorAll(_period).then(function(data) {
          _lbData   = normalizeStaff(data.staff, data.avatarConfigs || {});
          _summary  = data.summary;
          _alerts   = data.alerts;
          refreshTable();
          refreshBtn.disabled = false;
          refreshBtn.textContent = '↻ Refresh';
          var el = document.getElementById('lbFooterRefresh');
          if (el) el.textContent = 'Last refresh ' + GC.fmtTime(new Date());
        }).catch(function() {
          refreshBtn.disabled = false;
          refreshBtn.textContent = '↻ Refresh';
        });
      });
    }

    // Period change — full page reload with new period
    var periodEl = document.getElementById('lbPeriod');
    if (periodEl) {
      periodEl.addEventListener('change', function() {
        GC.views.renderLeaderboard(periodEl.value);
      });
    }

    // Role filter
    var roleEl = document.getElementById('lbRole');
    if (roleEl) {
      roleEl.addEventListener('change', function() {
        _roleFilter = roleEl.value;
        refreshTable();
      });
    }

    // Store pills
    document.querySelectorAll('.store-pill, #lbAllStores').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.store-pill, #lbAllStores').forEach(function(b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        _storeFilter = btn.getAttribute('data-slug');
        refreshTable();
      });
    });

    // Tag pills
    document.querySelectorAll('.tag-pill').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tag = btn.getAttribute('data-tag');
        if (_tagFilter === tag) {
          _tagFilter = null;
          btn.classList.remove('active');
        } else {
          document.querySelectorAll('.tag-pill').forEach(function(b) { b.classList.remove('active'); });
          _tagFilter = tag;
          btn.classList.add('active');
        }
        refreshTable();
      });
    });

    // Search
    var searchEl = document.getElementById('lbSearch');
    if (searchEl) {
      searchEl.addEventListener('input', function() {
        _search = searchEl.value.trim();
        refreshTable();
      });
    }

    // Sort
    var sortEl = document.getElementById('lbSort');
    if (sortEl) {
      sortEl.addEventListener('change', function() {
        var parts = sortEl.value.split(',');
        _sortKey = parts[0];
        _sortDir = parseInt(parts[1], 10);
        refreshTable();
      });
    }
  }

  return { render: render, init: init, normalizeStaff: normalizeStaff };

})();
