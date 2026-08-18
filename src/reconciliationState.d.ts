import type { InventoryAsset, KitCatalogEntry, KitCheck, ManageBookingRow, QueueStatus } from './types';

export interface ReconciliationItem {
  barcode: string;
  group: string;
  number: string;
  code: string;
  catalog: KitCatalogEntry;
  asset: InventoryAsset | null;
  booking: ManageBookingRow | null;
  physical_state: KitCheck['physical_state'] | null;
  status: QueueStatus | 'collected';
  technician: string | null;
  checked_at: string | null;
  discrepancy: string | null;
  booking_state: string | null;
  ignored: boolean;
}

export function reconciliationItems(catalog: KitCatalogEntry[], assets: InventoryAsset[], bookings: ManageBookingRow[], checks: KitCheck[], ignoredGroups?: Set<string>): ReconciliationItem[];
export function includedReconciliationItems(records: ReconciliationItem[]): ReconciliationItem[];
export function reconciliationCounts(records: ReconciliationItem[]): Record<ReconciliationItem['status'], number>;
export function visibleReconciliationItems(records: ReconciliationItem[], group: string, filter: ReconciliationItem['status'] | 'all'): ReconciliationItem[];
export function reconciliationExportRows(records: ReconciliationItem[]): Record<string, unknown>[];
