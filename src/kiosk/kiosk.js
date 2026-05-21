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
    .then(function(data) {
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
  var _slug        = null;
  var _pollTimer   = null;
  var _tickerTimer = null;
  var _tickerPool  = [];
  var _clockTimer  = null;
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
    return '<header class="kiosk-header">'
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
    var pct     = today.pctToGoal || 0;
    var pctDisp = Math.round(pct * 100) + '%';
    // Arc total length for "M 20 120 A 90 90 0 0 1 200 120" ≈ 283
    var ARC_LEN = 283;

    return '<div class="goal-card">'
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
      + '    <div class="gp-small">to goal</div>'
      + '  </div>'
      + '</div>'
      + '<div class="goal-stats">'
      + '  <div class="goal-stat">'
      + '    <div class="gs-v num" id="kioskGoalSold" data-target="' + (today.revenue || 0) + '">' + fmtDollars(0) + '</div>'
      + '    <div class="gs-l">Sold</div>'
      + '  </div>'
      + '  <div class="goal-stat">'
      + '    <div class="gs-v num" id="kioskGoalToGo" data-target="' + (today.toGo || 0) + '">' + fmtDollars(0) + '</div>'
      + '    <div class="gs-l">To Go</div>'
      + '  </div>'
      + '  <div class="goal-stat">'
      + '    <div class="gs-v">' + e(today.timeRemainingLabel || '—') + '</div>'
      + '    <div class="gs-l">Left</div>'
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
  function renderStaffGrid(staff, storeName) {
    var maxSales = staff.length > 0 ? (staff[0].sales || 1) : 1;

    var cards = staff.map(function(s) {
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

      // Count-up target for employee amount
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

    return '<section class="lb-section">'
      + '<div class="lb-head">'
      + '  <h2>Today · ' + e(storeName || '') + ' Team</h2>'
      + '  <span class="lb-sep">/</span>'
      + '  <span class="lb-meta">Live · refreshes every 30 seconds</span>'
      + '</div>'
      + '<div class="lb-grid">' + cards + '</div>'
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
    var onShift      = storeData.onShift;
    var hourly       = storeData.hourly;
    var peakHour     = storeData.peakHour;
    var peakRevenue  = storeData.peakRevenue;
    var ticker       = storeData.ticker;
    var staff        = data.leaderboard.staff;
    var badges       = data.badges.badges;
    var leader       = staff[0] || {};

    return [
      '<canvas id="kioskConfetti"></canvas>',
      '<div id="kioskGoalBanner">🎯 DAILY GOAL HIT! · ' + e(store.name.toUpperCase()) + ' TEAM!</div>',
      '<div class="kiosk-wrap">',
        renderHeader(store),
        renderShiftStrip(onShift),
        '<div class="hero-grid">',
          renderLeaderCard(leader),
          renderGoalCard(today),
          renderPaceCard(today),
        '</div>',
        renderStaffGrid(staff, store.name),
        '<div class="lower-grid">',
          renderBadges(badges),
          renderHeatmap(hourly, peakHour, peakRevenue),
          renderTicker(ticker),
        '</div>',
        '<div class="kiosk-footer">Mock data · ' + e(store.name) + ' Store · '
          + '<span id="kioskRefresh">Last refresh ' + GC.fmtTime(new Date()) + '</span>'
          + '</div>',
      '</div>',
      renderRareDrop(),
    ].join('');
  }

  // ── init ──────────────────────────────────────────────
  function init(data, slug) {
    _slug = slug;

    // Store ticker pool for live simulation
    _tickerPool = (data.today.tickerPool || data.today.ticker || []);

    document.body.classList.add('kiosk-bg');

    startClock();
    runCountUps(data);
    animateGoalArc(data.today.today.pctToGoal);
    animatePaceNeedle(data.today.today.pace);
    animateBars();
    initTicker(data.today.ticker);
    initConfetti();
    startPolling(slug);

    // Welcome confetti on load
    setTimeout(fireConfetti, 800);

    // Demo: show a rare drop after 5s (remove in production)
    setTimeout(function() {
      var sample = _tickerPool[Math.floor(Math.random() * _tickerPool.length)] || {};
      showRareDrop(sample.firstName || 'Lina', sample.desc || 'Live resin concentrate kit', sample.amount || 420);
    }, 5000);
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
  function initTicker(initialItems) {
    clearInterval(_tickerTimer);
    _tickerTimer = setInterval(addTickerItem, 5000);
  }

  function fmtTickerTime(d) {
    var h  = d.getHours();
    var m  = d.getMinutes().toString().padStart(2, '0');
    var hh = ((h + 11) % 12) + 1;
    return hh + ':' + m + (h >= 12 ? 'p' : 'a');
  }

  function addTickerItem() {
    var feed = document.getElementById('kioskTickerFeed');
    if (!feed || !_tickerPool.length) return;

    var s    = _tickerPool[Math.floor(Math.random() * _tickerPool.length)];
    var item = document.createElement('div');
    item.className = 'ticker-item fresh';
    item.innerHTML = '<span class="t-time">' + GC.esc(fmtTickerTime(new Date())) + '</span>'
      + '<span class="t-who">'  + GC.esc(s.firstName) + '</span>'
      + '<span class="t-desc">' + GC.esc(s.desc) + '</span>'
      + '<span class="t-amt">'  + GC.esc(fmtDollars(s.amount)) + '</span>';

    feed.insertBefore(item, feed.firstChild);
    while (feed.children.length > 5) feed.removeChild(feed.lastChild);
    setTimeout(function() { item.classList.remove('fresh'); }, 1800);
  }

  // ── Polling ────────────────────────────────────────────
  function startPolling(slug) {
    clearInterval(_pollTimer);
    _pollTimer = setInterval(function() {
      GC.api.fetchKioskAll(slug).then(function(data) {
        // Soft-update key numbers without full re-render
        var soldEl = document.getElementById('kioskGoalSold');
        if (soldEl) countUp(soldEl, data.today.today.revenue || 0, 800);
        var refreshEl = document.getElementById('kioskRefresh');
        if (refreshEl) refreshEl.textContent = 'Last refresh ' + GC.fmtTime(new Date());
      });
    }, 30000);
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
    _hideRareDrop: _hideRareDrop,
  };

})();
