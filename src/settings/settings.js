// ============================================================
//  Green Cross — Settings View
//  Route: #/settings (director/owner only)
//
//  Two sections:
//    1. Store Plan Targets — daily goal per store; PP + monthly auto-computed
//    2. Employee Nicknames — map Dutchie full names to preferred display names
// ============================================================

window.GC = window.GC || {};

GC.views.renderSettings = function() {
  var app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = settings.renderLoading();

  GC.api.fetchSettings()
    .then(function(data) {
      app.innerHTML = settings.render(data);
      settings.init(data);
    })
    .catch(function(err) {
      app.innerHTML = settings.renderError(err.message);
    });
};

var settings = (function() {

  function e(s) { return GC.esc(String(s || '')); }

  function fmt(n) {
    return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  // ── Loading ───────────────────────────────────────────────
  function renderLoading() {
    return '<div class="app-page settings-page">'
      + renderHeader()
      + '<div class="settings-loading">Loading settings…</div>'
      + '</div>';
  }

  // ── Error ─────────────────────────────────────────────────
  function renderError(msg) {
    return '<div class="app-page settings-page">'
      + renderHeader()
      + '<div class="settings-error">⚠️ ' + e(msg) + '</div>'
      + '</div>';
  }

  // ── Header ────────────────────────────────────────────────
  function renderHeader() {
    return '<header class="settings-header">'
      + '<button class="btn-ghost settings-back" id="settingsBack">← Director</button>'
      + '<h1 class="settings-title">Settings</h1>'
      + '</header>';
  }

  // ── Goals section (auto-computed, read-only) ───────────────
  function renderGoalsSection(goals, computedAt, reportFrom, reportTo) {
    var DOW_ORDER = [1,2,3,4,5,6,0]; // Mon first
    var DOW_LABELS = {0:'Sun',1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat'};

    function fmtDate(iso) {
      if (!iso) return '—';
      // Accept both ISO timestamps and YYYY-MM-DD strings
      var s = String(iso).slice(0, 10); // take YYYY-MM-DD portion
      var parts = s.split('-');
      if (parts.length !== 3) return iso;
      return parts[1].replace(/^0/, '') + '-' + parts[2].replace(/^0/, '') + '-' + parts[0].slice(2);
    }

    function fmtDow(val) {
      if (!val) return '—';
      return '$' + Math.round(val).toLocaleString('en-US');
    }

    var rows = (goals || []).map(function(g) {
      var dowCells = DOW_ORDER.map(function(d) {
        var val = g.dowAvg && g.dowAvg[d] ? g.dowAvg[d] : 0;
        return '<td class="settings-dow-cell">'
          + '<div class="settings-dow-lbl">' + DOW_LABELS[d] + '</div>'
          + '<div class="settings-dow-val">' + fmtDow(val) + '</div>'
          + '</td>';
      }).join('');
      return '<tr>'
        + '<td class="settings-store-name">' + e(g.name) + '</td>'
        + '<td class="settings-derived">' + (g.ppGoal  ? fmt(g.ppGoal)  : '—') + '</td>'
        + '<td class="settings-derived">' + (g.monthly ? fmt(g.monthly) : '—') + '</td>'
        + dowCells
        + '<td class="settings-pp-range">'
        +   (g.ppStart ? fmtDate(g.ppStart) + ' – ' + fmtDate(g.ppEnd) : '—')
        + '</td>'
        + '</tr>';
    }).join('');

    var rangeStr = (reportFrom && reportTo)
      ? 'Report range: ' + fmtDate(reportFrom) + ' to ' + fmtDate(reportTo) + ' · '
      : '';
    var metaLine = computedAt
      ? rangeStr + 'Computed ' + fmtDate(computedAt) + ' · Updates at each new pay period'
      : 'Not yet computed — click Recalculate to fetch from Dutchie';

    return '<div class="settings-card" id="goalsCard">'
      + '<div class="settings-card-head">'
      +   '<div>'
      +     '<div class="settings-card-title">Revenue Goals</div>'
      +     '<div class="settings-card-sub">Auto-computed from last 12 pay periods. Daily goals are day-of-week averages (last 24 occurrences).</div>'
      +   '</div>'
      +   '<button class="btn-secondary" id="recalcBtn">Recalculate</button>'
      + '</div>'
      + '<div class="settings-goals-meta" id="goalsMeta">' + e(metaLine) + '</div>'
      + '<div class="settings-table-wrap">'
      + '<table class="settings-table settings-goals-table" id="goalsTable">'
      + '<thead><tr>'
      +   '<th>Store</th><th>Pay Period</th><th>Monthly</th>'
      +   '<th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Sat</th><th>Sun</th>'
      +   '<th>Current PP</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>'
      + '</div>'
      + '<div class="settings-card-foot">'
      +   '<div class="settings-save-status" id="recalcStatus"></div>'
      + '</div>'
      + '</div>';
  }

  // ── Nickname section ──────────────────────────────────────
  function renderNicknames(employees, nicknames) {
    var rows = (employees || []).map(function(emp) {
      var nick = (nicknames || {})[emp.key] || '';
      return '<tr>'
        + '<td class="settings-emp-name">' + e(emp.name) + '</td>'
        + '<td><input class="settings-input settings-nick-input"'
        +   ' type="text" data-key="' + e(emp.key) + '"'
        +   ' value="' + e(nick) + '" placeholder="Same as Dutchie name"></td>'
        + '<td class="settings-emp-store">' + e(emp.store) + '</td>'
        + '</tr>';
    }).join('');

    return '<div class="settings-card" id="nickCard">'
      + '<div class="settings-card-head">'
      +   '<div>'
      +     '<div class="settings-card-title">Employee Nicknames</div>'
      +     '<div class="settings-card-sub">Map Dutchie full names to preferred display names — e.g. Zachary → Zach. Leave blank to use the Dutchie name.</div>'
      +   '</div>'
      + '</div>'
      + '<table class="settings-table" id="nickTable">'
      + '<thead><tr>'
      +   '<th>Full Name (Dutchie)</th><th>Nickname</th><th>Store</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>'
      + '<div class="settings-card-foot">'
      +   '<div class="settings-save-status" id="nickStatus"></div>'
      +   '<button class="btn-primary" id="saveNicksBtn">Save Nicknames</button>'
      + '</div>'
      + '</div>';
  }

  // ── Full page render ──────────────────────────────────────
  function render(data) {
    return '<div class="app-page settings-page">'
      + renderHeader()
      + '<div class="settings-body">'
      +   renderGoalsSection(data.goals, data.computedAt, data.reportFrom, data.reportTo)
      +   renderNicknames(data.employees, data.nicknames)
      + '</div>'
      + '</div>';
  }

  // ── Init ──────────────────────────────────────────────────
  function init(data) {

    // Back button
    var back = document.getElementById('settingsBack');
    if (back) back.addEventListener('click', function() {
      GC.router.navigate('#/director');
    });

    // Recalculate goals button
    var recalcBtn    = document.getElementById('recalcBtn');
    var recalcStatus = document.getElementById('recalcStatus');
    var goalsMeta    = document.getElementById('goalsMeta');
    if (recalcBtn) {
      recalcBtn.addEventListener('click', function() {
        recalcBtn.disabled = true;
        recalcBtn.textContent = 'Recalculating…';
        if (recalcStatus) { recalcStatus.textContent = ''; recalcStatus.className = 'settings-save-status'; }

        GC.api.gasCall('recalculategoals', {})
          .then(function(res) {
            recalcBtn.disabled = false;
            recalcBtn.textContent = 'Recalculate';
            if (res.ok) {
              if (recalcStatus) { recalcStatus.textContent = '✓ Goals recalculated — reload to see updated values'; recalcStatus.className = 'settings-save-status ok'; }
              if (goalsMeta) { goalsMeta.textContent = 'Recalculated just now · Reload to see updated values'; }
            } else {
              if (recalcStatus) { recalcStatus.textContent = '✗ ' + (res.error || 'Recalculation failed'); recalcStatus.className = 'settings-save-status err'; }
            }
          })
          .catch(function(err) {
            recalcBtn.disabled = false;
            recalcBtn.textContent = 'Recalculate';
            if (recalcStatus) { recalcStatus.textContent = '✗ ' + err.message; recalcStatus.className = 'settings-save-status err'; }
          });
      });
    }

    // Save nicknames
    var saveNicksBtn = document.getElementById('saveNicksBtn');
    var nickStatus   = document.getElementById('nickStatus');
    if (saveNicksBtn) {
      saveNicksBtn.addEventListener('click', function() {
        var inputs    = document.querySelectorAll('#nickTable input[data-key]');
        var nicknames = {};
        inputs.forEach(function(inp) {
          var val = inp.value.trim();
          if (val) nicknames[inp.dataset.key] = val;
        });

        saveNicksBtn.disabled = true;
        saveNicksBtn.textContent = 'Saving…';
        nickStatus.textContent = '';
        nickStatus.className = 'settings-save-status';

        GC.api.saveSettings(null, nicknames)
          .then(function(res) {
            saveNicksBtn.disabled = false;
            saveNicksBtn.textContent = 'Save Nicknames';
            if (res.ok) {
              nickStatus.textContent = '✓ Saved';
              nickStatus.className = 'settings-save-status ok';
            } else {
              nickStatus.textContent = '✗ ' + (res.error || 'Save failed');
              nickStatus.className = 'settings-save-status err';
            }
          })
          .catch(function(err) {
            saveNicksBtn.disabled = false;
            saveNicksBtn.textContent = 'Save Nicknames';
            nickStatus.textContent = '✗ ' + err.message;
            nickStatus.className = 'settings-save-status err';
          });
      });
    }
  }

  return { render: render, renderLoading: renderLoading, renderError: renderError, init: init };
})();
