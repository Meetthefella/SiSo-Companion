import Papa from 'papaparse';
import { supabase } from './supabase';
import { deriveKitLabel, normalizeSerial } from './serial';

export interface ImportReport {
  imported: number;
  skippedNoSerial: number;
  duplicateSerials: number;
  errors: string[];
}

function pick(row: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

export async function parseInventoryCsv(file: File, auditSessionId: string) {
  const parsed = await new Promise<any>((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header: string) => header.trim(),
      complete: resolve,
      error: reject,
    });
  });

  const seen = new Set<string>();
  let duplicateSerials = 0;

  const assets = (parsed.data as Record<string, string>[]).flatMap(
    (row: Record<string, string>, index: number) => {
      const serial = pick(row, 'Serial', 'serial');
      const normalized = normalizeSerial(serial);
      if (!normalized) return [];

      if (seen.has(normalized)) duplicateSerials += 1;
      seen.add(normalized);

      const barcode = pick(row, 'Barcodes', 'Barcode', 'barcode') || null;
      const parsedSourceRow = Number(pick(row, '#'));

      return [
        {
          audit_session_id: auditSessionId,
          source_row: Number.isFinite(parsedSourceRow) && parsedSourceRow > 0
            ? parsedSourceRow
            : index + 1,
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
        },
      ];
    },
  );

  return {
    assets,
    rows: parsed.data.length,
    duplicateSerials,
    errors: parsed.errors.map(
      (error: { row?: number; message: string }) =>
        `Row ${error.row ?? '?'}: ${error.message}`,
    ),
  };
}

/**
 * Import without relying on a database ON CONFLICT constraint.
 *
 * Existing rows are matched by source_row within the selected audit session and
 * updated by their primary key. New rows are inserted in batches. This preserves
 * legitimate duplicate serials and works whether or not migration 002 has been run.
 */
export async function importInventoryCsv(
  file: File,
  auditSessionId: string,
): Promise<ImportReport> {
  const parsed = await parseInventoryCsv(file, auditSessionId);

  const { data: existingRows, error: existingError } = await supabase
    .from('inventory_assets')
    .select('id,source_row')
    .eq('audit_session_id', auditSessionId);

  if (existingError) {
    throw new Error(`Could not inspect existing inventory: ${existingError.message}`);
  }

  const existingBySourceRow = new Map<number, string>();
  for (const row of existingRows ?? []) {
    if (typeof row.source_row === 'number') {
      existingBySourceRow.set(row.source_row, row.id);
    }
  }

  const rowsToInsert: typeof parsed.assets = [];
  const rowsToUpdate: Array<{ id: string; asset: (typeof parsed.assets)[number] }> = [];

  for (const asset of parsed.assets) {
    const existingId = existingBySourceRow.get(asset.source_row);
    if (existingId) {
      rowsToUpdate.push({ id: existingId, asset });
    } else {
      rowsToInsert.push(asset);
    }
  }

  const chunkSize = 300;
  for (let index = 0; index < rowsToInsert.length; index += chunkSize) {
    const { error } = await supabase
      .from('inventory_assets')
      .insert(rowsToInsert.slice(index, index + chunkSize));

    if (error) {
      throw new Error(`Inventory import failed: ${error.message}`);
    }
  }

  // Updates are intentionally explicit rather than upserts, so no unique or
  // exclusion constraint is required. Re-imports are uncommon and this keeps the
  // initial pilot safe and predictable.
  for (const row of rowsToUpdate) {
    const { error } = await supabase
      .from('inventory_assets')
      .update(row.asset)
      .eq('id', row.id)
      .eq('audit_session_id', auditSessionId);

    if (error) {
      throw new Error(
        `Inventory row ${row.asset.source_row} could not be updated: ${error.message}`,
      );
    }
  }

  return {
    imported: parsed.assets.length,
    skippedNoSerial: parsed.rows - parsed.assets.length,
    duplicateSerials: parsed.duplicateSerials,
    errors: parsed.errors,
  };
}
