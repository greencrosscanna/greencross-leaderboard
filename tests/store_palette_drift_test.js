#!/usr/bin/env node
/* This app carries a hardcoded store palette under its GX Core registry overlay, and so do two
 * siblings. The overlay hides any divergence the moment Core answers — so they drift silently and only
 * disagree visibly during a Core outage or on first paint, when nobody can tell a palette bug from the
 * outage.
 *
 * This repo is one of the three that can CAUSE that. The canonical comparison lives in the hub
 * (greencross-command-center/tools/store-fallback-drift.js) because it spans three repos and none owns
 * it; this wrapper puts it in front of THIS repo's push.
 *
 * Skips when the hub is not a sibling checkout — a gate that fails on a lone clone gets bypassed.
 */
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const TOOL = path.join(__dirname, '..', '..', 'greencross-command-center', 'tools', 'store-fallback-drift.js');
if (!fs.existsSync(TOOL)) { console.log('SKIP palette drift — greencross-command-center is not a sibling checkout.'); process.exit(0); }
try { console.log(execFileSync(process.execPath, [TOOL, '--strict'], { encoding: 'utf8' }).trim()); console.log('\n1 passed, 0 failed'); }
catch (e) {
  process.stdout.write(String(e.stdout || ''));
  console.log('\nSTORE PALETTES HAVE DIVERGED. Align the outlier to the live registry (?action=stores).');
  console.log('Do NOT delete a fallback table to silence this — the fallback is what users see when Core is down.');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}
