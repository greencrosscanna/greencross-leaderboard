// ============================================================
//  Green Cross — User Admin Sheet
//  user_admin.gs
//
//  SETUP (one-time):
//    1. In Google Drive, create a new Google Sheet
//       "GC Performance — User Admin"
//    2. Open Extensions → Apps Script, paste this entire file
//    3. Set GC_PERF_WEB_APP_URL below to your deployed
//       dutchie_proxy.gs web app URL
//    4. Run setupSheet() from the Run menu to create the
//       "Users" and "Store Keys" tabs
//    5. Run pullEmployeesFromDutchie() to populate the Users tab
//    6. Fill in Username, Password, Role for each person
//    7. Run pushUsersToApp() to sync to the live dashboard
//
//  The sheet also stores DUTCHIE_STORE_KEYS_JSON so you can
//  push it to the dashboard's ScriptProperties in one click.
// ============================================================

// ── Config ────────────────────────────────────────────────────
// Deployed URL of your dutchie_proxy.gs web app.
// Update after deploying the GAS backend.
const GC_PERF_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbxXqtL-rKjuzFQkyADWnHGEoM2ZSYp9g4t1J6vhyDTgHcfkEuQocYrN9DXV7_84Masuqg/exec';

// Director admin token — set this after first login via the app.
// Needed to authenticate pushUsersToApp() calls.
// (Or add a dedicated admin action protected by a setup secret.)
const ADMIN_TOKEN = 'REPLACE_WITH_DIRECTOR_TOKEN';

// ── STORE REGISTRY — no credentials, no name-keyed lookups ──────────────────────
// MUST match STORES in dutchie_proxy.gs. `storeId` is the GX Core store_id: the join key to Core's
// stores tab AND the key into DUTCHIE_STORE_KEYS_JSON.
//
// WHAT USED TO BE HERE, and why it is gone (2026-08-29):
//   • STORE_KEYS_MAP held all six live Dutchie API keys as literals. This repo is PUBLIC and they
//     sat at HEAD from 2026-05-20. Keys now live ONLY in the Store Keys sheet tab and in the
//     dashboard's Script Properties. Never paste a key into this file.
//   • DUTCHIE_TO_SLUG mapped 'Hillsboro'→baseline and 'Bend'→century. That is INVERTED: measurement
//     (2026-08-28, unanimous 6/6 per store) and three independent sources — GX Core's stores tab,
//     Inventory and Sales — all agree the key labelled 'Bend' serves the Hillsboro/Baseline store.
//     This file was the last written artefact still asserting the wrong direction, and it is exactly
//     the "documentary source" that got trusted over measurement in PR #8. Keyed by store_id there
//     is no direction left to get backwards.
const STORES = [
  { slug: 'baseline',   name: 'Baseline',   storeId: 'hillsboro'   },
  { slug: 'center',     name: 'Center',     storeId: 'center'      },
  { slug: 'century',    name: 'Century',    storeId: 'bend'        },
  { slug: 'commercial', name: 'Commercial', storeId: 'commercial'  },
  { slug: 'portland',   name: 'Portland',   storeId: 'portland-rd' },
  { slug: 'river',      name: 'River',      storeId: 'river-rd'    },
];

/** Read { store_id: apiKey } from the Store Keys tab. The sheet is the only place keys live here. */
function readStoreKeysFromSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(KEYS_SHEET);
  if (!sh || sh.getLastRow() < 2) return {};
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  const out = {};
  rows.forEach(function(row) {
    const storeId = String(row[0] || '').trim();
    const key     = String(row[3] || '').trim();
    if (storeId && key) out[storeId] = key;
  });
  return out;
}

// ── Sheet tab names ────────────────────────────────────────────
const USERS_SHEET  = 'Users';
const KEYS_SHEET   = 'Store Keys';

// ── Column indices in Users sheet (1-based) ───────────────────
const COL_STORE        = 1;  // Store Name (from Dutchie)
const COL_FULL_NAME    = 2;  // Full Name (from Dutchie)
const COL_INITIALS     = 3;  // Initials (auto or manual)
const COL_ROLE_DUTCHIE = 4;  // Dutchie Role (read-only reference)
const COL_USERNAME     = 5;  // App Username (you set this)
const COL_PASSWORD     = 6;  // App Password (you set this)
const COL_ROLE_APP     = 7;  // App Role: director | store_manager | budtender
const COL_DISPLAY_NAME = 8;  // Display Name override (leave blank to use Full Name)
const COL_ACTIVE       = 9;  // TRUE/FALSE — include in sync
const COL_LAST_SYNCED  = 10; // Timestamp of last successful push
const COL_STATUS       = 11; // "✓ Synced" / "⚠ Error: ..."

const USERS_HEADERS = [
  'Store', 'Full Name', 'Initials', 'Dutchie Role',
  'Username', 'Password', 'App Role',
  'Display Name', 'Active', 'Last Synced', 'Status',
];

// ── Menu ───────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ GC Admin')
    .addItem('1. Pull employees from Dutchie', 'pullEmployeesFromDutchie')
    .addSeparator()
    .addItem('2. Push users to dashboard', 'pushUsersToApp')
    .addSeparator()
    .addItem('Setup sheet (first run)', 'setupSheet')
    .addItem('Validate rows', 'validateRows')
    .addToUi();
}

// ── Setup ──────────────────────────────────────────────────────
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── Users tab ──
  let usersSheet = ss.getSheetByName(USERS_SHEET);
  if (!usersSheet) usersSheet = ss.insertSheet(USERS_SHEET);
  usersSheet.clearContents();

  // Header row
  usersSheet.getRange(1, 1, 1, USERS_HEADERS.length)
    .setValues([USERS_HEADERS])
    .setFontWeight('bold')
    .setBackground('#1a1a1a')
    .setFontColor('#4ade80');

  // Freeze header
  usersSheet.setFrozenRows(1);

  // Column widths
  usersSheet.setColumnWidth(COL_STORE,        110);
  usersSheet.setColumnWidth(COL_FULL_NAME,    160);
  usersSheet.setColumnWidth(COL_INITIALS,      70);
  usersSheet.setColumnWidth(COL_ROLE_DUTCHIE, 130);
  usersSheet.setColumnWidth(COL_USERNAME,     120);
  usersSheet.setColumnWidth(COL_PASSWORD,     130);
  usersSheet.setColumnWidth(COL_ROLE_APP,     130);
  usersSheet.setColumnWidth(COL_DISPLAY_NAME, 150);
  usersSheet.setColumnWidth(COL_ACTIVE,        70);
  usersSheet.setColumnWidth(COL_LAST_SYNCED,  160);
  usersSheet.setColumnWidth(COL_STATUS,       200);

  // Data validation: App Role dropdown
  const roleRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['director', 'store_manager', 'budtender'], true)
    .setAllowInvalid(false)
    .build();
  usersSheet.getRange(2, COL_ROLE_APP, 200, 1).setDataValidation(roleRule);

  // Data validation: Active checkbox
  const boolRule = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .build();
  usersSheet.getRange(2, COL_ACTIVE, 200, 1).setDataValidation(boolRule);

  // Protect the auto-filled columns (read-only reference)
  // Store, Full Name, Dutchie Role — users shouldn't edit these
  const protection = usersSheet.getRange(2, COL_STORE, 200, 3).protect();
  protection.setDescription('Auto-filled from Dutchie — do not edit');
  protection.setWarningOnly(true);

  // ── Store Keys tab ──
  let keysSheet = ss.getSheetByName(KEYS_SHEET);
  if (!keysSheet) keysSheet = ss.insertSheet(KEYS_SHEET);
  keysSheet.clearContents();

  const keysHeaders = ['GX Core store_id', 'App Slug', 'App Name', 'API Key', 'Last Pushed'];
  keysSheet.getRange(1, 1, 1, keysHeaders.length)
    .setValues([keysHeaders])
    .setFontWeight('bold')
    .setBackground('#1a1a1a')
    .setFontColor('#4ade80');
  keysSheet.setFrozenRows(1);
  keysSheet.setColumnWidth(1, 160);
  keysSheet.setColumnWidth(2, 100);
  keysSheet.setColumnWidth(3, 110);
  keysSheet.setColumnWidth(4, 280);
  keysSheet.setColumnWidth(5, 160);

  // Pre-populate the store rows. The API Key column is deliberately left BLANK — paste the keys in
  // by hand, once, into the sheet. They must never be seeded from source.
  const existing = readStoreKeysFromSheet_();
  const keyRows = STORES.map(function(st) {
    return [st.storeId, st.slug, st.name, existing[st.storeId] || '', ''];
  });
  keysSheet.getRange(2, 1, keyRows.length, keyRows[0].length).setValues(keyRows);

  // Protect API key column from casual edits
  const keyProtect = keysSheet.getRange(2, 4, keyRows.length, 1).protect();
  keyProtect.setDescription('Dutchie API keys — edit only if keys change');
  keyProtect.setWarningOnly(true);

  ss.setActiveSheet(usersSheet);
  showToast_('Setup complete! Run "Pull employees from Dutchie" next.', 'Setup Done');
}

// ── Pull employees from Dutchie ────────────────────────────────
function pullEmployeesFromDutchie() {
  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ss.getSheetByName(USERS_SHEET);
  if (!usersSheet) { showToast_('Run Setup first.', 'Error'); return; }

  showToast_('Fetching employees from all stores…', 'Working');

  // Fetch employees in parallel from all stores. Credentials come from the sheet, keyed by store_id.
  const sheetKeys = readStoreKeysFromSheet_();
  const fetchable = STORES.filter(function(st) { return !!sheetKeys[st.storeId]; });
  if (!fetchable.length) {
    showToast_('No API keys in the Store Keys tab. Paste them in, then re-run.', 'Error');
    return;
  }
  const requests = fetchable.map(function(st) {
    return {
      url: DUTCHIE_BASE + '/employees?Skip=0&Take=500',
      headers: {
        Authorization: 'Basic ' + Utilities.base64Encode(sheetKeys[st.storeId] + ':'),
        Accept: 'application/json',
      },
      muteHttpExceptions: true,
    };
  });

  // fetchAll preserves ORDER, not metadata — index back into `fetchable`, which built `requests`.
  const responses = UrlFetchApp.fetchAll(requests);
  const allEmployees = [];

  fetchable.forEach(function(st, i) {
    try {
      const resp = responses[i];
      if (resp.getResponseCode() !== 200) {
        Logger.log('Employee fetch error for ' + st.storeId + ': ' + resp.getResponseCode());
        return;
      }
      const data = JSON.parse(resp.getContentText());
      const emps = Array.isArray(data) ? data : (data.employees || data.data || []);

      emps.forEach(function(emp) {
        if (!emp || emp.isDeleted || emp.inactive) return;
        const firstName = (emp.firstName || '').trim();
        const lastName  = (emp.lastName  || '').trim();
        const fullName  = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
        const initials  = [firstName[0], lastName[0]].filter(Boolean).join('').toUpperCase().slice(0, 2);
        const role      = emp.role || emp.roleName || emp.position || '';

        allEmployees.push({
          store:        st.name,
          fullName:     fullName,
          initials:     initials,
          dutchieRole:  role,
          slug:         st.slug,
        });
      });
    } catch(e) {
      Logger.log('Error parsing employees for store ' + st.storeId + ': ' + e.message);
    }
  });

  if (allEmployees.length === 0) {
    showToast_('No employees returned. Check store keys and Dutchie API.', 'Warning');
    return;
  }

  // Sort: by store name, then by full name
  allEmployees.sort(function(a, b) {
    const storeCmp = a.store.localeCompare(b.store);
    return storeCmp !== 0 ? storeCmp : a.fullName.localeCompare(b.fullName);
  });

  // Read existing rows to preserve any data already entered (username, password, etc.)
  const existingData = usersSheet.getLastRow() > 1
    ? usersSheet.getRange(2, 1, usersSheet.getLastRow() - 1, USERS_HEADERS.length).getValues()
    : [];

  // Build a lookup of existing entries by fullName+store
  const existing = {};
  existingData.forEach(function(row) {
    const key = (row[COL_STORE - 1] + '|' + row[COL_FULL_NAME - 1]).toLowerCase();
    existing[key] = row;
  });

  // Build new rows, merging with existing where possible
  const newRows = allEmployees.map(function(emp) {
    const lookupKey = (emp.store + '|' + emp.fullName).toLowerCase();
    const prev      = existing[lookupKey];

    // Guess app role from Dutchie role string
    const dutchieRoleLower = (emp.dutchieRole || '').toLowerCase();
    let guessedRole = 'budtender';
    if (dutchieRoleLower.includes('manager') || dutchieRoleLower.includes('mgr'))   guessedRole = 'store_manager';
    if (dutchieRoleLower.includes('director') || dutchieRoleLower.includes('owner')) guessedRole = 'director';

    // Build suggested username: first name lowercase + store initial
    const firstName   = emp.fullName.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const storeInitial = emp.store[0].toLowerCase();
    const suggestedUser = firstName; // keep simple; store manager can disambiguate

    return [
      emp.store,                                    // Store
      emp.fullName,                                 // Full Name
      prev ? prev[COL_INITIALS - 1]     || emp.initials  : emp.initials,   // Initials
      emp.dutchieRole,                              // Dutchie Role
      prev ? prev[COL_USERNAME - 1]     || suggestedUser : suggestedUser,  // Username
      prev ? prev[COL_PASSWORD - 1]     || 'gc123'       : 'gc123',        // Password
      prev ? prev[COL_ROLE_APP - 1]     || guessedRole   : guessedRole,    // App Role
      prev ? prev[COL_DISPLAY_NAME - 1] || ''            : '',             // Display Name
      prev ? prev[COL_ACTIVE - 1]       !== false        : true,           // Active
      prev ? prev[COL_LAST_SYNCED - 1]  || ''            : '',             // Last Synced
      '',                                           // Status (cleared on re-pull)
    ];
  });

  // Write rows
  if (usersSheet.getLastRow() > 1) {
    usersSheet.getRange(2, 1, usersSheet.getLastRow() - 1, USERS_HEADERS.length).clearContent();
  }
  if (newRows.length > 0) {
    usersSheet.getRange(2, 1, newRows.length, newRows[0].length).setValues(newRows);
  }

  // Stripe rows for readability
  colorizeRows_(usersSheet, newRows.length);

  showToast_(newRows.length + ' employees loaded. Fill in usernames/passwords/roles, then push.', 'Done');
}

// ── Push users to the dashboard ────────────────────────────────
function pushUsersToApp() {
  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ss.getSheetByName(USERS_SHEET);
  if (!usersSheet || usersSheet.getLastRow() < 2) {
    showToast_('No users to push. Pull employees first.', 'Error'); return;
  }
  if (GC_PERF_WEB_APP_URL === 'REPLACE_WITH_DEPLOYED_WEB_APP_URL') {
    showToast_('Set GC_PERF_WEB_APP_URL at the top of the script first.', 'Config Error'); return;
  }

  const rows = usersSheet.getRange(2, 1, usersSheet.getLastRow() - 1, USERS_HEADERS.length).getValues();
  const now  = new Date();
  let pushed = 0, skipped = 0, errors = 0;

  rows.forEach(function(row, i) {
    const active   = row[COL_ACTIVE - 1];
    const username = String(row[COL_USERNAME - 1] || '').trim().toLowerCase();
    const password = String(row[COL_PASSWORD - 1] || '').trim();
    const roleApp  = String(row[COL_ROLE_APP - 1] || '').trim();
    const storeName = String(row[COL_STORE - 1] || '').trim();
    const fullName = String(row[COL_FULL_NAME - 1] || '').trim();
    const displayName = String(row[COL_DISPLAY_NAME - 1] || '').trim() || fullName;
    const initials = String(row[COL_INITIALS - 1] || '').trim();

    // Find storeSlug from store name
    const storeSlug = (STORES.find(function(st) { return st.name === storeName; }) || {}).slug || null;

    const rowNum = i + 2;

    if (!active) {
      usersSheet.getRange(rowNum, COL_STATUS).setValue('— skipped (inactive)');
      skipped++;
      return;
    }
    if (!username || !password || !roleApp) {
      usersSheet.getRange(rowNum, COL_STATUS).setValue('⚠ Missing username, password, or role');
      errors++;
      return;
    }

    // Call the GAS web app's setuser action
    // We use a dedicated admin action that accepts a director token
    try {
      const url = GC_PERF_WEB_APP_URL
        + '?action=setuser'
        + '&token=' + encodeURIComponent(ADMIN_TOKEN)
        + '&username=' + encodeURIComponent(username)
        + '&password=' + encodeURIComponent(password)
        + '&role=' + encodeURIComponent(roleApp)
        + '&storeSlug=' + encodeURIComponent(storeSlug || '')
        + '&displayName=' + encodeURIComponent(displayName)
        + '&initials=' + encodeURIComponent(initials);

      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      const result = JSON.parse(resp.getContentText());

      if (result.ok) {
        usersSheet.getRange(rowNum, COL_LAST_SYNCED).setValue(Utilities.formatDate(now, 'America/Los_Angeles', 'M/d/yy h:mm a'));
        usersSheet.getRange(rowNum, COL_STATUS).setValue('✓ Synced');
        pushed++;
      } else {
        usersSheet.getRange(rowNum, COL_STATUS).setValue('⚠ ' + (result.error || 'Unknown error'));
        errors++;
      }
    } catch(e) {
      usersSheet.getRange(rowNum, COL_STATUS).setValue('⚠ ' + e.message.slice(0, 60));
      errors++;
    }
  });

  showToast_(pushed + ' users synced, ' + skipped + ' skipped, ' + errors + ' errors.', 'Push Complete');
}

// ── Push store keys to dashboard — RETIRED 2026-08-31 ──────────
// This pushed the Store Keys tab into the dashboard's ScriptProperties via the setstorekeys route.
// Both are gone: the dashboard stores no Dutchie key, GX Core holds the only copy, and the route
// that wrote the property was removed with it.
//
// This is the button that made a rotation look done when it was not. It reads a SHEET, so it served
// whatever was last typed there -- and on 2026-08-31 that was still the revoked set. Someone pasting
// fresh keys into the dashboard and then clicking here would have overwritten them with dead ones,
// which is indistinguishable from "the new keys did not work".
//
// TO ROTATE: set DUTCHIE_STORE_KEYS_JSON in GX CORE. Nowhere else, and nothing to click here.
function pushStoreKeysToDashboard() {
  showToast_('Retired. Dutchie keys live only in GX Core now — rotate them there. '
           + 'The Store Keys tab is historical and should be cleared.', 'Not used any more');
  return { ok: false, retired: true,
           reason: 'GX Core is the only holder of Dutchie keys; the setstorekeys route was removed' };
}

function validateRows() {
  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ss.getSheetByName(USERS_SHEET);
  if (!usersSheet || usersSheet.getLastRow() < 2) {
    showToast_('No rows to validate.', 'Info'); return;
  }

  const rows = usersSheet.getRange(2, 1, usersSheet.getLastRow() - 1, USERS_HEADERS.length).getValues();
  const usernamesSeen = {};
  let issues = 0;

  rows.forEach(function(row, i) {
    const rowNum   = i + 2;
    const active   = row[COL_ACTIVE - 1];
    if (!active) return;

    const username = String(row[COL_USERNAME - 1] || '').trim();
    const password = String(row[COL_PASSWORD - 1] || '').trim();
    const role     = String(row[COL_ROLE_APP - 1] || '').trim();
    const msgs     = [];

    if (!username)                 msgs.push('missing username');
    if (!password)                 msgs.push('missing password');
    if (password.length < 4)      msgs.push('password too short (<4 chars)');
    if (!role)                     msgs.push('missing role');
    if (username && usernamesSeen[username]) msgs.push('duplicate username "' + username + '"');
    if (username) usernamesSeen[username] = true;

    if (msgs.length > 0) {
      usersSheet.getRange(rowNum, COL_STATUS).setValue('⚠ ' + msgs.join('; '));
      usersSheet.getRange(rowNum, 1, 1, USERS_HEADERS.length).setBackground('#3d1f1f');
      issues++;
    } else {
      usersSheet.getRange(rowNum, COL_STATUS).setValue('✓ Ready to push');
      usersSheet.getRange(rowNum, 1, 1, USERS_HEADERS.length).setBackground(null);
    }
  });

  showToast_(issues === 0 ? 'All rows valid!' : issues + ' issue(s) found — see Status column.', 'Validation');
}

// ── Helpers ────────────────────────────────────────────────────
function colorizeRows_(sheet, count) {
  for (let i = 0; i < count; i++) {
    const bg = i % 2 === 0 ? '#111111' : '#181818';
    sheet.getRange(i + 2, 1, 1, USERS_HEADERS.length).setBackground(bg);
  }
}

function showToast_(msg, title) {
  SpreadsheetApp.getActiveSpreadsheet().toast(msg, title || 'GC Admin', 5);
}
