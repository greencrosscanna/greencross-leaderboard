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
      + '<button class="btn-ghost settings-back" id="settingsBack">← Back</button>'
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
    // Accumulate totals for the tfoot row
    var mult    = 1 + currentStretch;   // hoisted — used in rows AND totalRow
    var totBase = 0, totMonthly = 0;
    var totDow  = { Mon:0, Tue:0, Wed:0, Thu:0, Fri:0, Sat:0, Sun:0 };

    var rows = goals.map(function(g) {
      var r      = g.rolling      || {};
      var y      = g.yoy          || {};
      var src    = g.activeSource || 'rolling';  // 'rolling' | 'yoy' — whichever is higher
      // mult is in outer scope

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
      // data-base-pp on inner <span> so textContent updates don't clobber the label span
      var baselineCell = '<td class="settings-baseline-cell">'
        + '<div' + rStyle + '><span class="settings-baseline-label">R</span><span data-base-pp="' + rBase + '">' + rFmt + '</span></div>'
        + '<div' + yStyle + '><span class="settings-baseline-label">Y</span><span data-base-pp="' + yBase + '">' + (yBase ? yFmt : '<span class="settings-dim">—</span>') + '</span></div>'
        + '</td>';

      // Goal PP input — pre-filled with effectivePP (manual if set, else computed active × stretch)
      // data-base-computed-pp = unscaled computed active PP (pre-stretch, pre-override) for scaling monthly/DOW live
      var computedBasePP = (g.active && g.active.ppGoal) ? g.active.ppGoal : (rBase || yBase);
      var overrideVal    = g.effectivePP || Math.round(computedBasePP * mult);
      var overrideInput  = '<div class="settings-input-wrap" style="max-width:100px">'
        + '<span class="settings-input-prefix">$</span>'
        + '<input class="settings-input settings-pp-override" type="text" inputmode="numeric"'
        + ' data-slug="' + e(g.slug) + '"'
        + ' data-base-computed-pp="' + computedBasePP + '"'
        + ' value="' + Math.round(overrideVal).toLocaleString('en-US') + '"'
        + (g.hasManual ? ' data-manual="1"' : '')
        + '>'
        + '</div>';

      // Accumulate for totals row
      var computedBasePP2 = (g.active && g.active.ppGoal) ? g.active.ppGoal : (rBase || yBase);
      totBase    += computedBasePP2;
      totMonthly += mBase;
      DOW_ORDER.forEach(function(d) {
        totDow[d] = (totDow[d] || 0) + ((activeG.dowAvg && activeG.dowAvg[d]) ? activeG.dowAvg[d] : 0);
      });

      return '<tr>'
        + '<td class="settings-store-name">' + e(g.name) + '</td>'
        + baselineCell
        + '<td>' + overrideInput + '</td>'
        + '<td class="settings-derived" data-base-monthly="' + mBase + '">'
        + fmtGoal(Math.round(mBase * mult)) + '</td>'
        + dowCells
        + '</tr>';
    }).join('');

    // Total footer row
    var totDowCells = DOW_ORDER.map(function(d) {
      var base = totDow[d] || 0;
      return '<td class="settings-dow-cell settings-total-dow" data-base-dow="' + base + '">'
        + '<div class="settings-dow-val">' + fmtDow(Math.round(base * mult)) + '</div>'
        + '</td>';
    }).join('');

    var totalRow = '<tr class="settings-total-row">'
      + '<td class="settings-store-name">Total</td>'
      + '<td class="settings-baseline-cell">'
      +   '<div><span data-base-pp="' + totBase + '">' + fmtGoal(Math.round(totBase * mult)) + '</span></div>'
      + '</td>'
      + '<td id="goalsTotalPP" class="settings-total-pp">' + fmtGoal(Math.round(totBase * mult)) + '</td>'
      + '<td class="settings-derived settings-total-monthly" data-base-monthly="' + totMonthly + '">'
      +   fmtGoal(Math.round(totMonthly * mult))
      + '</td>'
      + totDowCells
      + '</tr>';

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
      +   '<th title="R = Rolling 12-PP avg · Y = YoY same-season · Green = prevailing">Baseline</th>'
      +   '<th title="Active goal — edit to override">Goal PP</th>'
      +   '<th>Monthly</th>'
      +   '<th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Sat</th><th>Sun</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '<tfoot>' + totalRow + '</tfoot>'
      + '</table>'
      + '</div>'
      + '<div class="settings-card-foot">'
      +   '<div class="settings-save-status" id="recalcStatus"></div>'
      +   '<button class="btn-primary" id="saveGoalsBtn">Save Goal Overrides</button>'
      + '</div>'
      + '</div>';
  }

  // ── Shared: build a table row for one employee ────────────
  function empRow(emp, nicknames, avatarConfigs, showNick, excludedSet) {
    var nick   = (nicknames || {})[emp.key] || '';
    var config = (avatarConfigs || {})[emp.key] || null;
    if (!config) {
      var _segs = emp.key.split('_');
      for (var _si = 0; _si < _segs.length; _si++) {
        if ((avatarConfigs || {})[_segs[_si]]) { config = (avatarConfigs || {})[_segs[_si]]; break; }
      }
    }
    var nameParts = (emp.name || '').split(' ');
    var initials  = (nameParts[0] || '').slice(0, 1)
                  + (nameParts.length > 1 ? nameParts[nameParts.length - 1].slice(0, 1) : '');
    var puck      = GC.lbAvaPuck(emp.key, config, emp.initials || initials || '??', true);
    var encKey    = e(emp.key);
    var isExcluded = excludedSet && excludedSet[emp.key];
    var rowCls    = isExcluded ? ' class="emp-row-excluded"' : '';
    return '<tr' + rowCls + '>'
      + '<td class="settings-emp-ava" title="Click to edit avatar">' + puck + '</td>'
      + '<td class="settings-emp-name">' + e(emp.name) + '</td>'
      + (showNick
          ? '<td><input class="settings-input settings-nick-input"'
            +   ' type="text" data-key="' + encKey + '"'
            +   ' value="' + e(nick) + '" placeholder="Nickname"></td>'
            + '<td class="settings-emp-store">' + e(emp.store || '') + '</td>'
            + '<td class="settings-emp-excl">'
            +   '<button class="excl-toggle' + (isExcluded ? ' excluded' : '') + '"'
            +           ' data-key="' + encKey + '"'
            +           ' title="' + (isExcluded ? 'Re-activate employee' : 'Exclude from dashboard') + '">'
            +     (isExcluded ? 'Excluded' : 'Active')
            +   '</button>'
            + '</td>'
          : '<td colspan="3" class="settings-emp-store" style="color:var(--text-dim);font-size:12px">Director</td>'
        )
      + '</tr>';
  }

  // ── Management card ────────────────────────────────────────
  function renderManagement(employees, avatarConfigs) {
    var mgmt = (employees || []).filter(function(e) { return e.section === 'management'; });
    if (!mgmt.length) return '';
    var rows = mgmt.map(function(emp) { return empRow(emp, {}, avatarConfigs, false); }).join('');
    return '<div class="settings-card" id="mgmtCard">'
      + '<div class="settings-card-head">'
      +   '<div>'
      +     '<div class="settings-card-title">Management</div>'
      +     '<div class="settings-card-sub">Directors — click an avatar to customize.</div>'
      +   '</div>'
      + '</div>'
      + '<table class="settings-table settings-emp-table">'
      + '<thead><tr><th></th><th>Name</th><th colspan="2">Role</th></tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>'
      + '</div>';
  }

  // ── Employees card (nicknames + avatars combined) ─────────
  function renderEmployees(employees, nicknames, avatarConfigs, excluded) {
    nicknames     = nicknames     || {};
    avatarConfigs = avatarConfigs || {};
    // excluded is an array of keys from GAS — convert to a set-like object for fast lookup
    var excludedSet = {};
    (excluded || []).forEach(function(k) { excludedSet[k] = true; });
    var staff = (employees || []).filter(function(emp) { return emp.section !== 'management'; });
    var rows  = staff.map(function(emp) { return empRow(emp, nicknames, avatarConfigs, true, excludedSet); }).join('');

    return '<div class="settings-card" id="nickCard">'
      + '<div class="settings-card-head">'
      +   '<div>'
      +     '<div class="settings-card-title">Employees</div>'
      +     '<div class="settings-card-sub">Set a nickname and build an avatar. Toggle <strong>Active/Excluded</strong> to show or hide an employee on the dashboard.</div>'
      +   '</div>'
      + '</div>'
      + '<table class="settings-table settings-emp-table" id="nickTable">'
      + '<thead><tr>'
      +   '<th></th><th>Dutchie Name</th><th>Nickname</th><th>Store</th><th>Status</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>'
      + '<div class="settings-card-foot">'
      +   '<div class="settings-save-status" id="nickStatus"></div>'
      +   '<button class="btn-primary" id="saveNicksBtn">Save</button>'
      + '</div>'
      + '</div>';
  }

  // ── Full page render ──────────────────────────────────────
  function render(data) {
    return '<div class="app-page settings-page">'
      + renderHeader()
      + '<div class="settings-body">'
      +   renderGoalsSection(data)
      +   renderManagement(data.employees, data.avatarConfigs)
      +   renderEmployees(data.employees, data.nicknames, data.avatarConfigs, data.excluded)
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
      var mult = 1 + (parseFloat((stretchSelect && stretchSelect.value) || 0) || 0);

      // Baseline PP spans (Rolling / YoY) — pure stretch, no override involved
      document.querySelectorAll('[data-base-pp]').forEach(function(el) {
        var base = parseFloat(el.getAttribute('data-base-pp')) || 0;
        el.textContent = base ? '$' + Math.round(base * mult).toLocaleString('en-US') : '—';
      });

      // Monthly + DOW — per-row, scaled by override when one is set
      document.querySelectorAll('#goalsTable tbody tr').forEach(function(row) {
        var inp        = row.querySelector('.settings-pp-override');
        var computedPP = inp ? (parseFloat(inp.getAttribute('data-base-computed-pp')) || 0) : 0;
        var hasManual  = inp && inp.getAttribute('data-manual') === '1';

        // If no manual override, recalculate the PP input itself from base × stretch
        if (inp && !hasManual && computedPP) {
          inp.value = Math.round(computedPP * mult).toLocaleString('en-US');
        }

        var rawVal     = inp ? (inp.value || '').replace(/[^0-9.]/g, '') : '';
        var overrideVal = rawVal ? parseFloat(rawVal) : NaN;

        // scale = ratio of override final goal to what computed final goal would be
        // When no override, overrideVal ≈ computedPP * mult → scale = 1
        var scale = (overrideVal > 0 && computedPP > 0)
          ? overrideVal / (computedPP * mult)
          : 1;

        var monthlyEl = row.querySelector('[data-base-monthly]');
        if (monthlyEl) {
          var base = parseFloat(monthlyEl.getAttribute('data-base-monthly')) || 0;
          monthlyEl.textContent = base ? '$' + Math.round(base * mult * scale).toLocaleString('en-US') : '—';
        }

        row.querySelectorAll('.settings-dow-cell[data-base-dow]').forEach(function(el) {
          var base  = parseFloat(el.getAttribute('data-base-dow')) || 0;
          var inner = el.querySelector('.settings-dow-val');
          if (inner) inner.textContent = base ? '$' + Math.round(base * mult * scale).toLocaleString('en-US') : '—';
        });
      });

      // Update total PP cell — live sum of all PP override input values
      var totalPPEl = document.getElementById('goalsTotalPP');
      if (totalPPEl) {
        var ppSum = 0;
        document.querySelectorAll('.settings-pp-override').forEach(function(inp) {
          ppSum += parseFloat((inp.value || '').replace(/[^0-9.]/g, '')) || 0;
        });
        totalPPEl.textContent = ppSum ? '$' + Math.round(ppSum).toLocaleString('en-US') : '—';
      }

      // Update total monthly and DOW cells in tfoot (same data-attribute pattern as tbody)
      var tfoot = document.querySelector('#goalsTable tfoot');
      if (tfoot) {
        var mTot = tfoot.querySelector('[data-base-monthly]');
        if (mTot) {
          var mBase2 = parseFloat(mTot.getAttribute('data-base-monthly')) || 0;
          mTot.textContent = mBase2 ? '$' + Math.round(mBase2 * mult).toLocaleString('en-US') : '—';
        }
        tfoot.querySelectorAll('.settings-dow-cell[data-base-dow]').forEach(function(el) {
          var base  = parseFloat(el.getAttribute('data-base-dow')) || 0;
          var inner = el.querySelector('.settings-dow-val');
          if (inner) inner.textContent = base ? '$' + Math.round(base * mult).toLocaleString('en-US') : '—';
        });
        var bTot = tfoot.querySelector('[data-base-pp]');
        if (bTot) {
          var bBase = parseFloat(bTot.getAttribute('data-base-pp')) || 0;
          bTot.textContent = bBase ? '$' + Math.round(bBase * mult).toLocaleString('en-US') : '—';
        }
      }
    }

    // Auto-save stretch when dropdown changes, then refresh display
    if (stretchSelect) stretchSelect.addEventListener('change', function() {
      applyStretchDisplay();
      var stretch = parseFloat(stretchSelect.value) || 0;
      if (applyStretchBtn) { applyStretchBtn.disabled = true; applyStretchBtn.textContent = 'Saving…'; }
      if (recalcStatus) { recalcStatus.textContent = ''; recalcStatus.className = 'settings-save-status'; }
      GC.api.gasCall('savesettings', { stretch: stretch })
        .then(function(res) {
          if (applyStretchBtn) { applyStretchBtn.disabled = false; applyStretchBtn.textContent = 'Apply'; }
          if (recalcStatus) {
            recalcStatus.textContent = res.ok ? '✓ Saved' : '✗ ' + (res.error || 'Save failed');
            recalcStatus.className   = 'settings-save-status ' + (res.ok ? 'ok' : 'err');
          }
        })
        .catch(function(err) {
          if (applyStretchBtn) { applyStretchBtn.disabled = false; applyStretchBtn.textContent = 'Apply'; }
          if (recalcStatus) { recalcStatus.textContent = '✗ ' + err.message; recalcStatus.className = 'settings-save-status err'; }
        });
    });

    // Live-update monthly + DOW when override input changes
    document.querySelectorAll('.settings-pp-override').forEach(function(inp) {
      inp.addEventListener('input', applyStretchDisplay);
    });

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

    // Exclude toggle — live toggle, saved with the Save button
    var nickTable = document.getElementById('nickTable');
    if (nickTable) {
      nickTable.addEventListener('click', function(evt) {
        var btn = evt.target.closest('.excl-toggle');
        if (!btn) return;
        var isExcluded = btn.classList.toggle('excluded');
        btn.textContent = isExcluded ? 'Excluded' : 'Active';
        btn.title       = isExcluded ? 'Re-activate employee' : 'Exclude from dashboard';
        var row = btn.closest('tr');
        if (row) row.classList.toggle('emp-row-excluded', isExcluded);
      });
    }

    // Save nicknames + excluded state
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

        var excluded = [];
        document.querySelectorAll('#nickTable .excl-toggle.excluded').forEach(function(btn) {
          excluded.push(btn.dataset.key);
        });

        saveNicksBtn.disabled = true;
        saveNicksBtn.textContent = 'Saving…';
        nickStatus.textContent = '';
        nickStatus.className = 'settings-save-status';

        GC.api.saveSettings(null, nicknames, excluded)
          .then(function(res) {
            saveNicksBtn.disabled = false;
            saveNicksBtn.textContent = 'Save';
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
            saveNicksBtn.textContent = 'Save';
            nickStatus.textContent = '✗ ' + err.message;
            nickStatus.className = 'settings-save-status err';
          });
      });
    }

    // Apply override scaling once on load so saved overrides are reflected immediately
    applyStretchDisplay();
  }

  return { render: render, renderLoading: renderLoading, renderError: renderError, init: init };
})();
