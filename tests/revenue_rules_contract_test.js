#!/usr/bin/env node
/* Revenue-rules contract — net, gross, discount, tax and COGS must mean one thing across the suite.
 *
 * The canonical test lives in greencross-command-center/tests/revenue_rules_contract_test.js, because
 * the contract spans three repos and no one of them owns it. This wrapper runs it so THIS repo's
 * pre-push hook is gated by it too: a contract only the hub checks is a contract that catches drift
 * after it ships, which is the situation it was written to end.
 *
 * In this repo it is the per-transaction parsers (txNet_ / txDiscount_ / isRetailSale_) are checked against Core's.
 *
 * Skips cleanly when the hub is not a sibling checkout — a wrapper that fails because someone cloned
 * one repo on its own teaches people to bypass the gate, which costs more than the coverage is worth.
 */
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const CANON = path.join(__dirname, '..', '..', 'greencross-command-center',
                        'tests', 'revenue_rules_contract_test.js');
if (!fs.existsSync(CANON)) {
  console.log('SKIP revenue-rules contract — greencross-command-center is not a sibling checkout.');
  process.exit(0);
}
try {
  console.log(execFileSync(process.execPath, [CANON], { encoding: 'utf8' }).trim());
} catch (e) {
  process.stdout.write(String(e.stdout || ''));
  process.stderr.write(String(e.stderr || ''));
  console.log('\n^ REVENUE-RULES CONTRACT BROKEN — this app and GX Core disagree about money.');
  process.exit(1);
}
