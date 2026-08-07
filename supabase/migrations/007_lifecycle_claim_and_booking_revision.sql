-- v1.0 lifecycle follow-up: safe legacy lead claim and one Booking refresh signal.
alter table public.audit_sessions
  add column if not exists booking_revision integer not null default 0;

create or replace function public.claim_reconciliation_lead(p_audit_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update audit_sessions
  set lead_user_id = auth.uid()
  where id = p_audit_session_id
    and status = 'open'
    and lead_user_id is null;
  if not found then
    raise exception 'This reconciliation is archived or has already been claimed by another technician.';
  end if;
end;
$$;

create or replace function public.replace_manage_booking_snapshot(p_audit_session_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_open_reconciliation(p_audit_session_id);
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and stock_imported_at is not null) then
    raise exception 'Import Stock.csv before refreshing Manage Bookings.';
  end if;
  -- Suppress per-row activity updates: the revision update below is the one
  -- deterministic realtime signal for the completed replacement transaction.
  perform set_config('siso.suppress_activity_touch', 'on', true);
  delete from manage_booking_rows where audit_session_id = p_audit_session_id;
  insert into manage_booking_rows (audit_session_id, source_row, asset_barcode, state, booked_by, booked_by_email, from_date, to_date, asset_name, serial, course, booking_id, original_row, imported_by)
  select p_audit_session_id,
    nullif(value->>'source_row','')::integer, value->>'asset_barcode', value->>'state',
    nullif(value->>'booked_by',''), nullif(value->>'booked_by_email',''), nullif(value->>'from_date',''), nullif(value->>'to_date',''),
    nullif(value->>'asset_name',''), nullif(value->>'serial',''), nullif(value->>'course',''), nullif(value->>'booking_id',''),
    coalesce(value->'original_row', '{}'::jsonb), nullif(value->>'imported_by','')
  from jsonb_array_elements(p_rows) value;
  update audit_sessions
  set bookings_imported_at = now(), booking_revision = booking_revision + 1
  where id = p_audit_session_id;
end;
$$;

create or replace function public.reject_archived_reconciliation_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
declare session_id uuid;
begin
  if current_setting('siso.allow_reconciliation_delete', true) = 'on' then
    return coalesce(new, old);
  end if;
  session_id := coalesce((to_jsonb(new)->>'audit_session_id')::uuid, (to_jsonb(old)->>'audit_session_id')::uuid);
  perform require_open_reconciliation(session_id);
  if current_setting('siso.suppress_activity_touch', true) is distinct from 'on' then
    update audit_sessions set updated_at = now() where id = session_id;
  end if;
  return coalesce(new, old);
end;
$$;

grant execute on function public.claim_reconciliation_lead(uuid) to authenticated;
revoke execute on function public.claim_reconciliation_lead(uuid) from public;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'audit_sessions') then
    alter publication supabase_realtime add table public.audit_sessions;
  end if;
end $$;
