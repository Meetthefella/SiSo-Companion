import assert from 'node:assert/strict';
import { visibleKitsForGroup } from '../src/kitBoard.js';

const kits = [
  { barcode: 'BMSKIT001', group: 'KIT' },
  { barcode: 'BMSKIT002', group: 'KIT' },
];
const checks = new Map([
  ['BMSKIT001', { comparison_status: 'reconciled' }],
  ['BMSKIT002', { comparison_status: 'missing' }],
]);

const target = visibleKitsForGroup(kits, 'KIT', 'further_action', checks);
assert.deepEqual(target.map((kit) => kit.barcode), ['BMSKIT002']);
const afterGroupAction = new Map(checks);
for (const kit of target) afterGroupAction.set(kit.barcode, { comparison_status: 'reconciled' });
assert.equal(afterGroupAction.get('BMSKIT001').comparison_status, 'reconciled');
assert.equal(afterGroupAction.get('BMSKIT002').comparison_status, 'reconciled');
assert.strictEqual(afterGroupAction.get('BMSKIT001'), checks.get('BMSKIT001'));
console.log('Lifecycle regression assertions passed.');
