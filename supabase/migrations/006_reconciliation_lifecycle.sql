-- v1.0 reconciliation lifecycle. Additive and data-preserving.
alter table public.audit_sessions
  add column if not exists lead_user_id uuid references auth.users(id),
  add column if not exists stock_imported_at timestamptz,
  add column if not exists bookings_imported_at timestamptz,
  add column if not exists archived_at timestamptz;

-- Only the recorded lead can alter reconciliation lifecycle fields directly.
-- Existing shared child-table policies remain unchanged so technicians can continue
-- recording observations within an open reconciliation.
drop policy if exists "pilot update" on public.audit_sessions;
create policy "lead lifecycle update" on public.audit_sessions for update to authenticated
using (lead_user_id = auth.uid()) with check (lead_user_id = auth.uid());

-- Keep the existing updated_at field meaningful for the lifecycle header.
drop trigger if exists audit_sessions_updated_at on public.audit_sessions;
create trigger audit_sessions_updated_at before update on public.audit_sessions
for each row execute function public.set_updated_at();

create or replace function public.require_open_reconciliation(p_session_id uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not exists (select 1 from audit_sessions where id = p_session_id and status = 'open') then
    raise exception 'This reconciliation is archived and read-only.';
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
  delete from manage_booking_rows where audit_session_id = p_audit_session_id;
  insert into manage_booking_rows (audit_session_id, source_row, asset_barcode, state, booked_by, booked_by_email, from_date, to_date, asset_name, serial, course, booking_id, original_row, imported_by)
  select p_audit_session_id,
    nullif(value->>'source_row','')::integer, value->>'asset_barcode', value->>'state',
    nullif(value->>'booked_by',''), nullif(value->>'booked_by_email',''), nullif(value->>'from_date',''), nullif(value->>'to_date',''),
    nullif(value->>'asset_name',''), nullif(value->>'serial',''), nullif(value->>'course',''), nullif(value->>'booking_id',''),
    coalesce(value->'original_row', '{}'::jsonb), nullif(value->>'imported_by','')
  from jsonb_array_elements(p_rows) value;
  update audit_sessions set bookings_imported_at = now() where id = p_audit_session_id;
end;
$$;

create or replace function public.reset_reconciliation_progress(p_audit_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open' and lead_user_id = auth.uid()) then
    raise exception 'Only the reconciliation lead can reset progress.';
  end if;
  delete from audit_results where audit_session_id = p_audit_session_id;
  delete from kit_checks where audit_session_id = p_audit_session_id;
  delete from unknown_serials where audit_session_id = p_audit_session_id;
  delete from bulk_counts where audit_session_id = p_audit_session_id;
end;
$$;

create or replace function public.archive_reconciliation(p_audit_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open' and lead_user_id = auth.uid()) then
    raise exception 'Only the reconciliation lead can archive this reconciliation.';
  end if;
  update audit_sessions set status = 'archived', archived_at = now() where id = p_audit_session_id;
end;
$$;

create or replace function public.delete_reconciliation(p_audit_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and lead_user_id = auth.uid()) then
    raise exception 'Only the reconciliation lead can delete this reconciliation.';
  end if;
  perform set_config('siso.allow_reconciliation_delete', 'on', true);
  delete from audit_sessions where id = p_audit_session_id;
end;
$$;

grant execute on function public.replace_manage_booking_snapshot(uuid, jsonb), public.reset_reconciliation_progress(uuid), public.archive_reconciliation(uuid), public.delete_reconciliation(uuid) to authenticated;
revoke execute on function public.replace_manage_booking_snapshot(uuid, jsonb), public.reset_reconciliation_progress(uuid), public.archive_reconciliation(uuid), public.delete_reconciliation(uuid) from public;

create or replace function public.reject_archived_reconciliation_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
declare session_id uuid;
begin
  if current_setting('siso.allow_reconciliation_delete', true) = 'on' then
    return coalesce(new, old);
  end if;
  session_id := coalesce((to_jsonb(new)->>'audit_session_id')::uuid, (to_jsonb(old)->>'audit_session_id')::uuid);
  perform require_open_reconciliation(session_id);
  update audit_sessions set updated_at = now() where id = session_id;
  return coalesce(new, old);
end;
$$;

create or replace function public.reject_stock_scope_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
declare session_id uuid;
begin
  if current_setting('siso.allow_reconciliation_delete', true) = 'on' then
    return coalesce(new, old);
  end if;
  session_id := coalesce((to_jsonb(new)->>'audit_session_id')::uuid, (to_jsonb(old)->>'audit_session_id')::uuid);
  if exists (select 1 from audit_sessions where id = session_id and stock_imported_at is not null) then
    raise exception 'Stock scope is fixed for this reconciliation.';
  end if;
  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['inventory_assets','kit_catalog','manage_booking_rows','audit_results','kit_checks','unknown_serials','bulk_counts'] loop
    execute format('drop trigger if exists reject_archived_%1$s on public.%1$s', t);
    execute format('create trigger reject_archived_%1$s before insert or update or delete on public.%1$s for each row execute function public.reject_archived_reconciliation_mutation()', t);
  end loop;
end $$;

drop trigger if exists reject_stock_scope_inventory_assets on public.inventory_assets;
create trigger reject_stock_scope_inventory_assets before insert or update or delete on public.inventory_assets
for each row execute function public.reject_stock_scope_mutation();
drop trigger if exists reject_stock_scope_kit_catalog on public.kit_catalog;
create trigger reject_stock_scope_kit_catalog before insert or update or delete on public.kit_catalog
for each row execute function public.reject_stock_scope_mutation();
