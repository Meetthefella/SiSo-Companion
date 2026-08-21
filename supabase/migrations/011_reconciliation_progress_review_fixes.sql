-- Keep filtered family reconciliation scoped to the tiles the technician can see,
-- and use progress revisions for every kit-check mutation.
drop function if exists public.reconcile_kit_group(uuid, text, jsonb, text);

create or replace function public.reconcile_kit_group(
  p_audit_session_id uuid,
  p_kit_group text,
  p_target_barcodes jsonb,
  p_selected_barcodes jsonb,
  p_checked_by text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  target_barcodes text[];
  selected_barcodes text[];
begin
  if nullif(trim(p_kit_group), '') is null then raise exception 'A kit group is required.'; end if;
  if nullif(trim(p_checked_by), '') is null then raise exception 'A technician name is required.'; end if;
  if p_target_barcodes is null or jsonb_typeof(p_target_barcodes) <> 'array' or p_selected_barcodes is null or jsonb_typeof(p_selected_barcodes) <> 'array' then raise exception 'Target and selected barcodes must be arrays.'; end if;
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open') then raise exception 'This reconciliation is archived and read-only.'; end if;

  select coalesce(array_agg(value), array[]::text[]) into target_barcodes from jsonb_array_elements_text(p_target_barcodes) value;
  select coalesce(array_agg(value), array[]::text[]) into selected_barcodes from jsonb_array_elements_text(p_selected_barcodes) value;
  if cardinality(target_barcodes) = 0 then return; end if;
  if exists (
    select 1 from unnest(target_barcodes) barcode
    where not exists (select 1 from kit_catalog where audit_session_id = p_audit_session_id and kit_group = trim(p_kit_group) and kit_barcode = barcode)
  ) then raise exception 'One or more barcodes are not part of this reconciliation section.'; end if;
  if exists (select 1 from unnest(selected_barcodes) barcode where not (barcode = any(target_barcodes))) then raise exception 'Selected barcodes must belong to the reconciled section.'; end if;

  perform set_config('siso.suppress_activity_touch', 'on', true);
  with active_bookings as (
    select distinct on (asset_barcode) asset_barcode, state, booked_by
    from manage_booking_rows
    where audit_session_id = p_audit_session_id and trim(state) !~* '^(available|returned|complete|completed|cancelled|canceled|in store)$'
    order by asset_barcode, source_row desc nulls last, id desc
  )
  insert into kit_checks (audit_session_id, kit_barcode, kit_code, kit_group, physical_state, booking_state, comparison_status, detail, checked_by, checked_at, updated_at)
  select p_audit_session_id, catalog.kit_barcode, catalog.kit_code, catalog.kit_group,
    case when catalog.kit_barcode = any(selected_barcodes) then 'present' else 'absent' end,
    active.state,
    case when catalog.kit_barcode = any(selected_barcodes) and active.asset_barcode is not null then 'siso_update' when catalog.kit_barcode <> all(selected_barcodes) and active.asset_barcode is null then 'missing' when catalog.kit_barcode <> all(selected_barcodes) and active.asset_barcode is not null then 'collected' else 'reconciled' end,
    case when catalog.kit_barcode = any(selected_barcodes) and active.asset_barcode is not null then format('Physically present but SiSo shows %s%s.', active.state, case when active.booked_by is not null then format(' to %s', active.booked_by) else '' end) when catalog.kit_barcode <> all(selected_barcodes) and active.asset_barcode is null then 'Not physically present and not shown as out in Manage Bookings.' when catalog.kit_barcode <> all(selected_barcodes) and active.asset_barcode is not null then format('Physically absent and correctly shown as %s%s.', active.state, case when active.booked_by is not null then format(' to %s', active.booked_by) else '' end) else 'Physically present and not shown as out.' end,
    trim(p_checked_by), now(), now()
  from kit_catalog catalog
  left join active_bookings active on active.asset_barcode = catalog.kit_barcode
  where catalog.audit_session_id = p_audit_session_id and catalog.kit_group = trim(p_kit_group) and catalog.kit_barcode = any(target_barcodes)
  on conflict (audit_session_id, kit_barcode) do update set physical_state = excluded.physical_state, booking_state = excluded.booking_state, comparison_status = excluded.comparison_status, detail = excluded.detail, checked_by = excluded.checked_by, checked_at = excluded.checked_at, updated_at = excluded.updated_at;

  update audit_sessions set progress_revision = progress_revision + 1 where id = p_audit_session_id;
end;
$$;

create or replace function public.recalculate_kit_checks(p_audit_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare check_row kit_checks%rowtype; active_booking record;
begin
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open') then raise exception 'This reconciliation is archived and read-only.'; end if;
  perform set_config('siso.suppress_activity_touch', 'on', true);
  for check_row in select * from kit_checks where audit_session_id = p_audit_session_id loop
    select state, booked_by into active_booking from manage_booking_rows where audit_session_id = p_audit_session_id and asset_barcode = check_row.kit_barcode and trim(state) !~* '^(available|returned|complete|completed|cancelled|canceled|in store)$' order by source_row desc nulls last, id desc limit 1;
    if found then
      update kit_checks set booking_state = active_booking.state, comparison_status = case when check_row.physical_state = 'present' then 'siso_update' else 'collected' end, detail = case when check_row.physical_state = 'present' then format('Physically present but SiSo shows %s%s.', active_booking.state, case when active_booking.booked_by is not null then format(' to %s', active_booking.booked_by) else '' end) else format('Physically absent and correctly shown as %s%s.', active_booking.state, case when active_booking.booked_by is not null then format(' to %s', active_booking.booked_by) else '' end) end, updated_at = now() where id = check_row.id;
    else
      update kit_checks set booking_state = null, comparison_status = case when check_row.physical_state = 'present' then 'reconciled' else 'missing' end, detail = case when check_row.physical_state = 'present' then 'Physically present and not shown as out.' else 'Not physically present and not shown as out in Manage Bookings.' end, updated_at = now() where id = check_row.id;
    end if;
  end loop;
  update audit_sessions set progress_revision = progress_revision + 1 where id = p_audit_session_id;
end;
$$;

create or replace function public.reopen_kit_check(p_audit_session_id uuid, p_kit_check_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open') then raise exception 'This reconciliation is archived and read-only.'; end if;
  perform set_config('siso.suppress_activity_touch', 'on', true);
  delete from kit_checks where id = p_kit_check_id and audit_session_id = p_audit_session_id;
  if not found then raise exception 'That kit check is no longer available.'; end if;
  update audit_sessions set progress_revision = progress_revision + 1 where id = p_audit_session_id;
end;
$$;

grant execute on function public.reconcile_kit_group(uuid, text, jsonb, jsonb, text), public.recalculate_kit_checks(uuid), public.reopen_kit_check(uuid, uuid) to authenticated;
revoke execute on function public.reconcile_kit_group(uuid, text, jsonb, jsonb, text), public.recalculate_kit_checks(uuid), public.reopen_kit_check(uuid, uuid) from public;
