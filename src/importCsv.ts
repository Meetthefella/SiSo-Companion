import Papa from 'papaparse';
import { supabase } from './supabase';
import { deriveKitLabel, normalizeSerial } from './serial';

export interface ImportReport { imported: number; skippedNoSerial: number; duplicateSerials: number; errors: string[] }

function pick(row: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

export async function parseInventoryCsv(file: File, auditSessionId: string) {
  const parsed = await new Promise<any>((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
      complete: resolve,
      error: reject,
    });
  });

  const seen = new Set<string>();
  let duplicateSerials = 0;
  const assets = (parsed.data as Record<string, string>[]).flatMap((row: Record<string, string>, index: number) => {
    const serial = pick(row, 'Serial', 'serial');
    const normalized = normalizeSerial(serial);
    if (!normalized) return [];
    if (seen.has(normalized)) duplicateSerials += 1;
    seen.add(normalized);
    const barcode = pick(row, 'Barcodes', 'Barcode', 'barcode') || null;
    return [{
      audit_session_id: auditSessionId,
      source_row: Number(pick(row, '#')) || index + 1,
      siso_asset_id: pick(row, '#ID', 'Asset ID', 'ID') || null,
      asset_name: pick(row, 'Asset Name', 'Original Name', 'Name') || 'Unnamed asset',
      description: pick(row, 'Asset Description', 'Original Description') || null,
      category: pick(row, 'Category') || null,
      asset_type: pick(row, 'Asset Type', 'Category') || null,
      make: pick(row, 'Make') || null,
      model: pick(row, 'Model') || null,
      serial,
      serial_normalized: normalized,
      barcode,
      bag_label: deriveKitLabel(barcode),
      label_required: Boolean(barcode),
      label_status: barcode ? 'required' : 'not_required',
      label_method: 'pending',
      original_row: row,
    }];
  });

  return {
    assets,
    rows: parsed.data.length,
    duplicateSerials,
    errors: parsed.errors.map((e: {row?: number; message: string}) => `Row ${e.row ?? '?'}: ${e.message}`),
  };
}

export async function importInventoryCsv(file: File, auditSessionId: string): Promise<ImportReport> {
  const parsed = await parseInventoryCsv(file, auditSessionId);
  const chunkSize = 400;
  for (let i = 0; i < parsed.assets.length; i += chunkSize) {
    const { error } = await supabase.from('inventory_assets').upsert(parsed.assets.slice(i, i + chunkSize), {
      onConflict: 'audit_session_id,source_row',
      ignoreDuplicates: false,
    });
    if (error) throw new Error(`Inventory import failed: ${error.message}`);
  }
  return {
    imported: parsed.assets.length,
    skippedNoSerial: parsed.rows - parsed.assets.length,
    duplicateSerials: parsed.duplicateSerials,
    errors: parsed.errors,
  };
}
