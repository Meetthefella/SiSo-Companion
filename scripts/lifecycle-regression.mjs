import assert from 'node:assert/strict';
import { visibleKitsForGroup } from '../src/kitBoard.js';
import { includedReconciliationItems, reconciliationCounts, reconciliationExportRows, reconciliationItems } from '../src/reconciliationState.js';

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

const catalog = Array.from({ length: 1434 }, (_, index) => ({
  kit_barcode: `BMSKIT${String(index + 1).padStart(4, '0')}`,
  asset_name: `Stock item ${index + 1}`,
  source_row: index + 1,
  original_row: {},
}));
const boardChecks = [
  { kit_barcode: catalog[0].kit_barcode, comparison_status: 'reconciled', physical_state: 'present', checked_by: 'AB', checked_at: '2026-01-01T00:00:00Z', detail: null, booking_state: null },
  ...catalog.slice(1, 15).map((item) => ({ kit_barcode: item.kit_barcode, comparison_status: 'collected', physical_state: 'absent', checked_by: 'AB', checked_at: '2026-01-01T00:00:00Z', detail: null, booking_state: 'Collected' })),
  ...catalog.slice(15, 262).map((item) => ({ kit_barcode: item.kit_barcode, comparison_status: 'missing', physical_state: 'absent', checked_by: 'AB', checked_at: '2026-01-01T00:00:00Z', detail: 'Missing', booking_state: null })),
];
const canonical = reconciliationItems(catalog, [], [], boardChecks);
const boardCounts = reconciliationCounts(canonical);
assert.equal(canonical.length, 1434);
const exportCounts = reconciliationExportRows(canonical).reduce((counts, row) => {
  const status = row['Companion Audit Status'];
  counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}, { reconciled: 0, collected: 0, second_pass: 0, further_action: 0, not_checked: 0 });
const baseline = { reconciled: 1, collected: 14, further_action: 247, second_pass: 0, not_checked: 1172 };
assert.deepEqual(boardCounts, baseline);
assert.deepEqual(exportCounts, baseline);

const ignoredRecords = reconciliationItems([
  { kit_barcode: 'BMSLIVE001', kit_group: 'LIVE', source_row: 1, asset_name: 'Live kit', original_row: {} },
  { kit_barcode: 'BMSRET001', kit_group: 'RET', source_row: 2, asset_name: 'Retired kit', original_row: {} },
], [], [], [{ kit_barcode: 'BMSRET001', comparison_status: 'missing', physical_state: 'absent', checked_by: 'AB', checked_at: '2026-01-01T00:00:00Z', detail: 'Retired', booking_state: null }], new Set(['RET']));
assert.deepEqual(reconciliationCounts(includedReconciliationItems(ignoredRecords)), { reconciled: 0, collected: 0, second_pass: 0, further_action: 0, not_checked: 1 });
assert.equal(reconciliationExportRows(includedReconciliationItems(ignoredRecords)).length, 1);

const expandedRowRecords = reconciliationItems([
  { kit_barcode: 'BMSMIX001', kit_group: 'MIX', source_row: 1, asset_name: 'Mixed', original_row: {} },
  { kit_barcode: 'BMSMIX002', kit_group: 'MIX', source_row: 1, asset_name: 'Mixed', original_row: {} },
], [{ source_row: 1, barcode: 'BMSMIX001,BMSMIX002', serial: 'SERIAL-ONE' }], [], []);
assert.equal(expandedRowRecords[0].asset, null);
assert.equal(expandedRowRecords[1].asset, null);
console.log('Lifecycle regression assertions passed.');
