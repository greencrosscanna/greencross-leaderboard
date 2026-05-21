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
const GC_PERF_WEB_APP_URL = 'REPLACE_WITH_DEPLOYED_WEB_APP_URL';

// Director admin token — set this after first login via the app.
// Needed to authenticate pushUsersToApp() calls.
// (Or add a dedicated admin action protected by a setup secret.)
const ADMIN_TOKEN = 'REPLACE_WITH_DIRECTOR_TOKEN';

// Store keys — matches STORES in dutchie_proxy.gs
const STORE_KEYS_MAP = {
  'Hillsboro':   '77e157f3fcdf43d9864daf0420df8c97',  // → Baseline
  'Center':      '6a7e9c3187a6471d8a0a2d05cfa92023',  // → Center
  'Commercial':  'd97da3cef3f74dd087cee7d4239a851d',  // → Commercial
  'Bend':        'a2de33457b8f4d35972d3c47832207eb',  // → Century
  'Portland Rd': '5671f32c2c2a4756811e9513945815f4',  // → Portland
  'River':       '5212417431014845a6db39bcb4ccef6b',  // → River
};

// Slug lookup for display
const DUTCHIE_TO_SLUG = {
  'Hillsboro':   'baseline',
  'Center':      'center',
  'Bend':        'century',
  'Commercial':  'commercial',
  'Portland Rd': 'portland',
  'River':       'river',
};

const SLUG_TO_NAME = {
  'baseline':   'Baseline',
  'center':     'Center',
  'century':    'Century',
  'commercial': 'Commercial',
  'portland':   'Portland',
  'river':      'River',
};

const DUTCHIE_BASE = 'https://api.pos.dutchie.com';

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
    .addItem('2b. Push store keys to dashboard', 'pushStoreKeysToDashboard')
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

  const keysHeaders = ['Dutchie Store Name', 'App Slug', 'App Name', 'API Key', 'Last Pushed'];
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

  // Pre-populate store keys
  const keyRows = Object.entries(STORE_KEYS_MAP).map(([dutchieName, key]) => {
    const slug = DUTCHIE_TO_SLUG[dutchieName] || dutchieName.toLowerCase();
    return [dutchieName, slug, SLUG_TO_NAME[slug] || slug, key, ''];
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

  // Fetch employees in parallel from all stores
  const requests = Object.entries(STORE_KEYS_MAP).map(([dutchieName, key]) => ({
    url: DUTCHIE_BASE + '/employees?Skip=0&Take=500',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(key + ':'),
      Accept: 'application/json',
    },
    muteHttpExceptions: true,
    _storeName: dutchieName,
  }));

  // UrlFetchApp.fetchAll doesn't preserve metadata, so we track by index
  const fetchRequests = requests.map(r => ({
    url: r.url,
    headers: r.headers,
    muteHttpExceptions: r.muteHttpExceptions,
  }));

  const responses = UrlFetchApp.fetchAll(fetchRequests);
  const allEmployees = [];

  Object.keys(STORE_KEYS_MAP).forEach(function(dutchieName, i) {
    try {
      const resp = responses[i];
      if (resp.getResponseCode() !== 200) {
        Logger.log('Employee fetch error for ' + dutchieName + ': ' + resp.getResponseCode());
        return;
      }
      const data = JSON.parse(resp.getContentText());
      const emps = Array.isArray(data) ? data : (data.employees || data.data || []);
      const slug = DUTCHIE_TO_SLUG[dutchieName] || '';

      emps.forEach(function(emp) {
        if (!emp || emp.isDeleted || emp.inactive) return;
        const firstName = (emp.firstName || '').trim();
        const lastName  = (emp.lastName  || '').trim();
        const fullName  = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
        const initials  = [firstName[0], lastName[0]].filter(Boolean).join('').toUpperCase().slice(0, 2);
        const role      = emp.role || emp.roleName || emp.position || '';

        allEmployees.push({
          store:        SLUG_TO_NAME[slug] || dutchieName,
          fullName:     fullName,
          initials:     initials,
          dutchieRole:  role,
          slug:         slug,
        });
      });
    } catch(e) {
      Logger.log('Error parsing employees for store ' + dutchieName + ': ' + e.message);
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
    const storeSlug = Object.entries(SLUG_TO_NAME).find(([, name]) => name === storeName)?.[0] || null;

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

// ── Push store keys to dashboard ──────────────────────────────
// Writes DUTCHIE_STORE_KEYS_JSON to the dashboard's ScriptProperties
// via a dedicated admin endpoint.
function pushStoreKeysToDashboard() {
  if (GC_PERF_WEB_APP_URL === 'REPLACE_WITH_DEPLOYED_WEB_APP_URL') {
    showToast_('Set GC_PERF_WEB_APP_URL first.', 'Config Error'); return;
  }
  if (ADMIN_TOKEN === 'REPLACE_WITH_DIRECTOR_TOKEN') {
    showToast_('Set ADMIN_TOKEN first.', 'Config Error'); return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const keysSheet = ss.getSheetByName(KEYS_SHEET);
  if (!keysSheet || keysSheet.getLastRow() < 2) {
    showToast_('Store Keys tab is empty. Run Setup first.', 'Error'); return;
  }

  // Build the JSON from the sheet (dutchieName → key)
  const rows = keysSheet.getRange(2, 1, keysSheet.getLastRow() - 1, 4).getValues();
  const keysObj = {};
  rows.forEach(function(row) {
    const dutchieName = String(row[0] || '').trim();
    const key         = String(row[3] || '').trim();
    if (dutchieName && key) keysObj[dutchieName] = key;
  });

  const payload = JSON.stringify(keysObj);

  try {
    const url = GC_PERF_WEB_APP_URL
      + '?action=setstorekeys'
      + '&token=' + encodeURIComponent(ADMIN_TOKEN)
      + '&keys=' + encodeURIComponent(payload);

    const resp   = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const result = JSON.parse(resp.getContentText());

    if (result.ok) {
      const now = new Date();
      const ts  = Utilities.formatDate(now, 'America/Los_Angeles', 'M/d/yy h:mm a');
      keysSheet.getRange(2, 5, rows.length, 1).setValue(ts);
      showToast_('Store keys pushed successfully.', 'Done');
    } else {
      showToast_('Error: ' + (result.error || 'Unknown'), 'Error');
    }
  } catch(e) {
    showToast_('Error: ' + e.message, 'Error');
  }
}

// ── Validate rows ──────────────────────────────────────────────
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
