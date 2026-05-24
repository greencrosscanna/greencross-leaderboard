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

  // ── Plan Targets section ───────────────────────────────────
  function renderPlanTargets(plans) {
    var rows = (plans || []).map(function(p) {
      return '<tr>'
        + '<td class="settings-store-name">' + e(p.name) + '</td>'
        + '<td><div class="settings-input-wrap">'
        +   '<span class="settings-input-prefix">$</span>'
        +   '<input class="settings-input" type="number" min="0" step="100"'
        +     ' data-slug="' + e(p.slug) + '" value="' + e(p.daily || '') + '"'
        +     ' placeholder="0">'
        + '</div></td>'
        + '<td class="settings-derived" data-pp="' + e(p.slug) + '">'  + (p.pp      ? fmt(p.pp)      : '—') + '</td>'
        + '<td class="settings-derived" data-mo="' + e(p.slug) + '">'  + (p.monthly ? fmt(p.monthly) : '—') + '</td>'
        + '</tr>';
    }).join('');

    return '<div class="settings-card" id="planCard">'
      + '<div class="settings-card-head">'
      +   '<div>'
      +     '<div class="settings-card-title">Store Plan Targets</div>'
      +     '<div class="settings-card-sub">Set each store\'s daily goal. Pay-period (×14) and monthly (×30.4) values update automatically.</div>'
      +   '</div>'
      + '</div>'
      + '<table class="settings-table" id="planTable">'
      + '<thead><tr>'
      +   '<th>Store</th><th>Daily Goal</th><th>Pay Period</th><th>Monthly</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>'
      + '<div class="settings-card-foot">'
      +   '<div class="settings-save-status" id="planStatus"></div>'
      +   '<button class="btn-primary" id="savePlansBtn">Save Targets</button>'
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
      +   renderPlanTargets(data.plans)
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

    // Plan inputs — update derived cells on keyup
    var planTable = document.getElementById('planTable');
    if (planTable) {
      planTable.addEventListener('input', function(ev) {
        var input = ev.target.closest('input[data-slug]');
        if (!input) return;
        var slug  = input.dataset.slug;
        var daily = Math.round(Number(input.value) || 0);
        var ppEl  = document.querySelector('[data-pp="' + slug + '"]');
        var moEl  = document.querySelector('[data-mo="' + slug + '"]');
        if (ppEl) ppEl.textContent = daily ? fmt(daily * 14)   : '—';
        if (moEl) moEl.textContent = daily ? fmt(daily * 30.4) : '—';
      });
    }

    // Save plan targets
    var savePlansBtn = document.getElementById('savePlansBtn');
    var planStatus   = document.getElementById('planStatus');
    if (savePlansBtn) {
      savePlansBtn.addEventListener('click', function() {
        var inputs = document.querySelectorAll('#planTable input[data-slug]');
        var plans  = [];
        inputs.forEach(function(inp) {
          plans.push({ slug: inp.dataset.slug, daily: Number(inp.value) || 0 });
        });

        savePlansBtn.disabled = true;
        savePlansBtn.textContent = 'Saving…';
        planStatus.textContent = '';
        planStatus.className = 'settings-save-status';

        GC.api.saveSettings(plans, null)
          .then(function(res) {
            savePlansBtn.disabled = false;
            savePlansBtn.textContent = 'Save Targets';
            if (res.ok) {
              planStatus.textContent = '✓ Saved';
              planStatus.className = 'settings-save-status ok';
            } else {
              planStatus.textContent = '✗ ' + (res.error || 'Save failed');
              planStatus.className = 'settings-save-status err';
            }
          })
          .catch(function(err) {
            savePlansBtn.disabled = false;
            savePlansBtn.textContent = 'Save Targets';
            planStatus.textContent = '✗ ' + err.message;
            planStatus.className = 'settings-save-status err';
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
