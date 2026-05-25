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
  function renderGoalsSection(data) {
    var goals         = data.goals        || [];
    var computedAt    = data.rollingComputedAt;
    var reportFrom    = data.reportFrom;
    var reportTo      = data.reportTo;
    var yoyFrom       = data.yoyFrom;
    var yoyTo         = data.yoyTo;
    var yoyComputedAt = data.yoyComputedAt;
    var stretch       = parseFloat(data.stretch) || 0;

    var DOW_ORDER = [1,2,3,4,5,6,0]; // Mon first

    function fmtDate(iso) {
      if (!iso) return '—';
      var s = String(iso).slice(0, 10);
      var parts = s.split('-');
      if (parts.length !== 3) return iso;
      return parts[1].replace(/^0/, '') + '-' + parts[2].replace(/^0/, '') + '-' + parts[0].slice(2);
    }

    function fmtDow(val) {
      if (!val) return '—';
      return '$' + Math.round(val).toLocaleString('en-US');
    }

    function fmtGoal(val) {
      if (!val) return '—';
      return '$' + Math.round(val).toLocaleString('en-US');
    }

    // Build stretch options
    var currentStretch = stretch;
    var stretchOpts = '';
    for (var pct = 0; pct <= 5.01; pct += 0.5) {
      var optVal = Math.round(pct * 10) / 1000;
      var optLbl = pct === 0 ? '0% — base' : '+' + pct.toFixed(1) + '%';
      var sel    = Math.abs(currentStretch - optVal) < 0.0001 ? ' selected' : '';
      stretchOpts += '<option value="' + optVal + '"' + sel + '>' + optLbl + '</option>';
    }

    // Meta line
    var metaParts = [];
    if (computedAt)    metaParts.push('Rolling computed ' + fmtDate(computedAt));
    if (yoyComputedAt) metaParts.push('YoY computed ' + fmtDate(yoyComputedAt));
    if (!computedAt && !yoyComputedAt) metaParts.push('Not yet computed — click Recalculate');
    var metaLine = metaParts.join(' · ');

    var reportLine = '';
    if (reportFrom && reportTo)
      reportLine += 'Rolling range: ' + fmtDate(reportFrom) + ' – ' + fmtDate(reportTo);
    if (yoyFrom && yoyTo)
      reportLine += (reportLine ? ' · ' : '') + 'YoY window: ' + fmtDate(yoyFrom) + ' – ' + fmtDate(yoyTo);

    // Current PP from first goal
    var firstGoal  = goals[0] || {};
    var ppRangeStr = (firstGoal.rolling && firstGoal.rolling.ppStart)
      ? 'Current PP: ' + fmtDate(firstGoal.rolling.ppStart) + ' – ' + fmtDate(firstGoal.rolling.ppEnd)
      : '';

    var fullMeta = [ppRangeStr, reportLine, metaLine].filter(Boolean).join(' · ');

    // Table rows
    var rows = goals.map(function(g) {
      var r      = g.rolling      || {};
      var y      = g.yoy          || {};
      var src    = g.activeSource || 'rolling';  // 'rolling' | 'yoy' — whichever is higher
      var mult   = 1 + currentStretch;

      // DOW cells always use the winning (active) goal set
      var activeG  = src === 'yoy' ? y : r;
      var dowCells = DOW_ORDER.map(function(d) {
        var base = (activeG.dowAvg && activeG.dowAvg[d]) ? activeG.dowAvg[d] : 0;
        return '<td class="settings-dow-cell" data-base-dow="' + base + '">'
          + '<div class="settings-dow-val">' + fmtDow(Math.round(base * mult)) + '</div>'
          + '</td>';
      }).join('');

      var rBase = r.ppGoal  || 0;
      var yBase = y.ppGoal  || 0;
      var mBase = activeG.monthly || 0;

      // Stacked baseline cell: Rolling over YoY, winner highlighted green
      var rFmt   = fmtGoal(Math.round(rBase * mult));
      var yFmt   = yBase ? fmtGoal(Math.round(yBase * mult)) : '<span class="settings-dim">—</span>';
      var rStyle = src === 'rolling' ? ' class="settings-active-col"' : ' class="settings-dim"';
      var yStyle = src === 'yoy'     ? ' class="settings-active-col"' : ' class="settings-dim"';
      var baselineCell = '<td class="settings-baseline-cell">'
        + '<div' + rStyle + ' data-base-pp="' + rBase + '"><span class="settings-baseline-label">R</span> ' + rFmt + '</div>'
        + '<div' + yStyle + ' data-base-pp="' + yBase + '"><span class="settings-baseline-label">Y</span> ' + (yBase ? yFmt : '<span class="settings-dim">—</span>') + '</div>'
        + '</td>';

      // Goal PP input — pre-filled with effectivePP (manual if set, else computed active × stretch)
      var overrideVal   = g.effectivePP || Math.round(rBase * mult);
      var overrideInput = '<div class="settings-input-wrap" style="max-width:118px">'
        + '<span class="settings-input-prefix">$</span>'
        + '<input class="settings-input settings-pp-override" type="text" inputmode="numeric"'
        + ' data-slug="' + e(g.slug) + '"'
        + ' value="' + Math.round(overrideVal).toLocaleString('en-US') + '"'
        + (g.hasManual ? ' data-manual="1"' : '')
        + '>'
        + '</div>';

      return '<tr>'
        + '<td class="settings-store-name">' + e(g.name) + '</td>'
        + baselineCell
        + '<td>' + overrideInput + '</td>'
        + '<td class="settings-derived" data-base-monthly="' + mBase + '">'
        + fmtGoal(Math.round(mBase * mult)) + '</td>'
        + dowCells
        + '</tr>';
    }).join('');

    return '<div class="settings-card" id="goalsCard">'
      + '<div class="settings-card-head">'
      +   '<div>'
      +     '<div class="settings-card-title">Revenue Goals &mdash; Current PP</div>'
      +     '<div class="settings-card-sub">Active goal = higher of Rolling 12-PP vs. Year-over-Year (highlighted). Bar never moves backward. Stretch = growth target on top.</div>'
      +     '<div class="settings-goals-meta" id="goalsMeta">' + e(fullMeta) + '</div>'
      +   '</div>'
      +   '<div class="settings-card-actions">'
      +     '<button class="btn-secondary" id="recalcBtn">Recalculate</button>'
      +     '<div class="settings-stretch-group">'
      +       '<label class="settings-stretch-label">Stretch</label>'
      +       '<select class="settings-stretch-select" id="stretchSelect">' + stretchOpts + '</select>'
      +       '<button class="btn-secondary" id="applyStretchBtn">Apply</button>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      + '<div class="settings-table-wrap">'
      + '<table class="settings-table settings-goals-table" id="goalsTable">'
      + '<thead><tr>'
      +   '<th>Store</th>'
      +   '<th title="R = Rolling 12-PP avg · Y = YoY same-season · Green = prevailing">Baseline (R / Y)</th>'
      +   '<th title="Active goal — edit to override">Goal PP</th>'
      +   '<th>Monthly</th>'
      +   '<th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Sat</th><th>Sun</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>'
      + '</div>'
      + '<div class="settings-card-foot">'
      +   '<div class="settings-save-status" id="recalcStatus"></div>'
      +   '<button class="btn-primary" id="saveGoalsBtn">Save Goal Overrides</button>'
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
      +   renderGoalsSection(data)
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

    // Recalculate button (triggers both rolling + YoY)
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
              if (recalcStatus) { recalcStatus.textContent = '✓ Rolling + YoY goals recalculated — reload to see updated values'; recalcStatus.className = 'settings-save-status ok'; }
              if (goalsMeta)   { goalsMeta.textContent = 'Recalculated just now · Reload to see updated values'; }
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

    // Stretch multiplier — live preview + Apply
    var stretchSelect   = document.getElementById('stretchSelect');
    var applyStretchBtn = document.getElementById('applyStretchBtn');

    function applyStretchDisplay() {
      var mult = 1 + (parseFloat(stretchSelect ? stretchSelect.value : 0) || 0);
      document.querySelectorAll('[data-base-pp]').forEach(function(el) {
        var base = parseFloat(el.getAttribute('data-base-pp')) || 0;
        el.textContent = base ? '$' + Math.round(base * mult).toLocaleString('en-US') : '—';
      });
      document.querySelectorAll('[data-base-monthly]').forEach(function(el) {
        var base = parseFloat(el.getAttribute('data-base-monthly')) || 0;
        el.textContent = base ? '$' + Math.round(base * mult).toLocaleString('en-US') : '—';
      });
      document.querySelectorAll('.settings-dow-cell[data-base-dow]').forEach(function(el) {
        var base  = parseFloat(el.getAttribute('data-base-dow')) || 0;
        var inner = el.querySelector('.settings-dow-val');
        if (inner) inner.textContent = base ? '$' + Math.round(base * mult).toLocaleString('en-US') : '—';
      });
    }

    if (stretchSelect) stretchSelect.addEventListener('change', applyStretchDisplay);

    if (applyStretchBtn) {
      applyStretchBtn.addEventListener('click', function() {
        var stretch = parseFloat(stretchSelect ? stretchSelect.value : 0) || 0;
        applyStretchBtn.disabled = true;
        applyStretchBtn.textContent = 'Saving…';
        if (recalcStatus) { recalcStatus.textContent = ''; recalcStatus.className = 'settings-save-status'; }

        GC.api.gasCall('savesettings', { stretch: stretch })
          .then(function(res) {
            applyStretchBtn.disabled = false;
            applyStretchBtn.textContent = 'Apply';
            if (recalcStatus) {
              recalcStatus.textContent = res.ok ? '✓ Stretch saved' : '✗ ' + (res.error || 'Save failed');
              recalcStatus.className   = 'settings-save-status ' + (res.ok ? 'ok' : 'err');
            }
          })
          .catch(function(err) {
            applyStretchBtn.disabled = false;
            applyStretchBtn.textContent = 'Apply';
            if (recalcStatus) { recalcStatus.textContent = '✗ ' + err.message; recalcStatus.className = 'settings-save-status err'; }
          });
      });
    }

    // Save Goal Overrides
    var saveGoalsBtn = document.getElementById('saveGoalsBtn');
    if (saveGoalsBtn) {
      saveGoalsBtn.addEventListener('click', function() {
        var inputs  = document.querySelectorAll('.settings-pp-override');
        var payload = {};
        inputs.forEach(function(inp) {
          var slug = inp.getAttribute('data-slug');
          var raw  = inp.value.replace(/[^0-9.]/g, '');
          var val  = parseFloat(raw);
          if (slug) payload[slug] = (val > 0) ? val : 0;
        });

        saveGoalsBtn.disabled = true;
        saveGoalsBtn.textContent = 'Saving…';
        if (recalcStatus) { recalcStatus.textContent = ''; recalcStatus.className = 'settings-save-status'; }

        GC.api.gasCall('savemanualgoals', { goals: JSON.stringify(payload) })
          .then(function(res) {
            saveGoalsBtn.disabled = false;
            saveGoalsBtn.textContent = 'Save Goal Overrides';
            if (recalcStatus) {
              recalcStatus.textContent = res.ok ? '✓ Goal overrides saved' : '✗ ' + (res.error || 'Save failed');
              recalcStatus.className   = 'settings-save-status ' + (res.ok ? 'ok' : 'err');
            }
          })
          .catch(function(err) {
            saveGoalsBtn.disabled = false;
            saveGoalsBtn.textContent = 'Save Goal Overrides';
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
