#!/usr/bin/env node
/* Cross-app goal contract — this repo is the PRODUCER side.
 *
 * The canonical test lives in greencross-command-center/tests/cross_app_goals_contract_test.js,
 * because the contract spans two repos and neither owns it. This wrapper runs it so THIS repo's
 * pre-push hook is gated by it too — a contract only one side checks is a contract half-checked,
 * and it is this side's changes that would break it.
 *
 * greencross-sales renders the other half.
 *
 * Skips cleanly when the hub is not a sibling checkout. That is deliberate: a wrapper that fails
 * because someone cloned one repo on its own teaches people to bypass the gate, which costs more
 * than the coverage is worth.
 */
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const CANON = path.join(__dirname, '..', '..', 'greencross-command-center',
                        'tests', 'cross_app_goals_contract_test.js');
if (!fs.existsSync(CANON)) {
  console.log('SKIP cross-app contract — greencross-command-center is not a sibling checkout.');
  process.exit(0);
}
try {
  console.log(execFileSync(process.execPath, [CANON], { encoding: 'utf8' }).trim());
} catch (e) {
  process.stdout.write(String(e.stdout || ''));
  process.stderr.write(String(e.stderr || ''));
  console.log('\n^ CROSS-APP CONTRACT BROKEN. This repo is the PRODUCER.');
  process.exit(1);
}
