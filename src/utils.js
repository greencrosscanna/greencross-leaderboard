// ============================================================
//  Green Cross — Sales Dashboard
//  Utilities: constants, formatters, threshold helpers, dates
// ============================================================

window.GC = window.GC || {};

// ── Store Registry ────────────────────────────────────────
GC.STORES = {
  baseline:   { name: 'Baseline',   slug: 'baseline',   color: '#4ade80', address: 'SW 5th' },
  center:     { name: 'Center',     slug: 'center',     color: '#60a5fa', address: 'Downtown' },
  century:    { name: 'Century',    slug: 'century',    color: '#f97316', address: 'SE Powell' },
  commercial: { name: 'Commercial', slug: 'commercial', color: '#facc15', address: 'N Mississippi' },
  portland:   { name: 'Portland',   slug: 'portland',   color: '#a78bfa', address: 'NW 23rd' },
  river:      { name: 'River',      slug: 'river',      color: '#ef4444', address: 'SE 39th' },
};

GC.STORE_SLUGS = Object.keys(GC.STORES);

// ── Thresholds (spec §5) ─────────────────────────────────
// All UI states are derived from these. In v1.1 these come
// from GET /api/config/thresholds instead of this constant.
GC.THRESHOLDS = {
  discountWatch:            0.065,   // 6.5% — flag for discount watch panel
  discountUnusual:          0.15,    // 15% — per-transaction line flag
  rareDropMinTransaction:   400,     // $ — celebration trigger
  rareDropMinLineItem:      300,     // $ — alt trigger (single SKU line)
  rareDropMaxPerShift:      3,       // throttle rare drops per shift
  paceRedBelow:            -0.05,    // −5% vs plan → red dot
  paceAmberBelow:          -0.01,    // −1% vs plan → amber dot
  paceGreenAbove:           0.01,    // +1% vs plan → green dot
  goalCelebrationAt:        1.0,     // 100% → confetti + banner
  newHireWindowDays:        60,      // days since hire → "New" tag
  streakWindowDays:         30,      // rolling window for streak baseline
  personalBestWindowDays:   90,      // window for personal-best calc
};

// ── Formatters ────────────────────────────────────────────

/** $646,100 → "$646.1k" · $78,340 → "$78.3k" · $78.34 → "$78.34" */
GC.fmtCurrency = function(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(1) + 'M';
  if (abs >= 10_000)    return sign + '$' + (abs / 1_000).toFixed(1) + 'k';
  if (abs >= 1_000)     return sign + '$' + abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return sign + '$' + abs.toFixed(2);
};

/** 0.061 → "6.1%" */
GC.fmtPct = function(n, decimals) {
  if (n == null || isNaN(n)) return '—';
  const d = decimals != null ? decimals : 1;
  return (n * 100).toFixed(d) + '%';
};

/** 8247 → "8,247" */
GC.fmtNum = function(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
};

/** 2.6 → "2.6" */
GC.fmtDecimal = function(n, places) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(places != null ? places : 1);
};

/** 0.042 → "▲ +4.2%" | -0.053 → "▼ −5.3%" */
GC.fmtDeltaPct = function(n) {
  if (n == null || isNaN(n)) return '';
  const abs = Math.abs(n * 100).toFixed(1);
  if (n > 0.001)  return '▲ +' + abs + '%';
  if (n < -0.001) return '▼ −' + abs + '%';
  return '—';
};

/** 1.18 → "▲ +$1.18" | -1.18 → "▼ −$1.18" */
GC.fmtDeltaCurrency = function(n) {
  if (n == null || isNaN(n)) return '';
  const abs = GC.fmtCurrency(Math.abs(n));
  if (n > 0.005)  return '▲ +' + abs;
  if (n < -0.005) return '▼ −' + abs;
  return '—';
};

/** 14 → "▲ +14" | -14 → "▼ −14" */
GC.fmtDeltaNum = function(n, prefix) {
  if (n == null || isNaN(n)) return '';
  const pre = prefix || '';
  if (n > 0)  return '▲ +' + pre + GC.fmtNum(n);
  if (n < 0)  return '▼ −' + pre + GC.fmtNum(Math.abs(n));
  return '—';
};

// ── Threshold Classifiers ─────────────────────────────────

/** 0.042 → 'lo' | 0.058 → 'mid' | 0.089 → 'hi' */
GC.discountSeverity = function(rate) {
  if (rate == null) return 'lo';
  if (rate >= GC.THRESHOLDS.discountWatch) return 'hi';
  if (rate >= 0.05) return 'mid';
  return 'lo';
};

/** pace number → 'green' | 'amber' | 'red' */
GC.paceDotClass = function(pace) {
  const t = GC.THRESHOLDS;
  if (pace >= t.paceGreenAbove) return 'green';
  if (pace <= t.paceRedBelow)   return 'red';
  return 'amber';
};

/** rank number + total stores → '' | 'mid' | 'bad' */
GC.rankPillClass = function(rank, total) {
  if (rank <= 2)           return '';          // green
  if (rank >= (total - 1)) return 'bad';       // red (bottom two)
  return 'mid';
};

/** hire_date string → true if within new-hire window */
GC.isNewHire = function(hireDateStr) {
  if (!hireDateStr) return false;
  const hire = new Date(hireDateStr);
  const cutoff = new Date(Date.now() - GC.THRESHOLDS.newHireWindowDays * 86400_000);
  return hire > cutoff;
};

// ── Sparkline ─────────────────────────────────────────────

/**
 * Convert an array of numbers to SVG polyline points string.
 * Output fits inside a width×height bounding box.
 * Y-axis is inverted (SVG 0 = top).
 */
GC.sparklinePoints = function(data, width, height) {
  width  = width  || 80;
  height = height || 22;
  if (!data || data.length < 2) return '';
  const min = Math.min.apply(null, data);
  const max = Math.max.apply(null, data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const pad = 2;
  return data.map(function(v, i) {
    const x = Math.round(i * step);
    const y = Math.round((height - pad) - ((v - min) / range) * (height - pad * 2) + pad);
    return x + ',' + y;
  }).join(' ');
};

/** trendPct (0.18 for +18%) → 'up' | 'down' | '' */
GC.trendClass = function(pct) {
  if (pct >  0.005) return 'up';
  if (pct < -0.005) return 'down';
  return '';
};

/** trendPct → "+18%" | "−11%" | "0%" */
GC.trendLabel = function(pct) {
  if (pct == null || isNaN(pct)) return '';
  const abs = Math.abs(pct * 100).toFixed(0);
  if (pct >  0.005) return '+' + abs + '%';
  if (pct < -0.005) return '−' + abs + '%';
  return '0%';
};

/** Sparkline stroke color based on trendClass */
GC.trendStroke = function(cls) {
  if (cls === 'up')   return '#4ade80';
  if (cls === 'down') return '#ef4444';
  return '#8a958f';
};

// ── Timezone: always display/compute in Pacific Time ─────────────────────────
// Uses IANA 'America/Los_Angeles' so PDT/PST transitions are handled
// automatically by the browser, regardless of where the viewer is located.

GC.PT_TZ = 'America/Los_Angeles';

/** Returns PT 'YYYY-MM-DD' for a given Date (or today).
 *  en-CA locale produces YYYY-MM-DD format natively. */
GC._ptDateStr = function(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: GC.PT_TZ }).format(d || new Date());
};

// ── Date / Period Helpers ─────────────────────────────────

/** Returns 'YYYY-MM-DD' for today in PT */
GC.todayStr = function() {
  return GC._ptDateStr(new Date());
};

/** Returns 'YYYY-MM-DD' for n days ago in PT */
GC.daysAgoStr = function(n) {
  return GC._ptDateStr(new Date(Date.now() - n * 86400_000));
};

/** Returns { from: 'YYYY-MM-01', to: PT today } for MTD */
GC.mtdRange = function() {
  const today = GC.todayStr();
  return { from: today.slice(0, 7) + '-01', to: today };
};

/** Returns { from: Mon, to: today } for current week in PT */
GC.wtdRange = function() {
  const d     = new Date();
  const today = GC.todayStr();
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: GC.PT_TZ, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d).forEach(function(p) { parts[p.type] = p.value; });
  var dowMap   = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var daysToMon = (dowMap[parts.weekday] || 0) === 0 ? 6 : (dowMap[parts.weekday] - 1);
  var mon = new Date(d.getTime() - daysToMon * 86400_000);
  return { from: GC._ptDateStr(mon), to: today };
};

/** Period label for display */
GC.periodLabel = function(period) {
  const map = {
    today: 'Today',
    wtd:   'Week-to-Date',
    mtd:   'Month-to-Date',
    pp:    'Pay Period (2-wk)',
    qtd:   'Quarter-to-Date',
    ytd:   'Year-to-Date',
  };
  return map[period] || period;
};

// ── Clock ─────────────────────────────────────────────────

/** Format a Date → "6:47 PM" in PT (DST-aware, viewer-timezone-independent) */
GC.fmtTime = function(d) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: GC.PT_TZ, hour: 'numeric', minute: '2-digit', hour12: true
  }).format(d || new Date());
};

/** Format a Date → "Fri · May 15" in PT */
GC.fmtDateShort = function(d) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: GC.PT_TZ, weekday: 'short', month: 'short', day: 'numeric'
  }).formatToParts(d || new Date()).forEach(function(p) { parts[p.type] = p.value; });
  return parts.weekday + ' · ' + parts.month + ' ' + parts.day;
};

/** Format a Date → "May 1 – 15, 2026" for period range */
GC.fmtDateRange = function(fromStr, toStr) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const f = new Date(fromStr + 'T00:00:00');
  const t = new Date(toStr   + 'T00:00:00');
  if (f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()) {
    return months[f.getMonth()] + ' ' + f.getDate() + ' – ' + t.getDate() + ', ' + f.getFullYear();
  }
  return months[f.getMonth()] + ' ' + f.getDate() + ' – ' + months[t.getMonth()] + ' ' + t.getDate() + ', ' + t.getFullYear();
};

// ── Escape ────────────────────────────────────────────────
GC.esc = function(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
};

// ── Avatar helpers ────────────────────────────────────────

/** Canonical nameKey: same logic as GAS nameToKey_() */
GC.nameToKey = function(name) {
  return (name || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, '_').trim();
};

/**
 * Build a DiceBear Avataaars v9 URL from a config object + seed.
 * Rules:
 *   - _none in top/facialHair/accessories → set *Probability=0, skip color param
 *   - Otherwise → *Probability=100 so feature is guaranteed
 */
GC.buildAvatarUrl = function(cfg, seed) {
  var params = [];
  params.push('seed=' + encodeURIComponent(seed || 'unknown'));

  var noAccessories = cfg.accessories === '_none';
  var noFacialHair  = cfg.facialHair  === '_none';
  var noHair        = cfg.top         === '_none';

  var keys = Object.keys(cfg);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = cfg[k];
    if (v == null || v === '_none')                 continue;
    if (k === 'accessoriesColor' && noAccessories)  continue;
    if (k === 'facialHairColor'  && noFacialHair)   continue;
    if (k === 'hairColor'        && noHair)          continue;
    params.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }

  params.push('accessoriesProbability=' + (noAccessories ? '0' : '100'));
  params.push('facialHairProbability='  + (noFacialHair  ? '0' : '100'));
  params.push('topProbability='         + (noHair        ? '0' : '100'));

  return 'https://api.dicebear.com/9.x/avataaars/svg?' + params.join('&');
};

/**
 * onerror handler for .lb-ava img elements.
 * Falls back to initials text stored in [data-initials] on the parent puck.
 */
GC.avaFallback = function(img) {
  var puck = img.parentNode;
  if (!puck) return;
  puck.classList.add('initials');
  puck.textContent = puck.getAttribute('data-initials') || '';
};

/**
 * Generate the HTML for a leaderboard avatar puck.
 * @param {string}  nameKey      - stable per-employee key (used as seed + nav target)
 * @param {Object}  avatarConfig - avatar config object, or null/undefined for initials
 * @param {string}  initials     - fallback text (2–3 chars)
 * @param {boolean} clickable    - if true, adds data-ava-nav so the chip navigates to picker
 */
/**
 * Navigate to the avatar picker, encoding the current route as `from`
 * so the picker's back button returns to the right place.
 */
GC.navToAvatar = function(nameKey) {
  var from = (window.location.hash || '').replace(/^#/, '') || '/';
  GC.router.navigate('#/avatar?employee=' + encodeURIComponent(nameKey) + '&from=' + encodeURIComponent(from));
};

GC.lbAvaPuck = function(nameKey, avatarConfig, initials, clickable) {
  var esc      = GC.esc;
  var safeInit = esc(initials || '??');
  // data-ava-nav drives CSS cursor + hover scale; onclick uses GC.navToAvatar
  var navAttr = clickable ? ' data-ava-nav="' + esc(nameKey) + '"' : '';
  var clickHandler = clickable
    ? ' onclick="GC.navToAvatar(\'' + esc(nameKey) + '\')"'
    : '';

  if (avatarConfig) {
    var url = GC.buildAvatarUrl(avatarConfig, nameKey);
    return '<div class="lb-ava" data-initials="' + safeInit + '"' + navAttr + clickHandler + '>'
      + '<img src="' + esc(url) + '" alt="" onerror="GC.avaFallback(this)">'
      + '</div>';
  }
  return '<div class="lb-ava initials" data-initials="' + safeInit + '"' + navAttr + clickHandler + '>'
    + safeInit
    + '</div>';
};

// ── Toast ─────────────────────────────────────────────────
GC.toast = function(message, type, duration) {
  type     = type     || 'info';
  duration = duration || 3000;
  var container = document.getElementById('toastContainer');
  if (!container) return;
  var el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(function() {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(function() { el.remove(); }, 300);
  }, duration);
};
