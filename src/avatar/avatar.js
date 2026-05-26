// ============================================================
//  Green Cross — Avatar Picker View
//  Route: #/avatar?employee=<nameKey>
//
//  Lets any authenticated user build and save a DiceBear
//  Avataaars avatar for a given employee nameKey.
// ============================================================

window.GC = window.GC || {};

GC.views.renderAvatar = function(queryParams) {
  var app = document.getElementById('app');
  if (!app) return;
  var nameKey = (queryParams && queryParams.employee) || '';

  app.innerHTML = ava.renderLoading(nameKey);

  GC.api.fetchAvatarData()
    .then(function(data) {
      var emp = (data.employees || []).filter(function(e) { return e.key === nameKey; })[0];
      if (!emp) {
        // Employee is in live transaction data but not yet in the synced roster.
        // Build a minimal record from the nameKey so the picker still works.
        var displayName = nameKey.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
        emp = { key: nameKey, name: displayName, store: '' };
      }
      // Configs may be stored under a short display-name key (e.g. "sunshine") while
      // the roster/URL key uses the full name ("maria_sunshine"). Try exact match first,
      // then each name segment so any position can match.
      var _rawCfgs = data.avatarConfigs || {};
      var savedConfig = _rawCfgs[nameKey] || null;
      if (!savedConfig) {
        var _segs = nameKey.split('_');
        for (var _si = 0; _si < _segs.length; _si++) {
          if (_rawCfgs[_segs[_si]]) { savedConfig = _rawCfgs[_segs[_si]]; break; }
        }
      }
      app.innerHTML = ava.render(emp, savedConfig);
      ava.init(emp, queryParams);
    })
    .catch(function(err) {
      app.innerHTML = ava.renderError(err.message);
      ava.initBack(queryParams);
    });
};

var ava = (function() {

  // ── Options (DiceBear Avataaars v9 — curated) ─────────────
  var OPTIONS = {
    skinColor:    ['ffdbb4','f8d25c','fd9841','edb98a','d08b5b','ae5d29','614335'],
    top: [
      '_none','hat','winterHat1',
      'bigHair','bob','bun','curly','curvy','dreads','dreads01','dreads02','frida','frizzle','fro','froBand','longButNotTooLong','miaWallace','shaggy','shaggyMullet','shavedSides','shortCurly','shortFlat','shortRound','shortWaved','sides','straight01','straight02','straightAndStrand','theCaesar','theCaesarAndSidePart'
    ],
    hairColor:    ['2c1b18','4a312c','724133','a55728','b58143','c93305','d6b370','e8e1e1','ecdcbf','f59797'],
    eyes:         ['default','eyeRoll','happy','hearts','side','squint','surprised','wink'],
    eyebrows:     ['default','defaultNatural','flatNatural','frownNatural','raisedExcited','raisedExcitedNatural','upDown','upDownNatural'],
    mouth:        ['default','smile','twinkle','tongue','serious','disbelief'],
    facialHair:        ['_none','beardLight','beardMajestic','beardMedium','moustacheFancy','moustacheMagnum'],
    facialHairColor:   ['2c1b18','4a312c','724133','a55728','b58143','c93305','d6b370','e8e1e1','ecdcbf','f59797'],
    clothing:     ['blazerAndShirt','blazerAndSweater','collarAndSweater','graphicShirt','hoodie','shirtCrewNeck','shirtScoopNeck','shirtVNeck'],
    clothesColor: ['3c4f5c','65c9ff','262e33','5199e4','25557c','929598','a7ffc4','b1e2ff','e6e6e6','ff5c5c','ff488e','ffafb9','ffdeb5','ffffb1','ffffff'],
    accessories:  ['_none','prescription01','prescription02','round','sunglasses','wayfarers'],
    accessoriesColor: ['3c4f5c','65c9ff','262e33','5199e4','25557c','929598','a7ffc4','b1e2ff','e6e6e6','ff5c5c','ff488e','ffafb9','ffdeb5','ffffb1','ffffff']
  };

  var DEFAULT_CONFIG = {
    skinColor: 'f8d25c', top: '_none', hairColor: '2c1b18',
    eyes: 'wink', eyebrows: 'upDown', mouth: 'default',
    facialHair: '_none', facialHairColor: '2c1b18',
    clothing: 'shirtCrewNeck', clothesColor: '929598',
    accessories: '_none', accessoriesColor: '3c4f5c'
  };

  function humanize(s) {
    if (s === '_none') return 'None';
    return s.replace(/([A-Z])/g, ' $1').replace(/^./, function(c) { return c.toUpperCase(); }).replace(/(\d+)/, ' $1').trim();
  }

  function e(s) { return GC.esc ? GC.esc(String(s || '')) : String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ── Loading / Error / Not Found ────────────────────────────
  function renderLoading(nameKey) {
    return '<div class="app-page avatar-page">'
      + renderHeader('…')
      + '<div style="padding:40px 24px;color:var(--text-dim,#a8aba6)">Loading…</div>'
      + '</div>';
  }

  function renderError(msg) {
    return '<div class="app-page avatar-page">'
      + renderHeader('Error')
      + '<div style="padding:40px 24px;color:#ef4444">Error: ' + e(msg) + '</div>'
      + '</div>';
  }

  function renderNotFound(nameKey) {
    return '<div class="app-page avatar-page">'
      + renderHeader('Not Found')
      + '<div style="padding:40px 24px;color:var(--text-dim,#a8aba6)">Employee <strong>' + e(nameKey) + '</strong> not found. <button id="avatarBack" class="ava-back">← Back to Settings</button></div>'
      + '</div>';
  }

  // ── Header ─────────────────────────────────────────────────
  function renderHeader(empName) {
    return '<header class="avatar-header">'
      + '<button id="avatarBack" class="ava-back">← Back</button>'
      + '<h1>Build your avatar</h1>'
      + '<div class="avatar-crumb">' + e(empName) + ' · Avatar</div>'
      + '</header>';
  }

  // ── Main render ────────────────────────────────────────────
  function render(emp, savedConfig) {
    var firstName = (emp.name || '').split(' ')[0] || emp.name;

    return '<div class="app-page avatar-page">'
      + renderHeader(emp.name)
      + '<div class="avatar-grid">'

      // LEFT: preview card
      + '<div class="avatar-preview card">'
      +   '<h3>Preview</h3>'
      +   '<div class="avatar-frame">'
      +     '<img id="avaImg" alt="' + e(emp.name) + ' avatar">'
      +   '</div>'
      +   '<div class="avatar-actions">'
      +     '<button id="avaRandom" class="ava-btn">↻ Surprise me</button>'
      +     '<button id="avaSave" class="ava-btn primary">Save</button>'
      +   '</div>'
      +   (savedConfig ? '<div class="ava-clear-wrap"><button id="avaClear" class="ava-clear">Remove avatar — revert to initials</button></div>' : '')
      +   '<div class="ava-lb-preview">'
      +     '<h4>How it\'ll look on the leaderboard</h4>'
      +     '<div class="ava-lb-row">'
      +       '<div class="ava-lb-rank">1</div>'
      +       '<div class="lb-ava"><img src="https://api.dicebear.com/9.x/avataaars/svg?seed=Jordan&skinColor=edb98a&top=straight01&hairColor=2c1b18&clothing=hoodie&clothesColor=ff5c5c&accessoriesProbability=0&facialHairProbability=0" alt=""></div>'
      +       '<div class="ava-lb-name">Jordan M.</div>'
      +       '<div class="ava-lb-val">$4,820</div>'
      +     '</div>'
      +     '<div class="ava-lb-row you">'
      +       '<div class="ava-lb-rank">2</div>'
      +       '<div class="lb-ava"><img id="avaImgLb" alt=""></div>'
      +       '<div class="ava-lb-name">' + e(firstName) + '</div>'
      +       '<div class="ava-lb-val">$4,210</div>'
      +     '</div>'
      +     '<div class="ava-lb-row">'
      +       '<div class="ava-lb-rank">3</div>'
      +       '<div class="lb-ava initials">DT</div>'
      +       '<div class="ava-lb-name">Devon T.</div>'
      +       '<div class="ava-lb-val">$3,945</div>'
      +     '</div>'
      +   '</div>'
      + '</div>'

      // RIGHT: controls card
      + '<div class="avatar-controls card">'
      +   '<div class="ava-tabs">'
      +     '<div class="ava-tab active" data-tab="face">Face</div>'
      +     '<div class="ava-tab" data-tab="hair">Hair</div>'
      +     '<div class="ava-tab" data-tab="extras">Extras</div>'
      +   '</div>'

      // Face panel
      +   '<div class="ava-panel active" data-panel="face">'
      +     '<div class="ava-field"><div class="ava-field-label">Skin tone</div><div class="ava-swatches" data-swatches="skinColor"></div></div>'
      +     '<div class="ava-field"><div class="ava-field-label">Eyes</div><div class="ava-chips" data-chips="eyes"></div></div>'
      +     '<div class="ava-field"><div class="ava-field-label">Eyebrows</div><div class="ava-chips" data-chips="eyebrows"></div></div>'
      +     '<div class="ava-field"><div class="ava-field-label">Mouth</div><div class="ava-chips" data-chips="mouth"></div></div>'
      +   '</div>'

      // Hair panel
      +   '<div class="ava-panel" data-panel="hair">'
      +     '<div class="ava-field"><div class="ava-field-label">Hair / hat style</div><div class="ava-chips" data-chips="top"></div></div>'
      +     '<div class="ava-field"><div class="ava-field-label">Hair color</div><div class="ava-swatches" data-swatches="hairColor"></div></div>'
      +     '<div class="ava-field"><div class="ava-field-label">Facial hair</div><div class="ava-chips" data-chips="facialHair"></div></div>'
      +     '<div class="ava-field"><div class="ava-field-label">Facial hair color</div><div class="ava-swatches" data-swatches="facialHairColor"></div></div>'
      +   '</div>'

      // Extras panel
      +   '<div class="ava-panel" data-panel="extras">'
      +     '<div class="ava-field"><div class="ava-field-label">Clothing</div><div class="ava-chips" data-chips="clothing"></div></div>'
      +     '<div class="ava-field"><div class="ava-field-label">Clothing color</div><div class="ava-swatches" data-swatches="clothesColor"></div></div>'
      +     '<div class="ava-field"><div class="ava-field-label">Accessories</div><div class="ava-chips" data-chips="accessories"></div></div>'
      +     '<div class="ava-field"><div class="ava-field-label">Accessory color</div><div class="ava-swatches" data-swatches="accessoriesColor"></div></div>'
      +   '</div>'

      + '</div>'
      + '</div>'
      + '<div class="ava-save-status" id="avaSaveStatus"></div>'
      + (savedConfig ? '<script type="application/json" id="avaSavedConfig">' + JSON.stringify(savedConfig) + '<\/script>' : '')
      + '</div>';
  }

  // ── initBack (for not-found / error states) ────────────────
  function initBack(queryParams) {
    var btn = document.getElementById('avatarBack');
    var from = (queryParams && queryParams.from) ? queryParams.from : null;
    var backRoute = from ? '#' + from : '#/settings';
    if (btn) btn.addEventListener('click', function() { GC.router.navigate(backRoute); });
  }

  // ── init (full interactive wiring after render) ────────────
  function init(emp, queryParams) {
    var nameKey = emp.key;

    // Read saved config from the embedded JSON script tag (written by render())
    var savedConfigEl = document.getElementById('avaSavedConfig');
    var savedConfig = null;
    if (savedConfigEl) {
      try { savedConfig = JSON.parse(savedConfigEl.textContent); } catch(_) {}
    }

    var config = {};
    var k;
    for (k in DEFAULT_CONFIG) { config[k] = DEFAULT_CONFIG[k]; }
    if (savedConfig) {
      for (k in savedConfig) {
        if (k in DEFAULT_CONFIG) config[k] = savedConfig[k];
      }
    }

    // Back button
    initBack(queryParams);

    // Render both avatar images
    function renderImg() {
      var url = GC.buildAvatarUrl ? GC.buildAvatarUrl(config, nameKey) : buildLocalUrl(config, nameKey);
      var main = document.getElementById('avaImg');
      var lb   = document.getElementById('avaImgLb');
      if (main) main.src = url;
      if (lb)   lb.src   = url;
    }

    // Build swatches dynamically
    function buildSwatches(key) {
      var container = document.querySelector('[data-swatches="' + key + '"]');
      if (!container) return;
      container.innerHTML = '';
      OPTIONS[key].forEach(function(hex) {
        var s = document.createElement('div');
        s.className = 'ava-swatch' + (config[key] === hex ? ' selected' : '');
        s.style.background = '#' + hex;
        s.title = '#' + hex;
        s.addEventListener('click', function() {
          config[key] = hex;
          container.querySelectorAll('.ava-swatch').forEach(function(el) { el.classList.remove('selected'); });
          s.classList.add('selected');
          renderImg();
        });
        container.appendChild(s);
      });
    }

    // Build chips dynamically
    function buildChips(key) {
      var container = document.querySelector('[data-chips="' + key + '"]');
      if (!container) return;
      container.innerHTML = '';
      OPTIONS[key].forEach(function(val) {
        var chip = document.createElement('div');
        chip.className = 'ava-chip' + (config[key] === val ? ' selected' : '');
        chip.textContent = humanize(val);
        chip.dataset.val = val;
        chip.addEventListener('click', function() {
          config[key] = val;
          container.querySelectorAll('.ava-chip').forEach(function(el) { el.classList.remove('selected'); });
          chip.classList.add('selected');
          renderImg();
        });
        container.appendChild(chip);
      });
    }

    // Build all swatches and chips
    buildSwatches('skinColor');
    buildSwatches('hairColor');
    buildSwatches('facialHairColor');
    buildSwatches('clothesColor');
    buildSwatches('accessoriesColor');

    buildChips('top');
    buildChips('eyes');
    buildChips('eyebrows');
    buildChips('mouth');
    buildChips('facialHair');
    buildChips('clothing');
    buildChips('accessories');

    // Tabs
    document.querySelectorAll('.ava-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        document.querySelectorAll('.ava-tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.ava-panel').forEach(function(p) { p.classList.remove('active'); });
        tab.classList.add('active');
        var panel = document.querySelector('.ava-panel[data-panel="' + tab.dataset.tab + '"]');
        if (panel) panel.classList.add('active');
      });
    });

    // Surprise Me
    var randomBtn = document.getElementById('avaRandom');
    if (randomBtn) {
      randomBtn.addEventListener('click', function() {
        for (var k in OPTIONS) {
          var arr = OPTIONS[k];
          config[k] = arr[Math.floor(Math.random() * arr.length)];
        }
        // Rebuild all swatches and chips with new selections
        buildSwatches('skinColor');
        buildSwatches('hairColor');
        buildSwatches('facialHairColor');
        buildSwatches('clothesColor');
        buildSwatches('accessoriesColor');
        document.querySelectorAll('[data-chips]').forEach(function(container) {
          var key = container.getAttribute('data-chips');
          container.querySelectorAll('.ava-chip').forEach(function(chip) {
            chip.classList.toggle('selected', chip.dataset.val === config[key]);
          });
        });
        renderImg();
      });
    }

    // Save
    var saveBtn = document.getElementById('avaSave');
    var statusEl = document.getElementById('avaSaveStatus');
    if (saveBtn) {
      saveBtn.addEventListener('click', function() {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        if (statusEl) { statusEl.textContent = ''; statusEl.className = 'ava-save-status'; }

        GC.api.gasCall('saveavatar', { nameKey: nameKey, config: JSON.stringify(config) })
          .then(function(res) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
            if (statusEl) {
              if (res && res.ok) {
                statusEl.textContent = '✓ Saved';
                statusEl.className = 'ava-save-status ok';
                setTimeout(function() {
                  statusEl.textContent = '';
                  statusEl.className = 'ava-save-status';
                }, 3000);
              } else {
                statusEl.textContent = '✗ ' + ((res && res.error) || 'Save failed');
                statusEl.className = 'ava-save-status err';
              }
            }
          })
          .catch(function(err) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
            if (statusEl) {
              statusEl.textContent = '✗ ' + (err.message || 'Save failed');
              statusEl.className = 'ava-save-status err';
            }
          });
      });
    }

    // Clear avatar
    var clearBtn = document.getElementById('avaClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        if (!confirm('Remove ' + (emp.name || 'this employee') + '\'s avatar? They\'ll show initials on the leaderboard.')) return;
        clearBtn.disabled = true;
        clearBtn.textContent = 'Removing…';
        if (statusEl) { statusEl.textContent = ''; statusEl.className = 'ava-save-status'; }

        GC.api.gasCall('clearavatar', { nameKey: nameKey })
          .then(function(res) {
            if (res && res.ok) {
              // Remove the clear button and show confirmation, then navigate back
              clearBtn.parentNode.removeChild(clearBtn);
              if (statusEl) {
                statusEl.textContent = '✓ Avatar removed';
                statusEl.className = 'ava-save-status ok';
              }
              setTimeout(function() {
                var from = (queryParams && queryParams.from) ? '#' + queryParams.from : '#/settings';
                GC.router.navigate(from);
              }, 1200);
            } else {
              clearBtn.disabled = false;
              clearBtn.textContent = 'Remove avatar — revert to initials';
              if (statusEl) {
                statusEl.textContent = '✗ ' + ((res && res.error) || 'Remove failed');
                statusEl.className = 'ava-save-status err';
              }
            }
          })
          .catch(function(err) {
            clearBtn.disabled = false;
            clearBtn.textContent = 'Remove avatar — revert to initials';
            if (statusEl) {
              statusEl.textContent = '✗ ' + (err.message || 'Remove failed');
              statusEl.className = 'ava-save-status err';
            }
          });
      });
    }

    // Initial image render
    renderImg();
  }

  // ── Local URL builder (fallback if GC.buildAvatarUrl not present) ─
  function buildLocalUrl(cfg, seed) {
    var p = [];
    p.push('seed=' + encodeURIComponent(seed || 'default'));

    var noAccessories = cfg.accessories === '_none';
    var noFacialHair  = cfg.facialHair  === '_none';
    var noHair        = cfg.top         === '_none';

    var skip = {
      accessoriesColor: noAccessories,
      facialHairColor:  noFacialHair,
      hairColor:        noHair
    };

    for (var k in cfg) {
      var v = cfg[k];
      if (v == null || v === '_none') continue;
      if (skip[k]) continue;
      p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }

    p.push('accessoriesProbability=' + (noAccessories ? '0' : '100'));
    p.push('facialHairProbability='  + (noFacialHair  ? '0' : '100'));
    p.push('topProbability='         + (noHair        ? '0' : '100'));

    return 'https://api.dicebear.com/9.x/avataaars/svg?' + p.join('&');
  }

  return {
    render:        render,
    renderLoading: renderLoading,
    renderNotFound: renderNotFound,
    renderError:   renderError,
    init:          init,
    initBack:      initBack
  };

})();
