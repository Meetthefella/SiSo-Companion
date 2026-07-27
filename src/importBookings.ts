import Papa from 'papaparse';
import { supabase } from './supabase';

const clean = (v: unknown) => String(v ?? '').trim();
const normalizeBarcode = (v: unknown) => clean(v).replace(/\s+/g, '').toUpperCase();

export interface BookingImportSummary {
  imported: number;
  uniqueBarcodes: number;
  skippedNoBarcode: number;
}

export async function importManageBookingsCsv(file: File, auditSessionId: string): Promise<BookingImportSummary> {
  const text = await file.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true }) as { data: Record<string, string>[]; errors: Array<{ message: string }> };
  if (parsed.errors.length) throw new Error(parsed.errors[0]?.message ?? 'Unable to parse Manage Bookings CSV.');

  const rows: Record<string, string>[] = parsed.data;
  const records = rows.map((row: Record<string, string>, i: number) => {
    const barcode = normalizeBarcode(row['Asset Barcode'] ?? row['Barcode']);
    if (!barcode) return null;
    return {
      audit_session_id: auditSessionId,
      source_row: i + 2,
      asset_barcode: barcode,
      state: clean(row.State) || 'Unknown',
      booked_by: clean(row['Booked By']) || null,
      booked_by_email: clean(row['Booked By User Email']) || null,
      from_date: clean(row['From Date']) || null,
      to_date: clean(row['To Date']) || null,
      asset_name: clean(row['Asset Name']) || null,
      serial: clean(row.Serial) || null,
      course: clean(row.Course) || null,
      booking_id: clean(row['Booking ID']) || null,
      original_row: row,
      imported_by: null,
    };
  }).filter(Boolean) as Record<string, unknown>[];

  const skippedNoBarcode = rows.length - records.length;
  const { error: clearError } = await supabase.from('manage_booking_rows').delete().eq('audit_session_id', auditSessionId);
  if (clearError) throw clearError;

  for (let i = 0; i < records.length; i += 250) {
    const { error } = await supabase.from('manage_booking_rows').insert(records.slice(i, i + 250));
    if (error) throw error;
  }

  return { imported: records.length, uniqueBarcodes: new Set(records.map(r => r.asset_barcode as string)).size, skippedNoBarcode };
}
