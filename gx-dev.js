/* GX Dev Guard — makes "local page, LIVE backend" safe to work in.
 * Canonical source: greencross-gx-theme/gx-dev.js. Synced into every spoke by gx-sync.sh.
 *
 * WHY THIS EXISTS
 * Our apps are single-file (or near-single-file) monoliths with no build step, so the fastest loop is
 * to serve the working tree from localhost and point it at the LIVE backend — real stores, real data,
 * nothing committed, no GAS version cut until the idea is baked. Two things then go wrong:
 *   1. You lose track of which browser window is prod. Everything looks identical.
 *   2. A write fired from localhost is a REAL write. Apps Script cannot save you here: doGet(e) exposes
 *      no request headers — no Origin, no Referer — so the server literally cannot tell your laptop from
 *      a kiosk. The guard HAS to live on the client, which means it is only as good as the app having
 *      ONE api chokepoint that calls GXDev.check().
 *
 * CONTRACT
 *   In production (any non-localhost origin) this file is inert — check() passes everything through.
 *   In dev it paints a banner and blocks any action the app has not declared as a read, until armed.
 *   Fails SAFE: an undeclared action is blocked, not allowed. A missed read is a loud, harmless block
 *   you fix in seconds; a missed write is corrupted payout/count data you find out about days later.
 *
 * USAGE (in the app, once)
 *   <script src="gx-dev.js"></script>
 *   GXDev.declareReads(['storetoday','storeleaderboard', ...]);   // every non-mutating action
 *   // then in the app's single api chokepoint, before the request goes out:
 *   function gasCall(action, extra) { GXDev.check(action); ... }
 *
 * ARMING (when you genuinely want to test a write against live data)
 *   Click ARM WRITES in the banner, or load with ?arm=1, or run GXDev.arm() in the console.
 *   Arming is per-tab (sessionStorage) and dies with the tab. It never persists to a new window.
 */
(function (global) {
  if (global.GXDev) return;                       // never double-install

  var host   = (global.location && global.location.hostname) || '';
  var IS_DEV = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '' ||
               /^192\.168\./.test(host) || /^10\./.test(host);   // --lan serving counts as dev too
  var READS  = {};
  var KEY    = 'gx_dev_armed';
  var banner = null;

  function armed() {
    try { return global.sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function setArmed(v) {
    try { v ? global.sessionStorage.setItem(KEY, '1') : global.sessionStorage.removeItem(KEY); } catch (e) {}
    paint();
  }

  function declareReads(list) {
    (list || []).forEach(function (a) { READS[String(a).toLowerCase()] = true; });
    paint();
  }

  /* The gate. Call this in the app's api chokepoint before every backend request.
   * Returns true when allowed. Throws a loud, actionable Error when blocked — deliberately
   * a throw and not a silent no-op, so a blocked write surfaces instead of looking like a
   * backend that returned nothing. */
  function check(action) {
    if (!IS_DEV) return true;                     // production: inert
    var a = String(action || '').toLowerCase();
    if (READS[a]) return true;                    // declared read: always fine
    if (armed()) { console.warn('[GXDev] ARMED — "' + a + '" is writing to LIVE data.'); return true; }
    var msg = '[GXDev] BLOCKED "' + a + '" — this is localhost talking to the LIVE backend, and "' + a +
              '" is not a declared read.\n' +
              '  • If it IS a read, add it to GXDev.declareReads([...]) in this app.\n' +
              '  • If it is a write and you mean it, click ARM WRITES in the banner (or run GXDev.arm()).';
    console.error(msg);
    throw new Error(msg);
  }

  var BAR = 24;          // px — bar height, and the offset everything else gets

  /* Reserve space for the bar instead of overlaying the app.
   * Three things have to move, not one:
   *   1. Normal flow      — body padding-top, injected as a STYLESHEET rule (not an inline style) so it
   *                         survives the app re-rendering and does not need <body> to exist yet.
   *   2. position:fixed   — those anchor to the VIEWPORT, so they ignore body padding and would sit
   *                         underneath the bar. Any fixed rule pinned to top:0 gets pushed down by BAR.
   *   3. 100vh containers — still measure the full viewport, so the page would end up BAR taller and
   *                         grow a spurious scrollbar. Those get shrunk by BAR.
   * (2) and (3) rewrite the app's own same-origin CSS rules — no DOM restructuring, which would risk
   * breaking a booted app that holds references to its own nodes.
   * IDEMPOTENT ON PURPOSE: stylesheets are parsed progressively, so this runs at DOMContentLoaded AND
   * at load, and re-running must be a no-op on rules it already fixed. A boolean "did I run yet" flag
   * is wrong here — the first run legitimately sees only part of the CSS.
   * Wrapped in try/catch throughout: an unreadable stylesheet is skipped, never fatal. */
  function reserveSpace() {
    // Inline on <html>, NOT a <style> tag and NOT on <body>: these apps are SPAs that rebuild head
    // styles and body content on route change, which silently removed a stylesheet-based offset.
    // documentElement survives every route swap.
    try {
      document.documentElement.style.setProperty('padding-top', BAR + 'px', 'important');
      document.documentElement.style.setProperty('box-sizing', 'border-box', 'important');
    } catch (e) {}
  }

  function adjustLayout() {
    reserveSpace();
    var sheets = (global.document && document.styleSheets) || [];
    for (var i = 0; i < sheets.length; i++) {
      var rules;
      try { rules = sheets[i].cssRules; } catch (e) { continue; }   // cross-origin — skip
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var st = rules[j].style;
        if (!st) continue;                                          // @media/@keyframes wrapper — no style
        try {
          if (st.position === 'fixed' && (st.top === '0px' || st.top === '0')) st.top = BAR + 'px';
          ['height', 'minHeight', 'maxHeight'].forEach(function (prop) {
            var v = st[prop];
            if (v && v.indexOf('vh') > -1 && v.indexOf('calc') === -1) {
              st[prop] = 'calc(' + v + ' - ' + BAR + 'px)';
            }
          });
        } catch (e) {}
      }
    }
  }

  function paint() {
    if (!IS_DEV || !global.document || !document.body) return;
    adjustLayout();
    var on = armed();
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'gx-dev-banner';
      banner.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;' +
        'font:600 11px/' + BAR + 'px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;' +
        'text-align:center;height:' + BAR + 'px;color:#000;text-transform:uppercase;';
      document.body.appendChild(banner);
    }
    banner.style.background = on ? '#ff3b30' : '#ffcc00';
    banner.style.color      = on ? '#fff'    : '#000';
    banner.innerHTML =
      (on ? '⚠ LOCAL DEV — WRITES ARMED → LIVE PRODUCTION DATA' : '● LOCAL DEV — LIVE DATA, READ-ONLY') +
      ' <button id="gx-dev-arm" style="pointer-events:auto;margin-left:10px;font:inherit;' +
      'text-transform:uppercase;cursor:pointer;border:1px solid currentColor;background:transparent;' +
      'color:inherit;border-radius:3px;padding:0 7px;line-height:16px;">' + (on ? 'disarm' : 'arm writes') + '</button>';
    document.getElementById('gx-dev-arm').onclick = function () { setArmed(!armed()); };
  }

  if (IS_DEV) {
    try {
      if (/[?&]arm=1\b/.test(global.location.search)) setArmed(true);
    } catch (e) {}
    if (global.document) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
      else paint();
      global.addEventListener('load', adjustLayout);   // stylesheets parse progressively — run again
      global.addEventListener('hashchange', adjustLayout);  // SPA route swap rebuilds styles — re-assert
    }
    console.warn('[GXDev] LOCAL DEV against the LIVE backend. Writes blocked until armed. ' +
                 'GXDev.arm() to allow, GXDev.disarm() to re-lock.');
  }

  global.GXDev = {
    isDev: IS_DEV,
    check: check,
    declareReads: declareReads,
    arm: function () { setArmed(true); },
    disarm: function () { setArmed(false); },
    isArmed: armed,
    reads: function () { return Object.keys(READS).sort(); },
    relayout: adjustLayout        // call by hand if a view swap ever leaves the bar overlapping
  };
})(typeof window !== 'undefined' ? window : this);
