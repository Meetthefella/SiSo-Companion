-- A Booking refresh and the derived kit status must become visible together.
create or replace function public.replace_manage_booking_snapshot(p_audit_session_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_open_reconciliation(p_audit_session_id);
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and stock_imported_at is not null) then
    raise exception 'Import Stock.csv before refreshing Manage Bookings.';
  end if;

  perform set_config('siso.suppress_activity_touch', 'on', true);
  delete from manage_booking_rows where audit_session_id = p_audit_session_id;
  insert into manage_booking_rows (audit_session_id, source_row, asset_barcode, state, booked_by, booked_by_email, from_date, to_date, asset_name, serial, course, booking_id, original_row, imported_by)
  select p_audit_session_id,
    nullif(value->>'source_row','')::integer, value->>'asset_barcode', value->>'state',
    nullif(value->>'booked_by',''), nullif(value->>'booked_by_email',''), nullif(value->>'from_date',''), nullif(value->>'to_date',''),
    nullif(value->>'asset_name',''), nullif(value->>'serial',''), nullif(value->>'course',''), nullif(value->>'booking_id',''),
    coalesce(value->'original_row', '{}'::jsonb), nullif(value->>'imported_by','')
  from jsonb_array_elements(p_rows) value;

  -- This is in the same transaction, so other technicians never see refreshed
  -- booking rows paired with kit checks calculated from the old snapshot.
  perform public.recalculate_kit_checks(p_audit_session_id);
  update audit_sessions
  set bookings_imported_at = now(), booking_revision = booking_revision + 1
  where id = p_audit_session_id;
end;
$$;
