const cleanBarcode = (value) => String(value ?? '').replace(/\s+/g, '').toUpperCase();

function kitParts(barcode) {
  const value = cleanBarcode(barcode);
  const match = value.match(/^BMS(.+?)(\d{3})$/);
  return match ? { barcode: value, group: match[1], number: match[2], code: `${match[1]} ${Number(match[2])}` } : null;
}

function bookingIsOut(state) {
  return !/^(available|returned|complete|completed|cancelled|canceled|in store)$/i.test(String(state ?? '').trim());
}

function statusFor(check) {
  if (!check) return 'not_checked';
  if (check.comparison_status === 'reconciled') return 'reconciled';
  if (check.comparison_status === 'collected') return 'collected';
  if (check.comparison_status === 'second_pass') return 'second_pass';
  return 'further_action';
}

export function reconciliationItems(kitCatalog, assets, bookingRows, kitChecks, ignoredGroups = new Set()) {
  const catalogRowsBySourceRow = new Map();
  for (const catalog of kitCatalog) {
    if (catalog.source_row !== null) catalogRowsBySourceRow.set(catalog.source_row, (catalogRowsBySourceRow.get(catalog.source_row) ?? 0) + 1);
  }
  const assetsBySourceRow = new Map(assets.filter((asset) => asset.source_row !== null && catalogRowsBySourceRow.get(asset.source_row) === 1).map((asset) => [asset.source_row, asset]));
  const assetsByExactBarcode = new Map();
  for (const asset of assets) {
    const key = cleanBarcode(asset.barcode);
    if (key && !assetsByExactBarcode.has(key)) assetsByExactBarcode.set(key, asset);
  }
  const bookingsByBarcode = new Map();
  for (const booking of bookingRows) {
    const key = cleanBarcode(booking.asset_barcode);
    if (!bookingsByBarcode.has(key)) bookingsByBarcode.set(key, []);
    bookingsByBarcode.get(key).push(booking);
  }
  const checksByBarcode = new Map(kitChecks.map((check) => [cleanBarcode(check.kit_barcode), check]));
  const records = new Map();
  for (const catalog of kitCatalog) {
    const kit = kitParts(catalog.kit_barcode);
    if (!kit || records.has(kit.barcode)) continue;
    const asset = assetsByExactBarcode.get(kit.barcode) ?? assetsBySourceRow.get(catalog.source_row) ?? null;
    const bookingRowsForItem = bookingsByBarcode.get(kit.barcode) ?? [];
    const booking = bookingRowsForItem.find((row) => bookingIsOut(row.state)) ?? bookingRowsForItem[0] ?? null;
    const check = checksByBarcode.get(kit.barcode) ?? null;
    records.set(kit.barcode, {
      ...kit,
      catalog,
      asset,
      booking,
      physical_state: check?.physical_state ?? null,
      status: statusFor(check),
      technician: check?.checked_by ?? null,
      checked_at: check?.checked_at ?? null,
      discrepancy: check?.detail ?? null,
      booking_state: booking?.state ?? check?.booking_state ?? null,
      ignored: ignoredGroups.has(kit.group),
    });
  }
  return [...records.values()].sort((a, b) => a.group.localeCompare(b.group) || Number(a.number) - Number(b.number));
}

export function includedReconciliationItems(records) {
  return records.filter((record) => !record.ignored);
}

export function reconciliationCounts(records) {
  const counts = { reconciled: 0, collected: 0, second_pass: 0, further_action: 0, not_checked: 0 };
  for (const record of records) counts[record.status] += 1;
  return counts;
}

export function visibleReconciliationItems(records, group, filter) {
  return records.filter((record) => record.group === group && (filter === 'all' || record.status === filter));
}

export function reconciliationExportRows(records) {
  return records.map((record) => ({
    ...record.catalog.original_row,
    'Companion Barcode': record.barcode,
    'Companion Family': record.group,
    'Companion Stock Asset': record.catalog.asset_name ?? record.asset?.asset_name ?? '',
    'Companion Serial': record.asset?.serial ?? '',
    'Companion Manage Bookings State': record.booking_state ?? '',
    'Companion Physical State': record.physical_state ?? 'not_checked',
    'Companion Audit Status': record.status,
    'Companion Technician': record.technician ?? '',
    'Companion Checked At': record.checked_at ?? '',
    'Companion Discrepancy / Reason': record.discrepancy ?? '',
  }));
}
