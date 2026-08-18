import Papa from 'papaparse';
import type { BulkCount } from './types';

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
