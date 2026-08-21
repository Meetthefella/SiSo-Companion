-- Coalesce a whole kit-family action into one transaction and one realtime signal.
alter table public.audit_sessions
  add column if not exists progress_revision integer not null default 0;

create or replace function public.reconcile_kit_group(
  p_audit_session_id uuid,
  p_kit_group text,
  p_selected_barcodes jsonb,
  p_checked_by text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  selected_barcodes text[];
begin
  if nullif(trim(p_kit_group), '') is null then raise exception 'A kit group is required.'; end if;
  if nullif(trim(p_checked_by), '') is null then raise exception 'A technician name is required.'; end if;
  if p_selected_barcodes is null or jsonb_typeof(p_selected_barcodes) <> 'array' then raise exception 'Selected barcodes must be an array.'; end if;
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open') then raise exception 'This reconciliation is archived and read-only.'; end if;
  if not exists (select 1 from kit_catalog where audit_session_id = p_audit_session_id and kit_group = trim(p_kit_group)) then raise exception 'That kit group is not part of this reconciliation.'; end if;

  select coalesce(array_agg(value), array[]::text[])
  into selected_barcodes
  from jsonb_array_elements_text(p_selected_barcodes) value;

  -- The child-row lifecycle trigger therefore does not emit one session update
  -- per barcode. The revision update below is the single completed-action signal.
  perform set_config('siso.suppress_activity_touch', 'on', true);

  with active_bookings as (
    select distinct on (asset_barcode) asset_barcode, state, booked_by
    from manage_booking_rows
    where audit_session_id = p_audit_session_id
      and trim(state) !~* '^(available|returned|complete|completed|cancelled|canceled|in store)$'
    order by asset_barcode, source_row desc nulls last, id desc
  )
  insert into kit_checks (
    audit_session_id, kit_barcode, kit_code, kit_group, physical_state,
    booking_state, comparison_status, detail, checked_by, checked_at, updated_at
  )
  select
    p_audit_session_id,
    catalog.kit_barcode,
    catalog.kit_code,
    catalog.kit_group,
    case when catalog.kit_barcode = any(selected_barcodes) then 'present' else 'absent' end,
    active.state,
    case
      when catalog.kit_barcode = any(selected_barcodes) and active.asset_barcode is not null then 'siso_update'
      when catalog.kit_barcode <> all(selected_barcodes) and active.asset_barcode is null then 'missing'
      when catalog.kit_barcode <> all(selected_barcodes) and active.asset_barcode is not null then 'collected'
      else 'reconciled'
    end,
    case
      when catalog.kit_barcode = any(selected_barcodes) and active.asset_barcode is not null then format('Physically present but SiSo shows %s%s.', active.state, case when active.booked_by is not null then format(' to %s', active.booked_by) else '' end)
      when catalog.kit_barcode <> all(selected_barcodes) and active.asset_barcode is null then 'Not physically present and not shown as out in Manage Bookings.'
      when catalog.kit_barcode <> all(selected_barcodes) and active.asset_barcode is not null then format('Physically absent and correctly shown as %s%s.', active.state, case when active.booked_by is not null then format(' to %s', active.booked_by) else '' end)
      else 'Physically present and not shown as out.'
    end,
    trim(p_checked_by), now(), now()
  from kit_catalog catalog
  left join active_bookings active on active.asset_barcode = catalog.kit_barcode
  where catalog.audit_session_id = p_audit_session_id
    and catalog.kit_group = trim(p_kit_group)
  on conflict (audit_session_id, kit_barcode) do update set
    physical_state = excluded.physical_state,
    booking_state = excluded.booking_state,
    comparison_status = excluded.comparison_status,
    detail = excluded.detail,
    checked_by = excluded.checked_by,
    checked_at = excluded.checked_at,
    updated_at = excluded.updated_at;

  update audit_sessions set progress_revision = progress_revision + 1 where id = p_audit_session_id;
end;
$$;

create or replace function public.reset_kit_group_progress(p_audit_session_id uuid, p_kit_group text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if nullif(trim(p_kit_group), '') is null then raise exception 'A kit group is required.'; end if;
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open') then raise exception 'This reconciliation is archived and read-only.'; end if;
  perform set_config('siso.suppress_activity_touch', 'on', true);
  delete from kit_checks where audit_session_id = p_audit_session_id and kit_group = trim(p_kit_group);
  update audit_sessions set progress_revision = progress_revision + 1 where id = p_audit_session_id;
end;
$$;

create or replace function public.reset_reconciliation_progress(p_audit_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open' and lead_user_id = auth.uid()) then
    raise exception 'Only the reconciliation lead can reset progress.';
  end if;
  perform set_config('siso.suppress_activity_touch', 'on', true);
  delete from audit_results where audit_session_id = p_audit_session_id;
  delete from kit_checks where audit_session_id = p_audit_session_id;
  delete from unknown_serials where audit_session_id = p_audit_session_id;
  delete from bulk_counts where audit_session_id = p_audit_session_id;
  update audit_sessions set progress_revision = progress_revision + 1 where id = p_audit_session_id;
end;
$$;

grant execute on function public.reconcile_kit_group(uuid, text, jsonb, text), public.reset_kit_group_progress(uuid, text) to authenticated;
revoke execute on function public.reconcile_kit_group(uuid, text, jsonb, text), public.reset_kit_group_progress(uuid, text) from public;
