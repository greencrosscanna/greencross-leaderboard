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
  var _onShift      = [];    // full roster array (all statuses) — used by lb refresh
  var _badges       = [];    // current week's badges — used by lb refresh
  var _goal         = 0;     // daily revenue goal — used by pace projection updates
  var _leaderName    = '';    // disambiguated display name of today's leader
  var _pollTimer    = null;
  var _lbTimer      = null;
  var _clockTimer   = null;
  var _lastTxnTs    = '';    // cursor for incremental ticker polling
  var _seenTxnKeys  = {};    // dedup set: "ts|who|price" → true, prevents re-injection on repeat polls
  var _confettiParticles = [];
  var _confettiRunning   = false;
  var _goalCelebrated    = false;  // true once confetti has fired for today's goal

  // ── Helpers ────────────────────────────────────────────
  function e(s) { return GC.esc(String(s)); }

  /**
   * Always returns exactly 2 uppercase chars.
   * "Dean Smith"  → "DS"
   * "Zachary B."  → "ZB"
   * "Dean"        → "De"
   */
  function nameToInitials(name) {
    var parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      // First letter of first word + first letter of last word
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    // Single word: first 2 letters
    var w = parts[0] || '??';
    return (w[0] + (w[1] || w[0])).toUpperCase();
  }

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
      var shiftNameKey = p.nameKey || GC.nameToKey(p.name || '');
      return '<div class="shift-person' + cls + '">'
        + GC.lbAvaPuck(shiftNameKey, p.avatarConfig || null, p.initials || '??', true)
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

  // ── Helper: first name, or first name + last initial when duped ──
  function disambiguateName(name) {
    // Server applies nicknames and strips initials by default.
    // Disambiguation is handled in Settings — just return the name as-is.
    return name || '';
  }

  // ── Render: Leader card ────────────────────────────────
  // Fixed count of distinct trophy types — denominator for "N / TOTAL trophies" stat.
  var BADGE_TYPE_TOTAL = 7;

  function renderLeaderCard(leader, allStaff, onShift, badges, today) {
    var dispName = leader.name;

    // ── Chips ────────────────────────────────────────────
    var chipsHtml = '';
    if (leader.leadingSince) {
      chipsHtml += '<span class="leader-chip since">👑 Leading since ' + e(leader.leadingSince) + '</span>';
    }
    if (leader.streak && leader.streak > 1 && leader.streakType === 'fire') {
      chipsHtml += '<span class="leader-chip streak">🔥 ' + leader.streak + '-day streak</span>';
    }

    // ── Secondary stat line ──────────────────────────────
    var aovStr = leader.aov ? '$' + leader.aov.toFixed(2) : '—';
    var uptStr = leader.upt ? leader.upt.toFixed(1) : '—';
    var roleHtml = leader.role
      ? '<div class="leader-role">' + e(leader.role) + '</div>'
      : '';

    // ── Bottom-row stat 1: lead margin ───────────────────
    var secondSales = (allStaff && allStaff[1]) ? (allStaff[1].sales || 0) : null;
    var marginHtml;
    if (secondSales !== null && leader.sales > 0) {
      var margin    = (leader.sales || 0) - secondSales;
      var marginCls = margin > 0 ? ' up' : (margin < 0 ? ' down' : '');
      var marginStr = (margin >= 0 ? '+$' : '−$') + Math.abs(margin).toLocaleString();
      marginHtml = '<div class="kstat' + marginCls + '">'
        + '<div class="kstat-v num">' + marginStr + '</div>'
        + '<div class="kstat-l">Ahead of #2</div>'
        + '</div>';
    } else {
      marginHtml = '<div class="kstat">'
        + '<div class="kstat-v num">—</div>'
        + '<div class="kstat-l">Ahead of #2</div>'
        + '</div>';
    }

    // ── Bottom-row stat 2: personal stretch target ───────
    // leader.target comes from GAS (28-day avg daily sales × 1.025).
    // Color: green if already met, amber if within 20% of target, default otherwise.
    var targetHtml;
    var tgtVal = leader.target || 0;
    if (tgtVal > 0) {
      var tgtCls = '';
      if (leader.sales >= tgtVal) {
        tgtCls = ' up';           // green — hit or exceeded
      } else if (leader.sales >= tgtVal * 0.8) {
        tgtCls = ' warn';         // amber — within 20%
      }
      targetHtml = '<div class="kstat' + tgtCls + '">'
        + '<div class="kstat-v num">' + fmtDollars(tgtVal) + '</div>'
        + '<div class="kstat-l">Today\'s target</div>'
        + '</div>';
    } else {
      targetHtml = '<div class="kstat">'
        + '<div class="kstat-v num">—</div>'
        + '<div class="kstat-l">Today\'s target</div>'
        + '</div>';
    }

    // ── Bottom-row stat 3: trophies held by leader ───────
    var leaderNameLower = (leader.name || '').toLowerCase();
    var trophyCount = (badges || []).filter(function(b) {
      return (b.holder || '').toLowerCase() === leaderNameLower;
    }).length;
    var trophyHtml = '<div class="kstat">'
      + '<div class="kstat-v num">'
      + '<span style="color:var(--yellow);">' + trophyCount + '</span>'
      + '<span style="color:var(--text-mute);font-weight:600;">/' + BADGE_TYPE_TOTAL + '</span>'
      + '</div>'
      + '<div class="kstat-l">Trophies today</div>'
      + '</div>';

    // ── Progress bar toward personal target ─────────────
    var leaderRawPct   = leader.target > 0
      ? Math.round((leader.sales / leader.target) * 100) : 0;
    var leaderBarOver  = leaderRawPct > 100;
    var leaderBarFill  = leaderBarOver ? 100 : leaderRawPct;
    var leaderMarkPct  = leaderBarOver ? Math.round(100 / leaderRawPct * 100) : null;
    var leaderBarLbl   = leaderRawPct + '%';
    var leaderFillStyle = leaderBarOver
      ? 'width:0%; --mark-pct:' + leaderMarkPct + '%'
      : 'width:0%';
    var leaderBarHtml = leader.target > 0
      ? '<div class="emp-bar-wrap leader-bar' + (leaderBarOver ? ' bar-over' : '') + '">'
        +   '<div class="emp-bar"><span style="' + leaderFillStyle + '" data-final="' + leaderBarFill + '%"></span></div>'
        +   (leaderMarkPct !== null ? '<div class="emp-bar-mark" style="left:' + leaderMarkPct + '%"></div>' : '')
        +   '<div class="emp-bar-tick" style="left:0%" data-final="' + leaderBarFill + '%">'
        +     '<span class="emp-bar-pct">' + leaderBarLbl + '</span>'
        +     '<span class="emp-bar-chevron">▲</span>'
        +   '</div>'
        + '</div>'
      : '';

    return '<div class="leader-card">'
      + '<div class="leader-header">'
      + '  <span class="kcard-label">Today\'s Leader</span>'
      + '  <div class="leader-chips">' + chipsHtml + '</div>'
      + '</div>'
      + '<div class="leader-main">'
      + '  <div class="leader-avatar-wrap">'
      + '    <span class="leader-crown">👑</span>'
      + '    <div class="leader-avatar">' + e(leader.initials) + '</div>'
      + '  </div>'
      + '  <div class="leader-info">'
      + '    <div class="leader-name">' + e(dispName) + '</div>'
      + roleHtml
      + '    <div class="leader-secondary">'
      + '      <b>' + e(String(leader.txns || 0)) + '</b> txns'
      + '      · <b>' + e(aovStr) + '</b> AOV'
      + '      · <b>' + e(uptStr) + '</b> UPT'
      + '    </div>'
      + '  </div>'
      + '  <div class="leader-amount-wrap">'
      + '    <div class="leader-amount num" id="kioskLeaderAmt" data-target="' + (leader.sales || 0) + '">'
      + fmtDollars(0) + '</div>'
      + '    <div class="leader-amt-label">Today</div>'
      + '  </div>'
      + '</div>'
      + leaderBarHtml
      + '<div class="kcard-stats">'
      + marginHtml
      + targetHtml
      + trophyHtml
      + '</div>'
      + '</div>';
  }

  // ── Render: Goal arc card ──────────────────────────────
  function renderGoalCard(today) {
    var pct      = today.pctToGoal || 0;
    var pctDisp  = Math.round(pct * 100) + '%';
    var closed   = today.timeRemainingLabel === 'Closed';
    // Arc for "M 22 122 A 98 98 0 0 1 218 122" ≈ π × 98 = 308
    var ARC_LEN  = 308;

    return '<div class="goal-card' + (closed ? ' store-closed' : '') + '">'
      + '<div class="kcard-label">Daily Goal · ' + e(fmtDollars(today.goal)) + '</div>'
      + '<div class="gauge-wrap">'
      + '  <svg width="240" height="130" viewBox="0 0 240 130">'
      + '    <path d="M 22 122 A 98 98 0 0 1 218 122"'
      + '          stroke="#232a27" stroke-width="14" fill="none" stroke-linecap="butt"/>'
      + '    <path id="kioskGoalArc"'
      + '          d="M 22 122 A 98 98 0 0 1 218 122"'
      + '          stroke="#4ade80" stroke-width="14" fill="none" stroke-linecap="round"'
      + '          stroke-dasharray="' + ARC_LEN + '"'
      + '          stroke-dashoffset="' + ARC_LEN + '"'
      + '          style="transition: stroke-dashoffset 1.6s cubic-bezier(.2,.7,.3,1)"/>'
      + '    <path id="kioskGoalOverflow"'
      + '          d="M 22 122 A 98 98 0 0 1 218 122"'
      + '          stroke="none" stroke-width="16" fill="none" stroke-linecap="round"'
      + '          stroke-dasharray="0 308" stroke-dashoffset="0"'
      + '          style="transition: stroke-dasharray 1.6s cubic-bezier(.2,.7,.3,1), stroke-dashoffset 1.6s cubic-bezier(.2,.7,.3,1); filter: drop-shadow(0 0 4px #86efac)"/>'
      + '  </svg>'
      + '  <div class="gauge-pct">'
      + '    <div class="gp-big num" id="kioskGoalPct">0%</div>'
      + '    <div class="gp-small">' + (closed ? 'final' : 'to goal') + '</div>'
      + '  </div>'
      + '</div>'
      + '<div class="kcard-stats">'
      + '  <div class="kstat">'
      + '    <div class="kstat-v num" id="kioskGoalSold" data-target="' + (today.revenue || 0) + '">' + fmtDollars(0) + '</div>'
      + '    <div class="kstat-l">Sold</div>'
      + '  </div>'
      + '  <div class="kstat">'
      + (closed
          ? '<div class="kstat-v store-closed-label" id="kioskGoalToGo">Closed</div>'
          : '<div class="kstat-v num" id="kioskGoalToGo" data-target="' + (today.toGo || 0) + '">' + fmtDollars(0) + '</div>')
      + '    <div class="kstat-l" id="kioskToGoLabel">' + (closed ? '10 pm' : 'To Go') + '</div>'
      + '  </div>'
      + '  <div class="kstat">'
      + '    <div class="kstat-v' + (closed ? ' store-closed-label' : '') + '" id="kioskTimeRemaining">' + e(today.timeRemainingLabel || '—') + '</div>'
      + '    <div class="kstat-l">Remain</div>'
      + '  </div>'
      + '</div>'
      + '</div>';
  }
  // ── Render: Pace dial card ─────────────────────────────
  // PACE_RANGE: ±N% maps to ±90° rotation on the arc.
  // Zones: |deg| > 30 → red (left) or green (right); |deg| ≤ 30 → amber.
  var PACE_RANGE = 30;

  function paceZone(pace) {
    var pct     = (pace || 0) * 100;           // convert decimal to percentage
    var clamped = Math.max(-PACE_RANGE, Math.min(PACE_RANGE, pct));
    var deg     = (clamped / PACE_RANGE) * 90;
    if (deg <= -30) return 'red';
    if (deg >=  30) return 'green';
    return 'amber';
  }

  function renderPaceCard(today) {
    var pace = today.pace || 0;
    var proj = today.projectedRevenue || 0;
    var goal = today.goal || 0;
    var diff = proj - goal;

    // ± % text and zone
    var pctInt  = Math.round(pace * 100);
    var pctStr  = (pctInt >= 0 ? '+' : '−') + Math.abs(pctInt) + '%';
    var zone    = paceZone(pace);
    var zoneColor = zone === 'red' ? 'var(--red)' : zone === 'green' ? 'var(--green)' : 'var(--amber)';

    // Sublabel (under the big %)
    var subLabel = Math.abs(diff) < (goal || 1) * 0.02
      ? 'On plan'
      : diff >= 0 ? 'ahead of plan' : 'behind plan';

    // Tick rotation
    var pct100  = pace * 100;
    var clamped = Math.max(-PACE_RANGE, Math.min(PACE_RANGE, pct100));
    var tickDeg = Math.round((clamped / PACE_RANGE) * 90);

    // Bottom-row stats
    var projStr   = fmtDollars(proj);
    var gapAbs    = Math.abs(Math.round(diff));
    var gapStr    = '$' + gapAbs.toLocaleString();
    var statusStr = Math.abs(diff) < (goal || 1) * 0.02
      ? 'On plan'
      : diff >= 0 ? 'Ahead' : 'Behind';
    var gapCls    = diff >= 0 ? '' : ' down';
    var statusCls = diff >= 0 ? '' : ' down';

    return '<div class="pace-card">'
      + '<div class="kcard-label">Pace · vs. Plan</div>'
      + '<div class="gauge-wrap pace-gauge-wrap">'
      + '  <svg width="240" height="130" viewBox="0 0 240 130">'
      // Background track
      + '    <path d="M 22 122 A 98 98 0 0 1 218 122"'
      + '          stroke="#232a27" stroke-width="14" fill="none" stroke-linecap="round"/>'
      // 3-zone color band
      + '    <path d="M 22 122 A 98 98 0 0 1 71 37"'
      + '          stroke="#ef4444" stroke-width="14" fill="none" stroke-linecap="round" opacity="0.62"/>'
      + '    <path d="M 71 37 A 98 98 0 0 1 169 37"'
      + '          stroke="#eab308" stroke-width="14" fill="none" stroke-linecap="round" opacity="0.62"/>'
      + '    <path d="M 169 37 A 98 98 0 0 1 218 122"'
      + '          stroke="#4ade80" stroke-width="14" fill="none" stroke-linecap="round" opacity="0.62"/>'
      // Apex anchor tick
      + '    <line x1="120" y1="14" x2="120" y2="22" stroke="#5e6864" stroke-width="2" stroke-linecap="round"/>'
      // Pill position indicator — rotates around arc center (120, 122)
      + '    <g id="kioskPaceNeedle"'
      + '       style="transform-origin:120px 122px;transform:rotate(' + tickDeg + 'deg);'
      + 'transition:transform 1.4s cubic-bezier(.2,.7,.3,1)">'
      + '      <rect x="113" y="11" width="14" height="26" rx="7" fill="#0a0e0d" opacity="0.55"/>'
      + '      <rect x="115" y="13" width="10" height="22" rx="5" fill="#e6ece9" stroke="#0a0e0d" stroke-width="1.5"/>'
      + '    </g>'
      + '  </svg>'
      + '  <div class="gauge-pct">'
      + '    <div class="gp-big num zone-' + zone + '" id="kioskPacePct">' + e(pctStr) + '</div>'
      + '    <div class="gp-small" id="kioskPaceLabel" style="color:' + zoneColor + '">' + e(subLabel) + '</div>'
      + '  </div>'
      + '</div>'
      + '<div class="kcard-stats">'
      + '  <div class="kstat">'
      + '    <div class="kstat-v num" id="kioskPaceProjVal">' + e(projStr) + '</div>'
      + '    <div class="kstat-l">Projected</div>'
      + '  </div>'
      + '  <div class="kstat' + gapCls + '">'
      + '    <div class="kstat-v num" id="kioskPaceShortBy">' + e(gapStr) + '</div>'
      + '    <div class="kstat-l" id="kioskPaceShortByLabel">' + e(diff >= 0 ? 'Ahead by' : 'Short by') + '</div>'
      + '  </div>'
      + '</div>'
      + '</div>';
  }
  // ── Render: Staff leaderboard grid ────────────────────
  // onShift: full roster array with { initials, name, role, status, note }
  //          used to build shift-status and mark off-shift employees
  // badges:  normalized badge array — used to show which trophies each emp holds
  function renderStaffGrid(staff, storeName, onShift, badges) {
    // Build shift status map: name (lower) → { status, note }
    var shiftMap = {};
    (onShift || []).forEach(function(p) {
      shiftMap[(p.name || '').toLowerCase()] = { status: p.status || 'on', note: p.note || null };
    });

    // Build badge map: holder name (lower) → [badge, ...]
    var badgeMap = {};
    (badges || []).forEach(function(b) {
      if (!b.holder) return;
      var key = b.holder.toLowerCase();
      if (!badgeMap[key]) badgeMap[key] = [];
      badgeMap[key].push(b);
    });

    // Count first-name frequency across the FULL roster (onShift) so that
    // an off-shift Zachary triggers disambiguation for the on-shift Zachary too.
    var firstNameCount = {};
    (onShift || []).forEach(function(p) {
      var fn = (p.name || '').split(' ')[0].toLowerCase();
      firstNameCount[fn] = (firstNameCount[fn] || 0) + 1;
    });
    // Also include any leaderboard entries not in the onShift roster
    staff.forEach(function(s) {
      var inRoster = (onShift || []).some(function(p) {
        return (p.name || '').toLowerCase() === (s.name || '').toLowerCase();
      });
      if (!inRoster) {
        var fn = (s.name || '').split(' ')[0].toLowerCase();
        firstNameCount[fn] = (firstNameCount[fn] || 0) + 1;
      }
    });

    var cards = staff.map(function(s) {
      var isLeading  = s.rank === 1;
      var barPct     = s.target > 0 ? Math.min(rawBarPct, 100) : 0;
      var aovStr     = s.aov  ? '$' + s.aov.toFixed(2) : '—';
      var uptStr     = s.upt  ? s.upt.toFixed(1)        : '—';
      var nameKey    = (s.name || '').toLowerCase();
      var shift      = shiftMap[nameKey] || { status: 'on', note: null };
      var isOffShift = shift.status !== 'on';

      // Streak / personal best / note row
      var extraHtml = '';
      if (s.streakType === 'fire' && s.streak > 0) {
        extraHtml = '<div class="emp-extra streak">🔥 ' + e(s.streak) + '-day streak</div>';
      } else if (s.personalBestPct !== null && s.personalBestPct >= 0.90) {
        extraHtml = '<div class="emp-extra pb">⚡ Personal best in sight</div>';
      } else if (s.streak > 0) {
        extraHtml = '<div class="emp-extra muted">' + e(s.streak) + '-day streak</div>';
      }

      // Off-shift status pill — shows note ("Back at 8p") or generic label
      var statusHtml = '';
      if (isOffShift) {
        var pillCls = shift.status === 'later' ? 'status-later' : 'status-off';
        var pillTxt = shift.note || (shift.status === 'later' ? 'Later today' : 'Off shift');
        statusHtml = '<div class="emp-status-pill ' + e(pillCls) + '">' + e(pillTxt) + '</div>';
      }

      // Trophies this employee currently holds (mini chips)
      // Try full-name key first (fixture holders = "Dean Deloof").
      // Fall back to first-name key (GAS holders = "Zachary") ONLY when that
      // first name is unique in the roster — avoids giving one Zachary's trophies
      // to a different Zachary at rank #4.
      var firstKey        = (s.name || '').split(' ')[0].toLowerCase();
      var firstNameUnique = firstNameCount[firstKey] === 1;
      var myBadges        = badgeMap[nameKey] || (firstNameUnique ? badgeMap[firstKey] : null) || [];
      var badgesHtml = myBadges.length > 0
        ? '<div class="emp-badges">'
            + myBadges.map(function(b) {
                return '<span class="emp-badge-chip" title="' + e(b.title) + '">' + b.icon + '</span>';
              }).join('')
          + '</div>'
        : '';

      var amtId = 'kioskEmpAmt' + s.rank;

      // Under 100%: bar fills proportionally, no glow, no mark.
      // Over 100%:  bar is always full width + glow; hash mark slides left
      //             to show how far past target they are (mark = 100/rawPct %).
      var rawBarPct     = s.target > 0 ? Math.round((s.sales / s.target) * 100) : 0;
      var barOver       = rawBarPct > 100;
      var barFillPct    = barOver ? 100 : rawBarPct;
      var targetMarkPct = barOver ? Math.round(100 / rawBarPct * 100) : null;
      var pctLabel      = rawBarPct + '%';
      // --mark-pct CSS var drives the ::after glow start position on the fill span
      var fillStyle     = barOver
        ? 'width:0%; --mark-pct:' + targetMarkPct + '%'
        : 'width:0%';
      var statsBody = s.sales > 0
        ? '<div class="emp-amt num" id="' + amtId + '" data-target="' + (s.sales || 0) + '">' + fmtDollars(0) + '</div>'
          + '<div class="emp-bar-wrap' + (barOver ? ' bar-over' : '') + '">'
          +   '<div class="emp-bar"><span style="' + fillStyle + '" data-final="' + barFillPct + '%"></span></div>'
          +   (targetMarkPct !== null ? '<div class="emp-bar-mark" style="left:' + targetMarkPct + '%"></div>' : '')
          +   '<div class="emp-bar-tick" style="left:0%" data-final="' + barFillPct + '%">'
          +     '<span class="emp-bar-pct">' + pctLabel + '</span>'
          +     '<span class="emp-bar-chevron">▲</span>'
          +   '</div>'
          + '</div>'
          + '<div class="emp-stats"><span>AOV <b>' + e(aovStr) + '</b></span><span>UPT <b>' + e(uptStr) + '</b></span>'
          + (s.target > 0 ? '<span>Target <b class="num">' + fmtDollars(s.target) + '</b></span>' : '')
          + '</div>'
        : '<div class="emp-amt" style="color:var(--text-mute);font-size:13px;margin-top:12px">No sales yet</div>';

      var dispName = s.name;
      return '<div class="emp-card' + (isLeading ? ' leading' : '') + (isOffShift ? ' off-shift' : '') + '">'
        + '<span class="emp-rank">#' + e(s.rank) + '</span>'
        + '<div class="emp-head">'
        + GC.lbAvaPuck(s.nameKey, s.avatarConfig, s.initials, true)
        + '  <div>'
        + '    <div class="emp-n">' + e(dispName) + '</div>'
        + '    <div class="emp-initials">' + e(s.initials) + '</div>'
        + '    <div class="emp-r">' + e(s.role) + '</div>'
        + '  </div>'
        + '</div>'
        + statsBody
        + badgesHtml
        + statusHtml
        + extraHtml
        + '</div>';
    }).join('');

    // Ghost cards — roster members with no leaderboard entry today
    // (GAS marks these status:'off' with sales:0; they haven't transacted yet)
    var staffNames = {};
    staff.forEach(function(s) { staffNames[(s.name || '').toLowerCase()] = true; });

    var ghostCards = (onShift || [])
      .filter(function(p) {
        return p.status !== 'on' && !staffNames[(p.name || '').toLowerCase()];
      })
      .map(function(p) {
        var pillCls  = p.status === 'later' ? 'status-later' : 'status-off';
        var pillTxt  = p.note || (p.status === 'later' ? 'Later today' : 'Off today');
        var nameKey  = (p.name || '').toLowerCase();
        var fn       = (p.name || '').split(' ')[0].toLowerCase();
        var fnUnique = firstNameCount[fn] === 1;
        var myBadges = badgeMap[nameKey] || (fnUnique ? badgeMap[fn] : null) || [];
        var badgesHtml = myBadges.length > 0
          ? '<div class="emp-badges">'
              + myBadges.map(function(b) {
                  return '<span class="emp-badge-chip" title="' + e(b.title) + '">' + b.icon + '</span>';
                }).join('')
            + '</div>'
          : '';
        var ghostDispName = p.name;
        var ghostNameKey  = p.nameKey || GC.nameToKey(p.name || '');
        return '<div class="emp-card off-shift">'
          + '<div class="emp-head">'
          + GC.lbAvaPuck(ghostNameKey, p.avatarConfig || null, p.initials || '??', true)
          + '  <div>'
          + '    <div class="emp-n">' + e(ghostDispName) + '</div>'
          + '    <div class="emp-r">' + e(p.role || '') + '</div>'
          + '  </div>'
          + '</div>'
          + badgesHtml
          + '<div class="emp-status-pill ' + e(pillCls) + '">' + e(pillTxt) + '</div>'
          + '</div>';
      }).join('');

    return '<section class="lb-section">'
      + '<div class="lb-head">'
      + '  <h2>Today · ' + e(storeName || '') + ' Team</h2>'
      + '  <span class="lb-sep">/</span>'
      + '  <span class="lb-meta">Live · refreshes every 30 seconds</span>'
      + '</div>'
      + '<div class="lb-grid">' + cards + ghostCards + '</div>'
      + '</section>';
  }

  // ── Render: Weekly badges ──────────────────────────────
  function renderBadges(badges) {
    // Short stat label by badge type — avoids long descriptors ("discount rate") overflowing
    var SHORT_STAT_LABEL = {
      'b-aov':    'AOV',
      'b-upt':    'UPT',
      'b-clean':  'Disc.',
      'b-streak': 'Sales',
      'b-close':  'Tickets',
      'b-new':    'New cust.',
      'b-txn':    'Items',
    };

    // Count first names across all badge holders — disambiguate with last initial when duped
    var badgeFirstNames = {};
    (badges || []).forEach(function(b) {
      var fn = (b.holder || '').trim().split(/\s+/)[0].toLowerCase();
      badgeFirstNames[fn] = (badgeFirstNames[fn] || 0) + 1;
    });

    var items = (badges || []).map(function(b) {
      // Holder display: first name, + last initial if first name is shared
      var parts       = (b.holder || '').trim().split(/\s+/);
      var fn          = (parts[0] || '').toLowerCase();
      var displayName = parts[0] || '';
      if (badgeFirstNames[fn] > 1 && parts.length > 1) {
        displayName += ' ' + parts[parts.length - 1][0].toUpperCase() + '.';
      }
      // Split stat into value + descriptor: "$39.81 avg ticket" → ["$39.81", "avg ticket"]
      // Use short label from map if available (avoids long GAS descriptors overflowing)
      var statParts = (b.stat || '').trim().split(/\s+(.*)/);
      var statVal   = statParts[0] || '';
      var statLabel = SHORT_STAT_LABEL[b.type] || statParts[1] || '';
      return '<div class="badge-item ' + e(b.type) + '">'
          + '<div class="badge-icon">' + b.icon + '</div>'
          + '<div class="badge-info">'
          + '  <div class="badge-title">' + e(b.title) + '</div>'
          + '  <div class="badge-holder">' + e(displayName) + '</div>'
          + '</div>'
          + '<div class="badge-stat">'
          + '  <div class="badge-stat-value">' + e(statVal) + '</div>'
          + (statLabel ? '<div class="badge-stat-label">' + e(statLabel) + '</div>' : '')
          + '</div>'
          + '</div>';
    }).join('');

    return '<div class="kiosk-card badges-card">'
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
      // Amount: explicit field → GAS h.revenue → pct × peakRevenue fallback
      var amt    = h.amount != null ? h.amount
                 : h.revenue != null ? h.revenue
                 : Math.round((h.pct || 0) * (peakRevenue || 0) / 100);
      var amtStr = '$' + amt.toLocaleString() + (h.projected ? ' est.' : '');
      return '<div class="hm-bar' + cls + '" style="height:' + (h.pct || 0) + '%;background:' + color + '">'
        + '<div class="hm-tooltip">' + e(amtStr) + '</div>'
        + '<span class="hm-hour">' + e(h.hour) + '</span>'
        + '</div>';
    }).join('');

    var peakStr = peakHour
      ? 'Peak · ' + e(peakHour) + ' · ' + e(fmtDollars(peakRevenue || 0))
      : '';

    return '<div class="kiosk-card heatmap-card">'
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
        + '<span class="t-who"><span class="t-who-name">' + e(t.firstName || '') + '</span>'
        +                        '<span class="t-who-init">' + e(nameToInitials(t.firstName)) + '</span></span>'
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
    _leaderName = leader.name || '';

    return [
      '<canvas id="kioskConfetti"></canvas>',
      '<div id="kioskGoalBanner">🎯 DAILY GOAL HIT! · ' + e(store.name.toUpperCase()) + ' TEAM!</div>',
      '<div class="kiosk-wrap">',
        renderHeader(store),
        '<div class="hero-grid">',
          renderLeaderCard(leader, staff, onShift, badges, today),
          renderGoalCard(today),
          renderPaceCard(today),
        '</div>',
        renderClosingBanner(),
        renderStaffGrid(staff, store.name, onShift, badges),
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

    // Full roster + badges — kept for leaderboard refresh re-renders
    _onShift = data.today.onShift || [];
    _badges  = data.badges.badges || [];
    _goal    = (data.today.today && data.today.today.goal) || data.today.goal || 0;

    // Seed ticker cursor from the most recent transaction timestamp
    _lastTxnTs = data.today.latestTxnTs || '';

    // Seed dedup set from initial ticker so polls don't re-inject what's already shown
    _seenTxnKeys = {};
    (data.today.ticker || []).forEach(function(t) {
      // Fixture tickers use {time,firstName,desc,amount}; GAS raw uses {ts,who,item,price}
      var key = (t.ts || t.time || '') + '|' + (t.who || t.firstName || '') + '|' + (t.price || t.amount || 0);
      _seenTxnKeys[key] = true;
    });

    document.body.classList.add('kiosk-bg');

    startClock();
    runCountUps(data);
    animateGoalArc(data.today.today.pctToGoal);
    animatePaceNeedle(data.today.today.pace);
    animateBars();
    updateClosingBanner(data.today.today);
    initConfetti();
    startPolling(slug);

    // Seed celebration flag — if goal is already hit on load, fire confetti once
    _goalCelebrated = (data.today.today.pctToGoal || 0) >= GC.THRESHOLDS.goalCelebrationAt;
    if (_goalCelebrated) {
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

    // Pace card ±% is plain text — no countUp needed

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
    var ARC_LEN = 308;
    setTimeout(function() {
      setGoalArcs(pct || 0);
    }, 250);
  }

  function setGoalArcs(pct) {
    var ARC_LEN = 308;
    var capped  = Math.min(pct, 1);
    var arc = document.getElementById('kioskGoalArc');
    var ovr = document.getElementById('kioskGoalOverflow');

    if (arc) arc.setAttribute('stroke-dashoffset', String(Math.round(ARC_LEN * (1 - capped))));

    if (ovr) {
      if (pct > 1) {
        var overLen = Math.round(Math.min(pct - 1, 0.5) * ARC_LEN);
        ovr.setAttribute('stroke',            '#a3f0be');
        ovr.setAttribute('stroke-dasharray',  overLen + ' 9999');
        ovr.setAttribute('stroke-dashoffset', String(-(ARC_LEN - overLen)));
      } else {
        // stroke="none" prevents the round-linecap zero-length dash from drawing a dot
        ovr.setAttribute('stroke',            'none');
        ovr.setAttribute('stroke-dasharray',  '0 308');
        ovr.setAttribute('stroke-dashoffset', '0');
      }
    }
  }

  // ── Pace tick ─────────────────────────────────────────
  function animatePaceNeedle(pace) {
    setTimeout(function() {
      var tick = document.getElementById('kioskPaceNeedle');
      if (!tick) return;
      var pct100  = (pace || 0) * 100;
      var clamped = Math.max(-PACE_RANGE, Math.min(PACE_RANGE, pct100));
      var deg     = Math.round((clamped / PACE_RANGE) * 90);
      tick.style.transform = 'rotate(' + deg + 'deg)';
    }, 350);
  }

  // ── Animate employee bars ──────────────────────────────
  function animateBars() {
    setTimeout(function() {
      document.querySelectorAll('.emp-bar span[data-final]').forEach(function(span) {
        span.style.width = span.getAttribute('data-final');
      });
      document.querySelectorAll('.emp-bar-tick[data-final]').forEach(function(tick) {
        tick.style.left = tick.getAttribute('data-final');
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
      // Dedup: skip items already shown (handles GAS returning same transactions on repeat polls)
      var key = (t.ts || '') + '|' + (t.who || '') + '|' + (t.price || 0);
      if (_seenTxnKeys[key]) return;
      _seenTxnKeys[key] = true;

      var qty     = t.qty || 0;
      var qtyStr  = qty > 0 ? (qty + (qty === 1 ? ' item' : ' items')) : '';
      var el = document.createElement('div');
      el.className = 'ticker-item fresh';
      el.innerHTML = '<span class="t-time">' + GC.esc(fmtTxnTime(t.ts)) + '</span>'
        + '<span class="t-who"><span class="t-who-name">' + GC.esc(t.who || '') + '</span>'
        +                     '<span class="t-who-init">' + GC.esc(nameToInitials(t.who || '')) + '</span></span>'
        + '<span class="t-desc">' + GC.esc(qtyStr)        + '</span>'
        + '<span class="t-amt">'  + GC.esc(fmtDollars(t.price || 0)) + '</span>';
      feed.insertBefore(el, feed.firstChild);
      setTimeout(function() { el.classList.remove('fresh'); }, 1800);

      // Pulse the leader amount when a sale lands for the current leader
      var leaderAmtEl = document.getElementById('kioskLeaderAmt');
      if (leaderAmtEl && _leaderName && (t.who || '').split(' ')[0].toLowerCase() === _leaderName.split(' ')[0].toLowerCase()) {
        leaderAmtEl.classList.remove('pulse-once');
        void leaderAmtEl.offsetWidth; // force reflow to restart animation
        leaderAmtEl.classList.add('pulse-once');
      }

      // Trigger rare-drop overlay for high-value transactions
      if ((t.price || 0) >= GC.THRESHOLDS.rareDropMinTransaction) {
        showRareDrop(t.who || '', t.item || '', t.price || 0);
      }
    });

    // Keep feed trimmed to 10 rows
    while (feed.children.length > 10) feed.removeChild(feed.lastChild);
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

    // Avatar config map — declared early so onShift + staff normalization can both use it
    var kioskAvatarConfigs = lb.avatarConfigs || {};

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
          var nameKey = GC.nameToKey(p.name || '');
          return {
            initials:     p.initials || '',
            name:         p.name     || '',
            nameKey:      nameKey,
            avatarConfig: kioskAvatarConfigs[nameKey] || null,
            role:         p.role     || '',
            status:       p.status   || 'on',
            note:         p.note     || null,
          };
        }),
        hourly:       td.hourly       || [],
        peakHour:     td.peakHour     || null,
        peakRevenue:  td.peakRevenue  || 0,
        latestTxnTs:  td.latestTxnTs  || '',
        // GAS ticker: {who,qty,price,ts} → {time,firstName,desc,amount}
        ticker: (td.ticker || []).map(function(t) {
          if (t.firstName !== undefined) return t; // already normalized
          // Parse time directly from local ISO string to avoid UTC offset
          var ts = t.ts || '';
          var h  = ts.length >= 13 ? parseInt(ts.slice(11, 13), 10) : new Date().getHours();
          var mn = ts.length >= 16 ? parseInt(ts.slice(14, 16), 10) : new Date().getMinutes();
          var hh = ((h + 11) % 12) + 1;
          var qty = t.qty || 0;
          return {
            time:      hh + ':' + mn.toString().padStart(2, '0') + (h >= 12 ? 'p' : 'a'),
            firstName: t.who || '',
            desc:      qty > 0 ? (qty + (qty === 1 ? ' item' : ' items')) : '',
            amount:    t.price || 0,
          };
        }),
      };
    }

    // ── staff ──
    // GAS: avgOrderValue, avgUPT, transactions, streakDays (no role, no streakType)
    // Fixture: aov, txns, streak, streakType, role, upt
    var normalizedStaff = (lb.staff || []).map(function(s) {
      var streak  = s.streak != null ? s.streak : (s.streakDays || 0);
      var nameKey = GC.nameToKey(s.name || '');
      return {
        rank:            s.rank           || 0,
        initials:        s.initials       || '',
        name:            s.name           || '',
        nameKey:         nameKey,
        avatarConfig:    kioskAvatarConfigs[nameKey] || null,
        role:            s.role           || s.roleLabel || '',
        sales:           s.sales          || 0,
        txns:            s.txns  != null  ? s.txns  : (s.transactions || 0),
        aov:             s.aov   != null  ? s.aov   : (s.avgOrderValue || 0),
        upt:             s.upt   != null  ? s.upt   : (s.avgUPT        || 0),
        streak:          streak,
        streakType:      s.streakType     || (streak > 2 ? 'fire' : ''),
        leadingSince:    s.leadingSince   || '',
        target:          s.target         || 0,
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
      'txn-king':    'b-txn',
    };
    var BADGE_ICON_MAP = {
      'aov-avenger': '💰',
      'upsell-king': '👑',
      'cleanest':    '🧼',
      'top-sales':   '🔥',
      'the-closer':  '🤝',
      'streak':      '⚡',
      'new-hire':    '🌱',
      'txn-king':    '🎯',
    };
    // Short display titles — avoids ellipsis truncation in narrow badge cards
    var BADGE_SHORT_MAP = {
      'aov-avenger': 'AOV Avenger',
      'upsell-king': 'Upsell King',
      'cleanest':    'Low Disc.',
      'top-sales':   'Top Sales',
      'the-closer':  'The Closer',
      'streak':      'Win Streak',
      'new-hire':    'New Cust.',
      'txn-king':    'Txn King',
    };
    var normalizedBadges = (bg.badges || []).map(function(b) {
      return {
        id:         b.id     || '',
        icon:       BADGE_ICON_MAP[b.id]   || b.icon  || '',
        title:      BADGE_SHORT_MAP[b.id]  || b.label || b.title || '',
        holder:     b.winner || b.holder   || '',
        stat:       b.detail || b.stat     || '',
        type:       BADGE_TYPE_MAP[b.id]   || b.type  || '',
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
    var closed    = label === 'Closed';

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

    setGoalArcs(pctToGoal);

    // Dim the card when store is closed
    var card = arc && arc.closest('.goal-card');
    if (card) card.classList.toggle('store-closed', closed);

    // Update the status label
    var lblEl = document.getElementById('kioskTimeRemaining');
    if (lblEl) {
      lblEl.textContent = label || '—';
      lblEl.classList.toggle('store-closed-label', closed);
    }

    // Pace tick position
    if (td.pace != null) {
      var tick = document.getElementById('kioskPaceNeedle');
      if (tick) {
        var pct100  = td.pace * 100;
        var clamped = Math.max(-PACE_RANGE, Math.min(PACE_RANGE, pct100));
        var tickDeg = Math.round((clamped / PACE_RANGE) * 90);
        tick.style.transform = 'rotate(' + tickDeg + 'deg)';
      }
      // ±% big number + zone color
      var pctInt    = Math.round(td.pace * 100);
      var pctStr    = (pctInt >= 0 ? '+' : '−') + Math.abs(pctInt) + '%';
      var zone      = paceZone(td.pace);
      var zoneColor = zone === 'red' ? 'var(--red)' : zone === 'green' ? 'var(--green)' : 'var(--amber)';
      var paceEl = document.getElementById('kioskPacePct');
      if (paceEl) {
        paceEl.textContent = pctStr;
        paceEl.className   = 'gp-big num zone-' + zone;
      }
      var labelEl = document.getElementById('kioskPaceLabel');
      if (labelEl) {
        var subLbl = Math.abs(td.pace) < 0.02 ? 'On plan'
          : td.pace >= 0 ? 'ahead of plan' : 'behind plan';
        labelEl.textContent  = subLbl;
        labelEl.style.color  = zoneColor;
      }
    }
    if (td.projectedRevenue != null) {
      var proj  = td.projectedRevenue;
      var diff  = proj - _goal;
      var gapCls = diff >= 0 ? '' : ' down';
      var projValEl = document.getElementById('kioskPaceProjVal');
      if (projValEl) projValEl.textContent = fmtDollars(proj);
      var shortByEl = document.getElementById('kioskPaceShortBy');
      if (shortByEl) {
        shortByEl.textContent = '$' + Math.abs(Math.round(diff)).toLocaleString();
        shortByEl.parentElement.className = 'kstat' + gapCls;
      }
      var shortByLblEl = document.getElementById('kioskPaceShortByLabel');
      if (shortByLblEl) shortByLblEl.textContent = diff >= 0 ? 'Ahead by' : 'Short by';
    }

    // Closing push
    updateClosingBanner(td);

    // Goal celebration — fire confetti the first time pctToGoal crosses the threshold
    if (!_goalCelebrated && pctToGoal >= GC.THRESHOLDS.goalCelebrationAt) {
      _goalCelebrated = true;
      fireConfetti();
    }
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
            section.outerHTML = renderStaffGrid(staff, _storeName, _onShift, _badges);
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
