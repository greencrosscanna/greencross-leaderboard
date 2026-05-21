// ============================================================
//  Green Cross — Kiosk View
//  Renders /store/:slug — store-floor display
//  Gamified, kinetic, celebratory
//
//  Data flow:
//    GC.views.renderKiosk(slug)
//      → GC.api.fetchKioskAll(slug)
//      → kiosk.render(data, slug)   injects HTML into #app
//      → kiosk.init(data, slug)     wires animations + polling
// ============================================================

window.GC = window.GC || {};

GC.views.renderKiosk = function(slug) {
  var app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = kiosk.renderLoading(slug);

  GC.api.fetchKioskAll(slug)
    .then(function(rawData) {
      // Normalize GAS flat shape → fixture-compatible nested shape before any
      // render/init code touches it. Both shapes work after normalization.
      var data = kiosk.normalize(rawData);
      app.innerHTML = kiosk.render(data, slug);
      kiosk.init(data, slug);
    })
    .catch(function(err) {
      console.error('[kiosk] fetch failed:', err);
      app.innerHTML = '<div style="padding:40px;color:var(--text-dim)">Failed to load store data.</div>';
    });
};

// ── Private module ──────────────────────────────────────────
var kiosk = (function() {

  // ── State ──────────────────────────────────────────────
  var _slug         = null;
  var _storeName    = '';
  var _offShift     = [];    // roster employees not yet on shift today
  var _pollTimer    = null;
  var _lbTimer      = null;
  var _clockTimer   = null;
  var _lastTxnTs    = '';    // cursor for incremental ticker polling
  var _confettiParticles = [];
  var _confettiRunning   = false;

  // ── Helpers ────────────────────────────────────────────
  function e(s) { return GC.esc(String(s)); }

  function fmtDollars(n) {
    if (n === null || n === undefined) return '—';
    return '$' + Math.round(n).toLocaleString();
  }

  function fmtPace(pace) {
    var sign = pace >= 0 ? '+' : '−';
    return sign + Math.abs(Math.round(pace * 100)) + '%';
  }

  // ── Render: Loading ────────────────────────────────────
  function renderLoading(slug) {
    var name = slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Store';
    return '<div style="padding:60px;text-align:center;color:var(--text-dim)">'
      + '<div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">'
      + e(name) + ' · Loading…</div>'
      + '</div>';
  }

  // ── Render: Header ─────────────────────────────────────
  function renderHeader(store) {
    var sess = GC.auth.load() || {};
    var isDirector = sess.role === 'director' || sess.role === 'owner';
    var backBtn = isDirector
      ? '<button class="kiosk-back-btn" onclick="GC.router.navigate(\'#/director\')">← Director</button>'
      : '';
    return '<header class="kiosk-header">'
      + backBtn
      + '<div class="kiosk-logo"><span class="gc-green">GREEN</span>CROSS</div>'
      + '<span class="store-live-badge">' + e(store.name) + '</span>'
      + '<div class="kiosk-clock">'
      + '  <div class="kc-time num" id="kioskTime">—</div>'
      + '  <div class="kc-date" id="kioskDate">—</div>'
      + '</div>'
      + '</header>';
  }

  // ── Render: On-shift strip ─────────────────────────────
  function renderShiftStrip(onShift) {
    var people = (onShift || []).map(function(p) {
      var cls = p.status === 'on' ? '' : (' ' + e(p.status));
      var noteHtml = (p.status !== 'on' && p.note)
        ? e(p.role) + ' · ' + e(p.note)
        : e(p.role);
      return '<div class="shift-person' + cls + '">'
        + '  <div class="shift-ring">' + e(p.initials) + '</div>'
        + '  <div class="shift-meta">'
        + '    <span class="shift-name">' + e(p.name) + '</span>'
        + '    <span class="shift-role">' + noteHtml + '</span>'
        + '  </div>'
        + '</div>';
    }).join('');

    return '<div class="shift-strip">'
      + '<div class="shift-label">On shift now</div>'
      + '<div class="shift-avatars">' + people + '</div>'
      + '</div>';
  }

  // ── Render: Leader card ────────────────────────────────
  function renderLeaderCard(leader) {
    var streakHtml = '';
    if (leader.streak && leader.streakType === 'fire') {
      streakHtml = ' · <span class="leader-streak">🔥 ' + e(leader.streak) + '-day streak</span>';
    }
    var aovStr = leader.aov ? '$' + leader.aov.toFixed(2) : '—';
    var uptStr = leader.upt ? leader.upt.toFixed(1) : '—';

    return '<div class="leader-card">'
      + '<div class="kcard-label">Today\'s Leader</div>'
      + '<div class="leader-row">'
      + '  <div class="leader-avatar-xl">'
      + '    <span class="leader-crown">👑</span>'
      + e(leader.initials)
      + '  </div>'
      + '  <div>'
      + '    <div class="leader-name">' + e(leader.name.split(' ')[0]) + '</div>'
      + '    <div class="leader-role">' + e(leader.role) + '</div>'
      + '    <div class="leader-amount num" id="kioskLeaderAmt" data-target="' + (leader.sales || 0) + '">'
      + fmtDollars(0) + '</div>'
      + '    <div class="leader-sub">'
      + e(leader.txns) + ' txns · ' + e(aovStr) + ' AOV · ' + e(uptStr) + ' UPT'
      + streakHtml
      + '    </div>'
      + '  </div>'
      + '</div>'
      + '</div>';
  }

  // ── Render: Goal arc card ──────────────────────────────
  function renderGoalCard(today) {
    var pct      = today.pctToGoal || 0;
    var pctDisp  = Math.round(pct * 100) + '%';
    var closed   = today.timeRemainingLabel === 'Store closed';
    // Arc total length for "M 20 120 A 90 90 0 0 1 200 120" ≈ 283
    var ARC_LEN  = 283;

    return '<div class="goal-card' + (closed ? ' store-closed' : '') + '">'
      + '<div class="kcard-label">Daily Goal · ' + e(fmtDollars(today.goal)) + '</div>'
      + '<div class="gauge-wrap">'
      + '  <svg width="220" height="130" viewBox="0 0 220 130">'
      + '    <defs>'
      + '      <linearGradient id="goalGrad" x1="0" x2="1" y1="0" y2="0">'
      + '        <stop offset="0%" stop-color="#2f8a52"/>'
      + '        <stop offset="100%" stop-color="#4ade80"/>'
      + '      </linearGradient>'
      + '    </defs>'
      + '    <path d="M 20 120 A 90 90 0 0 1 200 120"'
      + '          stroke="#232a27" stroke-width="14" fill="none" stroke-linecap="round"/>'
      + '    <path id="kioskGoalArc"'
      + '          d="M 20 120 A 90 90 0 0 1 200 120"'
      + '          stroke="url(#goalGrad)" stroke-width="14" fill="none" stroke-linecap="round"'
      + '          stroke-dasharray="' + ARC_LEN + '"'
      + '          stroke-dashoffset="' + ARC_LEN + '"'
      + '          style="transition: stroke-dashoffset 1.6s cubic-bezier(.2,.7,.3,1)"/>'
      + '  </svg>'
      + '  <div class="gauge-pct">'
      + '    <div class="gp-big num" id="kioskGoalPct">0%</div>'
      + '    <div class="gp-small">' + (closed ? 'final' : 'to goal') + '</div>'
      + '  </div>'
      + '</div>'
      + '<div class="goal-stats">'
      + '  <div class="goal-stat">'
      + '    <div class="gs-v num" id="kioskGoalSold" data-target="' + (today.revenue || 0) + '">' + fmtDollars(0) + '</div>'
      + '    <div class="gs-l">Sold</div>'
      + '  </div>'
      + '  <div class="goal-stat">'
      + (closed
          ? '<div class="gs-v store-closed-label" id="kioskGoalToGo">Closed</div>'
          : '<div class="gs-v num" id="kioskGoalToGo" data-target="' + (today.toGo || 0) + '">' + fmtDollars(0) + '</div>')
      + '    <div class="gs-l" id="kioskToGoLabel">' + (closed ? '10 pm' : 'To Go') + '</div>'
      + '  </div>'
      + '  <div class="goal-stat">'
      + '    <div class="gs-v' + (closed ? ' store-closed-label' : '') + '" id="kioskTimeRemaining">' + e(today.timeRemainingLabel || '—') + '</div>'
      + '    <div class="gs-l">Status</div>'
      + '  </div>'
      + '</div>'
      + '</div>';
  }

  // ── Render: Pace dial card ─────────────────────────────
  function renderPaceCard(today) {
    var pace      = today.pace || 0;
    var direction = pace >= 0 ? 'ahead of plan' : 'behind plan';
    var deltaCls  = pace >= 0 ? 'up' : 'down';
    var paceDisp  = fmtPace(pace);
    var proj      = today.projectedRevenue || 0;
    var goal      = today.goal || 0;
    var overUnder = proj - goal;
    var ouSign    = overUnder >= 0 ? '▲ $' : '▼ −$';
    var ouStr     = ouSign + Math.abs(overUnder).toLocaleString() + (overUnder >= 0 ? ' over goal' : ' under goal');
    var ouColor   = overUnder >= 0 ? 'var(--green)' : 'var(--red)';

    return '<div class="pace-card">'
      + '<div class="kcard-label">Pace · vs. Plan</div>'
      + '<svg class="pace-svg" viewBox="0 0 220 130">'
      + '  <!-- zone arcs -->'
      + '  <path d="M 20 120 A 90 90 0 0 1 73 41"  stroke="#ef4444" stroke-width="12" fill="none" stroke-linecap="round" opacity="0.55"/>'
      + '  <path d="M 73 41 A 90 90 0 0 1 147 41"  stroke="#eab308" stroke-width="12" fill="none" stroke-linecap="round" opacity="0.55"/>'
      + '  <path d="M 147 41 A 90 90 0 0 1 200 120" stroke="#4ade80" stroke-width="12" fill="none" stroke-linecap="round" opacity="0.55"/>'
      + '  <!-- tick marks -->'
      + '  <g stroke="#5e6864" stroke-width="1">'
      + '    <line x1="20" y1="120" x2="28" y2="116"/>'
      + '    <line x1="200" y1="120" x2="192" y2="116"/>'
      + '    <line x1="110" y1="30" x2="110" y2="40"/>'
      + '  </g>'
      + '  <text x="20"  y="135" fill="#5e6864" font-size="9" text-anchor="start">−20%</text>'
      + '  <text x="200" y="135" fill="#5e6864" font-size="9" text-anchor="end">+20%</text>'
      + '  <text x="110" y="25"  fill="#5e6864" font-size="9" text-anchor="middle">PLAN</text>'
      + '  <!-- needle -->'
      + '  <g id="kioskPaceNeedle" style="transform-origin:110px 120px;transform:rotate(-90deg);transition:transform 1.4s cubic-bezier(.2,.7,.3,1)">'
      + '    <line x1="110" y1="120" x2="110" y2="42" stroke="#e6ece9" stroke-width="2.5" stroke-linecap="round"/>'
      + '    <circle cx="110" cy="120" r="6" fill="#e6ece9" stroke="#0a0e0d" stroke-width="2"/>'
      + '  </g>'
      + '</svg>'
      + '<div class="pace-readout">'
      + '  <div class="pr-delta ' + deltaCls + '">' + e(paceDisp) + '</div>'
      + '  <div class="pr-label">' + e(direction) + '</div>'
      + '</div>'
      + '<div class="pace-projection">'
      + '  Projected close: <span class="pp-v num">' + e(fmtDollars(proj)) + '</span>'
      + '  · <span style="color:' + ouColor + '">' + ouStr + '</span>'
      + '</div>'
      + '</div>';
  }

  // ── Render: Staff leaderboard grid ────────────────────
  // offShift: array of { initials, name, role } for roster employees
  //           not yet active today — rendered as dimmed ghost cards
  function renderStaffGrid(staff, storeName, offShift) {
    var maxSales = staff.length > 0 ? (staff[0].sales || 1) : 1;

    var activeCards = staff.map(function(s) {
      var isLeading = s.rank === 1;
      var barPct    = maxSales > 0 ? Math.round((s.sales / maxSales) * 100) : 0;
      var aovStr    = s.aov  ? '$' + s.aov.toFixed(2) : '—';
      var uptStr    = s.upt  ? s.upt.toFixed(1)        : '—';

      var extraHtml = '';
      if (s.streakType === 'fire' && s.streak > 0) {
        extraHtml = '<div class="emp-extra streak">🔥 ' + e(s.streak) + '-day streak</div>';
      } else if (s.personalBestPct !== null && s.personalBestPct >= 0.90) {
        extraHtml = '<div class="emp-extra pb">⚡ Personal best in sight</div>';
      } else if (s.note) {
        extraHtml = '<div class="emp-extra muted">' + e(s.note) + '</div>';
      } else if (s.streak > 0) {
        extraHtml = '<div class="emp-extra muted">' + e(s.streak) + '-day streak</div>';
      }

      var amtId = 'kioskEmpAmt' + s.rank;

      return '<div class="emp-card' + (isLeading ? ' leading' : '') + '">'
        + '<span class="emp-rank">#' + e(s.rank) + '</span>'
        + '<div class="emp-head">'
        + '  <div class="emp-av">' + e(s.initials) + '</div>'
        + '  <div><div class="emp-n">' + e(s.name.split(' ')[0]) + '</div>'
        + '  <div class="emp-r">' + e(s.role) + '</div></div>'
        + '</div>'
        + '<div class="emp-amt num" id="' + amtId + '" data-target="' + (s.sales || 0) + '">'
        + fmtDollars(0)
        + '</div>'
        + '<div class="emp-bar"><span style="width:0%" data-final="' + barPct + '%"></span></div>'
        + '<div class="emp-stats"><span>AOV <b>' + e(aovStr) + '</b></span><span>UPT <b>' + e(uptStr) + '</b></span></div>'
        + extraHtml
        + '</div>';
    }).join('');

    // Off-shift ghost cards — dimmed, no sales data
    var ghostCards = (offShift || []).map(function(p) {
      return '<div class="emp-card off-shift">'
        + '<div class="emp-head">'
        + '  <div class="emp-av">' + e(p.initials) + '</div>'
        + '  <div><div class="emp-n">' + e(p.name.split(' ')[0]) + '</div>'
        + '  <div class="emp-r">' + e(p.role || '') + '</div></div>'
        + '</div>'
        + '<div class="emp-amt off-shift-label">Off shift</div>'
        + '</div>';
    }).join('');

    return '<section class="lb-section">'
      + '<div class="lb-head">'
      + '  <h2>Today · ' + e(storeName || '') + ' Team</h2>'
      + '  <span class="lb-sep">/</span>'
      + '  <span class="lb-meta">Live · refreshes every 30 seconds</span>'
      + '</div>'
      + '<div class="lb-grid">' + activeCards + ghostCards + '</div>'
      + '</section>';
  }

  // ── Render: Weekly badges ──────────────────────────────
  function renderBadges(badges) {
    var items = (badges || []).map(function(b) {
      return '<div class="badge-item ' + e(b.type) + '">'
        + '<div class="badge-icon">' + b.icon + '</div>'
        + '<div>'
        + '  <div class="badge-title">' + e(b.title) + '</div>'
        + '  <div class="badge-holder">' + e(b.holder) + '</div>'
        + '</div>'
        + '<div class="badge-stat">' + e(b.stat) + '</div>'
        + '</div>';
    }).join('');

    return '<div class="kiosk-card">'
      + '<div class="kcard-label">This Week\'s Trophies</div>'
      + '<div class="badges-grid">' + items + '</div>'
      + '</div>';
  }

  // ── Render: Hourly heatmap ─────────────────────────────
  function renderHeatmap(hourly, peakHour, peakRevenue) {
    // Color interpolation: 0% → #1a2c21, 100% → #4ade80
    function pctColor(pct, projected) {
      if (projected) return '#232a27';
      var t = pct / 100;
      var r = Math.round(26  + t * (74  - 26));
      var g = Math.round(44  + t * (222 - 44));
      var b = Math.round(33  + t * (128 - 33));
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    var bars = (hourly || []).map(function(h) {
      var cls = '';
      if (h.current)   cls = ' now';
      if (h.projected) cls = ' projected';
      var color = pctColor(h.pct || 0, h.projected);
      return '<div class="hm-bar' + cls + '" style="height:' + (h.pct || 0) + '%;background:' + color + '">'
        + '<span class="hm-hour">' + e(h.hour) + '</span>'
        + '</div>';
    }).join('');

    var peakStr = peakHour
      ? 'Peak · ' + e(peakHour) + ' · ' + e(fmtDollars(peakRevenue || 0))
      : '';

    return '<div class="kiosk-card">'
      + '<div class="kcard-label">Today by Hour</div>'
      + '<div class="heatmap">' + bars + '</div>'
      + '<div class="hm-legend">'
      + '  <span>Open</span>'
      + '  <span class="hm-peak">' + e(peakStr) + '</span>'
      + '  <span>Close</span>'
      + '</div>'
      + '</div>';
  }

  // ── Render: Live ticker ────────────────────────────────
  function renderTicker(items) {
    var rows = (items || []).map(function(t) {
      return '<div class="ticker-item">'
        + '<span class="t-time">' + e(t.time) + '</span>'
        + '<span class="t-who">'  + e(t.firstName) + '</span>'
        + '<span class="t-desc">' + e(t.desc) + '</span>'
        + '<span class="t-amt">'  + e(fmtDollars(t.amount)) + '</span>'
        + '</div>';
    }).join('');

    return '<div class="kiosk-card ticker-card">'
      + '<div class="ticker-header">'
      + '  <div class="kcard-label" style="margin-bottom:0">Live Sales</div>'
      + '  <span class="ticker-live">Live</span>'
      + '</div>'
      + '<div class="ticker-feed" id="kioskTickerFeed">' + rows + '</div>'
      + '</div>';
  }

  // ── Closing push helpers ───────────────────────────────

  /** Returns minutes left until store close (10pm PT), using client-side PT time. */
  function getMinutesLeftPT_() {
    try {
      var parts = {};
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hour12: false
      }).formatToParts(new Date()).forEach(function(p) { parts[p.type] = parseInt(p.value, 10) || 0; });
      return 22 * 60 - (parts.hour * 60 + parts.minute);
    } catch(err) {
      return 999;
    }
  }

  // ── Render: Closing push banner ────────────────────────
  function renderClosingBanner() {
    return '<div id="kioskClosingPush" class="closing-push" style="display:none">'
      + '<div class="cp-icon">⏳</div>'
      + '<div class="cp-body">'
      + '  <div class="cp-headline">CLOSING PUSH &nbsp;·&nbsp; <span id="cpTimeLeft">—</span></div>'
      + '  <div class="cp-detail">'
      + '    Need <span class="cp-need num" id="cpNeed">—</span> to hit today\'s goal'
      + '    <span class="cp-txns"> · ≈<span id="cpTxns">—</span> more sales at <span id="cpAov">—</span> avg</span>'
      + '  </div>'
      + '</div>'
      + '</div>';
  }

  /** Show/hide/update the closing push banner based on current time + remaining goal. */
  function updateClosingBanner(td) {
    var banner = document.getElementById('kioskClosingPush');
    if (!banner) return;

    var toGo  = td.toGo           || 0;
    var aov   = td.avgOrderValue  || 0;
    var mins  = getMinutesLeftPT_();

    // Show when store is open, ≤ 2h left, and goal not yet hit
    var show = mins > 0 && mins <= 120 && toGo > 0;
    banner.style.display = show ? 'flex' : 'none';
    if (!show) return;

    var h      = Math.floor(mins / 60);
    var m      = mins % 60;
    var tStr   = h > 0
      ? h + 'h ' + (m > 0 ? m + 'm' : '') + ' left'
      : m + ' min left';

    var txns   = aov > 0 ? Math.ceil(toGo / aov) : null;
    var aovStr = aov > 0 ? ('$' + Math.round(aov).toLocaleString()) : null;

    var timeEl = document.getElementById('cpTimeLeft');
    var needEl = document.getElementById('cpNeed');
    var txnsEl = document.getElementById('cpTxns');
    var aovEl  = document.getElementById('cpAov');
    var txnsWrap = banner.querySelector('.cp-txns');

    if (timeEl) timeEl.textContent = tStr;
    if (needEl) needEl.textContent = '$' + Math.round(toGo).toLocaleString();
    if (txns !== null) {
      if (txnsEl) txnsEl.textContent = txns;
      if (aovEl)  aovEl.textContent  = aovStr;
      if (txnsWrap) txnsWrap.style.display = '';
    } else {
      if (txnsWrap) txnsWrap.style.display = 'none';
    }
  }

  // ── Render: Rare drop overlay ──────────────────────────
  function renderRareDrop() {
    return '<div id="kioskRareDrop" onclick="kiosk._hideRareDrop(event)">'
      + '  <div class="raredrop-box" onclick="event.stopPropagation()">'
      + '    <div class="rd-gem">💎</div>'
      + '    <div class="rd-kicker">Rare Drop</div>'
      + '    <div class="rd-who" id="rdWho"></div>'
      + '    <div class="rd-item" id="rdItem"></div>'
      + '    <div class="rd-price num" id="rdPrice"></div>'
      + '    <button class="rd-close" onclick="kiosk._hideRareDrop()">Nice 🔥</button>'
      + '  </div>'
      + '</div>';
  }

  // ── Full render ────────────────────────────────────────
  function render(data, slug) {
    var storeData    = data.today;
    var store        = storeData.store;
    var today        = storeData.today;
    var onShift      = storeData.onShift || [];
    var hourly       = storeData.hourly;
    var peakHour     = storeData.peakHour;
    var peakRevenue  = storeData.peakRevenue;
    var ticker       = storeData.ticker;
    var staff        = data.leaderboard.staff;
    var badges       = data.badges.badges;
    var leader       = staff[0] || {};
    // Employees in roster but not yet active today → ghost cards
    var offShift     = onShift.filter(function(p) { return p.status !== 'on'; });

    return [
      '<canvas id="kioskConfetti"></canvas>',
      '<div id="kioskGoalBanner">🎯 DAILY GOAL HIT! · ' + e(store.name.toUpperCase()) + ' TEAM!</div>',
      '<div class="kiosk-wrap">',
        renderHeader(store),
        '<div class="hero-grid">',
          renderLeaderCard(leader),
          renderGoalCard(today),
          renderPaceCard(today),
        '</div>',
        renderClosingBanner(),
        renderStaffGrid(staff, store.name, offShift),
        '<div class="lower-grid">',
          renderBadges(badges),
          renderHeatmap(hourly, peakHour, peakRevenue),
          renderTicker(ticker),
        '</div>',
        '<div class="kiosk-footer">Live data · ' + e(store.name) + ' Store · '
          + '<span id="kioskRefresh">Last refresh ' + GC.fmtTime(new Date()) + '</span>'
          + '</div>',
      '</div>',
      renderRareDrop(),
    ].join('');
  }

  // ── init ──────────────────────────────────────────────
  function init(data, slug) {
    _slug      = slug;
    _storeName = (data.today.store && data.today.store.name) || slug || '';

    // Roster employees not active yet today (used in staff grid and 5-min refresh)
    _offShift = (data.today.onShift || []).filter(function(p) { return p.status !== 'on'; });

    // Seed ticker cursor from the most recent transaction timestamp
    _lastTxnTs = data.today.latestTxnTs || '';

    document.body.classList.add('kiosk-bg');

    startClock();
    runCountUps(data);
    animateGoalArc(data.today.today.pctToGoal);
    animatePaceNeedle(data.today.today.pace);
    animateBars();
    updateClosingBanner(data.today.today);
    initConfetti();
    startPolling(slug);

    // Confetti only if goal is already hit on load
    if ((data.today.today.pctToGoal || 0) >= GC.THRESHOLDS.goalCelebrationAt) {
      setTimeout(fireConfetti, 800);
    }
  }

  // ── Clock ──────────────────────────────────────────────
  function startClock() {
    function tick() {
      var now  = new Date();
      var el   = document.getElementById('kioskTime');
      var elD  = document.getElementById('kioskDate');
      if (el)  el.textContent  = GC.fmtTime(now);
      if (elD) elD.textContent = GC.fmtDateShort(now).toUpperCase();
    }
    tick();
    clearInterval(_clockTimer);
    _clockTimer = setInterval(tick, 1000);
  }

  // ── Count-up animation ─────────────────────────────────
  function countUp(el, target, duration) {
    duration = duration || 1400;
    var start = performance.now();
    function frame(now) {
      var t      = Math.min(1, (now - start) / duration);
      var eased  = 1 - Math.pow(1 - t, 3);
      var val    = Math.round(target * eased);
      el.textContent = '$' + val.toLocaleString();
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function runCountUps(data) {
    // Leader amount
    var leaderEl = document.getElementById('kioskLeaderAmt');
    if (leaderEl) {
      var target = parseInt(leaderEl.getAttribute('data-target'), 10) || 0;
      countUp(leaderEl, target);
    }

    // Goal stats
    var soldEl  = document.getElementById('kioskGoalSold');
    var toGoEl  = document.getElementById('kioskGoalToGo');
    if (soldEl) countUp(soldEl, parseInt(soldEl.getAttribute('data-target'), 10) || 0);
    if (toGoEl) countUp(toGoEl, parseInt(toGoEl.getAttribute('data-target'), 10) || 0);

    // Employee amounts
    var staff = data.leaderboard.staff || [];
    staff.forEach(function(s) {
      var el = document.getElementById('kioskEmpAmt' + s.rank);
      if (el) countUp(el, s.sales || 0, 1200);
    });

    // Goal percentage counter
    var pctEl = document.getElementById('kioskGoalPct');
    if (pctEl) {
      var pctTarget = Math.round((data.today.today.pctToGoal || 0) * 100);
      var pctStart  = performance.now();
      var pctDur    = 1600;
      (function animPct(now) {
        var t     = Math.min(1, (now - pctStart) / pctDur);
        var eased = 1 - Math.pow(1 - t, 3);
        pctEl.textContent = Math.round(pctTarget * eased) + '%';
        if (t < 1) requestAnimationFrame(animPct);
      })(pctStart);
    }
  }

  // ── Goal arc ───────────────────────────────────────────
  function animateGoalArc(pct) {
    var ARC_LEN = 283;
    setTimeout(function() {
      var arc = document.getElementById('kioskGoalArc');
      if (arc) arc.setAttribute('stroke-dashoffset', String(Math.round(ARC_LEN * (1 - (pct || 0)))));
    }, 250);
  }

  // ── Pace needle ────────────────────────────────────────
  function animatePaceNeedle(pace) {
    // Gauge: -90deg (far left = -20%) to +90deg (far right = +20%)
    // Starting transform: rotate(-90deg) = needle pointing left
    // We OVERRIDE that with the actual pace:
    //   deg = (pace / 0.20) * 90, clamped to [-90, 90]
    setTimeout(function() {
      var needle = document.getElementById('kioskPaceNeedle');
      if (!needle) return;
      var clamped = Math.max(-0.20, Math.min(0.20, pace || 0));
      var deg = Math.round((clamped / 0.20) * 90);
      needle.style.transform = 'rotate(' + deg + 'deg)';
    }, 350);
  }

  // ── Animate employee bars ──────────────────────────────
  function animateBars() {
    setTimeout(function() {
      document.querySelectorAll('.emp-bar span[data-final]').forEach(function(span) {
        span.style.width = span.getAttribute('data-final');
      });
    }, 400);
  }

  // ── Live ticker ────────────────────────────────────────

  /** Format a local-time string "2026-05-20T14:32:00" → "2:32p" */
  function fmtTxnTime(ts) {
    // Parse directly from string chars to avoid UTC-offset issues
    var h  = ts && ts.length >= 13 ? parseInt(ts.slice(11, 13), 10) : new Date().getHours();
    var mn = ts && ts.length >= 16 ? parseInt(ts.slice(14, 16), 10) : new Date().getMinutes();
    var hh = ((h + 11) % 12) + 1;
    return hh + ':' + mn.toString().padStart(2, '0') + (h >= 12 ? 'p' : 'a');
  }

  /**
   * Inject real new transactions from a delta poll response into the ticker feed.
   * items: array of { who, item, price, ts } (GAS delta format)
   */
  function injectTickerItems(items) {
    var feed = document.getElementById('kioskTickerFeed');
    if (!feed || !items || !items.length) return;

    items.forEach(function(t) {
      var el = document.createElement('div');
      el.className = 'ticker-item fresh';
      el.innerHTML = '<span class="t-time">' + GC.esc(fmtTxnTime(t.ts)) + '</span>'
        + '<span class="t-who">'  + GC.esc(t.who  || '') + '</span>'
        + '<span class="t-desc">' + GC.esc(t.item || '') + '</span>'
        + '<span class="t-amt">'  + GC.esc(fmtDollars(t.price || 0)) + '</span>';
      feed.insertBefore(el, feed.firstChild);
      setTimeout(function() { el.classList.remove('fresh'); }, 1800);

      // Trigger rare-drop overlay for high-value transactions
      if ((t.price || 0) >= GC.THRESHOLDS.rareDropMinTransaction) {
        showRareDrop(t.who || '', t.item || '', t.price || 0);
      }
    });

    // Keep feed trimmed to 8 rows
    while (feed.children.length > 8) feed.removeChild(feed.lastChild);
  }

  // ── Data normalizer ────────────────────────────────────────────
  // Converts GAS flat shape OR fixture nested shape into the canonical
  // nested shape that render / init / runCountUps expect.
  //
  // GAS flat today: { storeSlug, storeName, goal, revenue, pctToGoal, pace,
  //                   projectedRevenue, toGo, timeRemainingLabel,
  //                   onShift, hourly, ticker:[{who,item,price,ts}] }
  // Fixture today:  { store:{id,name,slug}, today:{goal,revenue,pctToGoal,...},
  //                   onShift, hourly, ticker:[{time,firstName,desc,amount}] }
  //
  // Staff: GAS uses avgOrderValue/transactions/streakDays
  //        Fixture uses aov/txns/streak + streakType
  // Badges: GAS uses label/winner/detail; fixture uses title/holder/stat
  function normalizeKioskData_(rawData) {
    var td = rawData.today       || {};
    var lb = rawData.leaderboard || {};
    var bg = rawData.badges      || {};

    // ── today block ──
    var normalizedToday;
    if (td.store && td.today) {
      // Fixture shape — pass through with onShift roles defaulted
      normalizedToday = Object.assign({}, td, {
        onShift: (td.onShift || []).map(function(p) {
          return Object.assign({ role: '', note: null }, p);
        }),
      });
    } else {
      // GAS flat shape → convert to fixture-compatible nested shape
      normalizedToday = {
        store: {
          id:   td.storeSlug || '',
          name: td.storeName || td.storeSlug || '',
          slug: td.storeSlug || '',
        },
        today: {
          goal:               td.goal               || 0,
          revenue:            td.revenue             || 0,
          transactions:       td.transactions        || 0,
          avgOrderValue:      td.avgOrderValue       || 0,
          pctToGoal:          td.pctToGoal           || 0,
          pace:               td.pace                || 0,
          projectedRevenue:   td.projectedRevenue    || 0,
          toGo:               td.toGo                || 0,
          timeRemainingLabel: td.timeRemainingLabel  || '',
        },
        onShift: (td.onShift || []).map(function(p) {
          return {
            initials: p.initials || '',
            name:     p.name     || '',
            role:     p.role     || '',
            status:   p.status   || 'on',
            note:     p.note     || null,
          };
        }),
        hourly:       td.hourly       || [],
        peakHour:     td.peakHour     || null,
        peakRevenue:  td.peakRevenue  || 0,
        latestTxnTs:  td.latestTxnTs  || '',
        // GAS ticker: {who,item,price,ts} → {time,firstName,desc,amount}
        ticker: (td.ticker || []).map(function(t) {
          if (t.firstName !== undefined) return t; // already normalized
          // Parse time directly from local ISO string to avoid UTC offset
          var ts = t.ts || '';
          var h  = ts.length >= 13 ? parseInt(ts.slice(11, 13), 10) : new Date().getHours();
          var mn = ts.length >= 16 ? parseInt(ts.slice(14, 16), 10) : new Date().getMinutes();
          var hh = ((h + 11) % 12) + 1;
          return {
            time:      hh + ':' + mn.toString().padStart(2, '0') + (h >= 12 ? 'p' : 'a'),
            firstName: t.who  || '',
            desc:      t.item || '',
            amount:    t.price || 0,
          };
        }),
      };
    }

    // ── staff ──
    // GAS: avgOrderValue, avgUPT, transactions, streakDays (no role, no streakType)
    // Fixture: aov, txns, streak, streakType, role, upt
    var normalizedStaff = (lb.staff || []).map(function(s) {
      var streak = s.streak != null ? s.streak : (s.streakDays || 0);
      return {
        rank:            s.rank           || 0,
        initials:        s.initials       || '',
        name:            s.name           || '',
        role:            s.role           || s.roleLabel || '',
        sales:           s.sales          || 0,
        txns:            s.txns  != null  ? s.txns  : (s.transactions || 0),
        aov:             s.aov   != null  ? s.aov   : (s.avgOrderValue || 0),
        upt:             s.upt   != null  ? s.upt   : (s.avgUPT        || 0),
        streak:          streak,
        streakType:      s.streakType     || (streak > 2 ? 'fire' : ''),
        personalBestPct: s.personalBestPct || null,
        note:            s.note           || null,
      };
    });

    // ── badges ──
    // GAS: label, winner, detail, type='gold'/'silver', id='aov-avenger' etc.
    // Fixture: title, holder, stat, type='b-aov' etc.
    // Map GAS id → CSS class + emoji icon.
    // Icons are hardcoded here (not trusted from GAS) because emoji come
    // through JSONP with encoding corruption on some GAS deployments.
    var BADGE_TYPE_MAP = {
      'aov-avenger': 'b-aov',
      'upsell-king': 'b-upt',
      'cleanest':    'b-clean',
      'top-sales':   'b-streak',
      'the-closer':  'b-close',
      'streak':      'b-streak',
      'new-hire':    'b-new',
    };
    var BADGE_ICON_MAP = {
      'aov-avenger': '💰',  // 💰
      'upsell-king': '👑',  // 👑
      'cleanest':    '🧼',  // 🧼
      'top-sales':   '🔥',  // 🔥
      'the-closer':  '🤝',  // 🤝
      'streak':      '⚡',        // ⚡
      'new-hire':    '🌱',  // 🌱
    };
    var normalizedBadges = (bg.badges || []).map(function(b) {
      return {
        id:     b.id     || '',
        icon:   BADGE_ICON_MAP[b.id] || b.icon || '',
        title:  b.label  || b.title  || '',
        holder: b.winner || b.holder || '',
        stat:   b.detail || b.stat   || '',
        type:   BADGE_TYPE_MAP[b.id] || b.type || '',
      };
    });

    return {
      today:       normalizedToday,
      leaderboard: { staff: normalizedStaff },
      badges:      { badges: normalizedBadges },
    };
  }

  // ── Polling ────────────────────────────────────────────

  /** Soft-update the goal/pace numbers on screen without re-rendering */
  function updateNumbers(td) {
    var revenue   = td.revenue   || 0;
    var pctToGoal = td.pctToGoal || 0;
    var toGo      = td.toGo      || 0;
    var label     = td.timeRemainingLabel || '';
    var closed    = label === 'Store closed';

    var soldEl = document.getElementById('kioskGoalSold');
    if (soldEl) countUp(soldEl, revenue, 800);

    // To-Go slot: animates normally while open; shows "Closed" text after 10 pm
    var toGoEl = document.getElementById('kioskGoalToGo');
    if (toGoEl) {
      if (closed) {
        toGoEl.classList.add('store-closed-label');
        toGoEl.classList.remove('num');
        toGoEl.textContent = 'Closed';
      } else {
        toGoEl.classList.remove('store-closed-label');
        toGoEl.classList.add('num');
        countUp(toGoEl, toGo, 800);
      }
    }
    var toGoLblEl = document.getElementById('kioskToGoLabel');
    if (toGoLblEl) toGoLblEl.textContent = closed ? '10 pm' : 'To Go';

    var pctEl = document.getElementById('kioskGoalPct');
    if (pctEl) pctEl.textContent = Math.round(pctToGoal * 100) + '%';

    // sub-label under the arc: "to goal" while open, "final" after close
    var subEl = pctEl && pctEl.nextElementSibling;
    if (subEl && subEl.classList.contains('gp-small')) {
      subEl.textContent = closed ? 'final' : 'to goal';
    }

    var arc = document.getElementById('kioskGoalArc');
    if (arc) arc.setAttribute('stroke-dashoffset', String(Math.round(283 * (1 - pctToGoal))));

    // Dim the card when store is closed
    var card = arc && arc.closest('.goal-card');
    if (card) card.classList.toggle('store-closed', closed);

    // Update the status label
    var lblEl = document.getElementById('kioskTimeRemaining');
    if (lblEl) {
      lblEl.textContent = label || '—';
      lblEl.classList.toggle('store-closed-label', closed);
    }

    var needle = document.getElementById('kioskPaceNeedle');
    if (needle && td.pace != null) {
      var clamped = Math.max(-0.20, Math.min(0.20, td.pace));
      needle.style.transform = 'rotate(' + Math.round((clamped / 0.20) * 90) + 'deg)';
    }

    // Closing push
    updateClosingBanner(td);
  }

  function startPolling(slug) {
    clearInterval(_pollTimer);
    clearInterval(_lbTimer);

    // ── 30-second ticker poll ────────────────────────────
    // Sends sinceTs cursor → GAS returns only NEW transactions + updated totals.
    // On first poll (or fixture mode) falls back to full response handling.
    _pollTimer = setInterval(function() {
      GC.api.fetchStoreToday(slug, { sinceTs: _lastTxnTs })
        .then(function(resp) {
          if (resp.isUpdate) {
            // Delta response: inject new ticker items + update numbers
            if (resp.newTicker && resp.newTicker.length) {
              injectTickerItems(resp.newTicker);
            }
            updateNumbers(resp);
            if (resp.latestTxnTs) _lastTxnTs = resp.latestTxnTs;
          } else {
            // Full response (fixture mode or first ever poll without sinceTs)
            var data = normalizeKioskData_({
              today:       resp,
              leaderboard: { staff: [] },
              badges:      { badges: [] },
            });
            updateNumbers(data.today.today);
            if (resp.latestTxnTs) _lastTxnTs = resp.latestTxnTs;
          }
          var refreshEl = document.getElementById('kioskRefresh');
          if (refreshEl) refreshEl.textContent = 'Last refresh ' + GC.fmtTime(new Date());
        })
        .catch(function(err) {
          console.warn('[kiosk] ticker poll failed:', err);
        });
    }, 30000);

    // ── 5-minute leaderboard refresh ────────────────────
    _lbTimer = setInterval(function() {
      GC.api.fetchStoreLeaderboard(slug)
        .then(function(lb) {
          var data = normalizeKioskData_({
            today:       {},
            leaderboard: lb,
            badges:      { badges: [] },
          });
          var staff   = data.leaderboard.staff;
          var section = document.querySelector('.lb-section');
          if (section) {
            section.outerHTML = renderStaffGrid(staff, _storeName, _offShift);
            animateBars();
            // Animate employee amounts
            staff.forEach(function(s) {
              var el = document.getElementById('kioskEmpAmt' + s.rank);
              if (el) countUp(el, s.sales || 0, 1000);
            });
          }
        })
        .catch(function(err) {
          console.warn('[kiosk] leaderboard refresh failed:', err);
        });
    }, 5 * 60 * 1000);
  }

  // ── Rare drop ──────────────────────────────────────────
  function showRareDrop(who, item, price) {
    var el = document.getElementById('kioskRareDrop');
    if (!el) return;
    document.getElementById('rdWho').textContent   = who  || '';
    document.getElementById('rdItem').textContent  = item || '';
    document.getElementById('rdPrice').textContent = fmtDollars(price || 0);
    el.classList.add('show');
    fireConfetti();
  }

  function _hideRareDrop(evt) {
    var el = document.getElementById('kioskRareDrop');
    if (el) el.classList.remove('show');
  }

  // ── Confetti ───────────────────────────────────────────
  var CONFETTI_COLORS = ['#4ade80','#60a5fa','#facc15','#f472b6','#a78bfa','#f97316'];

  function initConfetti() {
    var cv = document.getElementById('kioskConfetti');
    if (!cv) return;
    function resize() { cv.width = window.innerWidth; cv.height = window.innerHeight; }
    window.addEventListener('resize', resize);
    resize();
    if (!_confettiRunning) {
      _confettiRunning = true;
      requestAnimationFrame(confettiTick);
    }
  }

  function fireConfetti() {
    var cv = document.getElementById('kioskConfetti');
    if (!cv) return;
    var cx = window.innerWidth  / 2;
    var cy = window.innerHeight * 0.42;
    for (var i = 0; i < 140; i++) {
      _confettiParticles.push({
        x: cx + (Math.random() - 0.5) * 60,
        y: cy,
        vx: (Math.random() - 0.5) * 9,
        vy: -Math.random() * 11 - 4,
        size: Math.random() * 6 + 3,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 0.3,
        life: 0,
        maxLife: 140 + Math.random() * 80,
      });
    }
    // Also show goal banner
    var banner = document.getElementById('kioskGoalBanner');
    if (banner) {
      banner.classList.add('show');
      setTimeout(function() { banner.classList.remove('show'); }, 2600);
    }
  }

  function confettiTick() {
    var cv = document.getElementById('kioskConfetti');
    if (!cv) { _confettiRunning = false; return; }
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    _confettiParticles = _confettiParticles.filter(function(p) { return p.life < p.maxLife; });
    _confettiParticles.forEach(function(p) {
      p.vy  += 0.22;
      p.vx  *= 0.995;
      p.x   += p.vx;
      p.y   += p.vy;
      p.rot += p.vrot;
      p.life++;
      var alpha = 1 - (p.life / p.maxLife);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    });
    requestAnimationFrame(confettiTick);
  }

  // Public API (exposed for onclick handlers)
  return {
    render:        render,
    renderLoading: renderLoading,
    init:          init,
    normalize:     normalizeKioskData_,
    _hideRareDrop: _hideRareDrop,
  };

})();
