import Papa from 'papaparse';
import type { AuditResult, BulkCount, InventoryAsset } from './types';

export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function augmentedRows(assets: InventoryAsset[], results: AuditResult[]): Record<string, unknown>[] {
  const resultByAsset = new Map(results.map((r) => [r.inventory_asset_id, r]));
  return assets.map((asset) => {
    const result = resultByAsset.get(asset.id);
    return {
      ...asset.original_row,
      'Companion Audit Status': result?.queue_status ?? 'not_checked',
      'Companion Audit Stage': result?.audit_stage ?? 'first_pass',
      'Companion Reconciliation': result?.outcome ?? '',
      'Companion Exception Reason': result?.exception_reason ?? '',
      'Companion Next Action': result?.next_action ?? '',
      'Companion QR Label Required': result?.label_required ? 'Yes' : 'No',
      'Companion Label Method': result?.label_method ?? asset.label_method ?? '',
      'Companion QR Label Status': asset.label_status ?? '',
      'Companion Correct Kit': asset.bag_label ?? '',
      'Companion Verified By': result?.verified_by ?? '',
      'Companion Verified At': result?.verified_at ?? '',
    };
  });
}

export function bulkBarcodeRows(counts: BulkCount[]): Record<string, unknown>[] {
  return counts.map((c) => ({
    'Item Type': c.item_name,
    Quantity: c.quantity,
    'QR Labels Required': c.barcode_required ? c.quantity : 0,
    'Proposed Prefix': c.proposed_prefix ?? '',
    'Proposed Start': c.proposed_start_number ?? '',
    'Proposed End': c.proposed_end_number ?? '',
    'Label Method': c.label_method,
    Notes: c.notes ?? '',
    'Counted By': c.counted_by,
    'Counted At': c.created_at,
  }));
}
