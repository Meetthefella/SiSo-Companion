-- Upgrade the original row-by-row recalculation without rewriting migration 011.
create or replace function public.recalculate_kit_checks(p_audit_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open') then raise exception 'This reconciliation is archived and read-only.'; end if;
  perform set_config('siso.suppress_activity_touch', 'on', true);

  with active_bookings as (
    select distinct on (asset_barcode) asset_barcode, state, booked_by
    from manage_booking_rows
    where audit_session_id = p_audit_session_id and trim(state) !~* '^(available|returned|complete|completed|cancelled|canceled|in store)$'
    order by asset_barcode, source_row desc nulls last, id desc
  ), derived as (
    select checks.id, checks.physical_state, active.asset_barcode, active.state, active.booked_by
    from kit_checks checks
    left join active_bookings active on active.asset_barcode = checks.kit_barcode
    where checks.audit_session_id = p_audit_session_id
  )
  update kit_checks checks
  set booking_state = derived.state,
      comparison_status = case when derived.asset_barcode is not null and derived.physical_state = 'present' then 'siso_update' when derived.asset_barcode is not null then 'collected' when derived.physical_state = 'present' then 'reconciled' else 'missing' end,
      detail = case when derived.asset_barcode is not null and derived.physical_state = 'present' then format('Physically present but SiSo shows %s%s.', derived.state, case when derived.booked_by is not null then format(' to %s', derived.booked_by) else '' end) when derived.asset_barcode is not null then format('Physically absent and correctly shown as %s%s.', derived.state, case when derived.booked_by is not null then format(' to %s', derived.booked_by) else '' end) when derived.physical_state = 'present' then 'Physically present and not shown as out.' else 'Not physically present and not shown as out in Manage Bookings.' end,
      updated_at = now()
  from derived
  where checks.id = derived.id;

  update audit_sessions set progress_revision = progress_revision + 1 where id = p_audit_session_id;
end;
$$;
