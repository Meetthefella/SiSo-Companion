-- v1.0 lifecycle hardening: atomic lead-owned Stock scope and explicit lead name.
alter table public.audit_sessions add column if not exists lead_name text;

drop function if exists public.claim_reconciliation_lead(uuid);

create or replace function public.claim_reconciliation_lead(p_audit_session_id uuid, p_lead_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if nullif(trim(p_lead_name), '') is null then raise exception 'A lead name is required.'; end if;
  update audit_sessions set lead_user_id = auth.uid(), lead_name = trim(p_lead_name)
  where id = p_audit_session_id and status = 'open' and lead_user_id is null;
  if not found then raise exception 'This reconciliation is archived or has already been claimed by another technician.'; end if;
end;
$$;

create or replace function public.import_stock_snapshot(p_audit_session_id uuid, p_assets jsonb, p_kits jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if jsonb_typeof(p_kits) <> 'array' or jsonb_array_length(p_kits) = 0 then raise exception 'Stock import must contain at least one valid bookable barcode.'; end if;
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open' and stock_imported_at is null and lead_user_id = auth.uid()) then raise exception 'Only the lead can import Stock for an active reconciliation that has no fixed scope.'; end if;
  perform set_config('siso.suppress_activity_touch', 'on', true);
  delete from kit_catalog where audit_session_id = p_audit_session_id;
  delete from inventory_assets where audit_session_id = p_audit_session_id;
  insert into kit_catalog (audit_session_id, source_row, kit_barcode, kit_code, kit_group, asset_name, category, original_row)
  select p_audit_session_id, nullif(value->>'source_row', '')::integer, value->>'kit_barcode', value->>'kit_code', value->>'kit_group', nullif(value->>'asset_name', ''), nullif(value->>'category', ''), coalesce(value->'original_row', '{}'::jsonb) from jsonb_array_elements(p_kits) value;
  insert into inventory_assets (audit_session_id, source_row, siso_asset_id, asset_name, description, category, asset_type, make, model, serial, serial_normalized, barcode, bag_label, label_required, label_status, label_method, original_row)
  select p_audit_session_id, nullif(value->>'source_row', '')::integer, nullif(value->>'siso_asset_id', ''), value->>'asset_name', nullif(value->>'description', ''), nullif(value->>'category', ''), nullif(value->>'asset_type', ''), nullif(value->>'make', ''), nullif(value->>'model', ''), value->>'serial', value->>'serial_normalized', nullif(value->>'barcode', ''), nullif(value->>'bag_label', ''), coalesce((value->>'label_required')::boolean, false), value->>'label_status', value->>'label_method', coalesce(value->'original_row', '{}'::jsonb) from jsonb_array_elements(p_assets) value;
  update audit_sessions set stock_imported_at = now() where id = p_audit_session_id;
end;
$$;

grant execute on function public.claim_reconciliation_lead(uuid, text), public.import_stock_snapshot(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.claim_reconciliation_lead(uuid, text), public.import_stock_snapshot(uuid, jsonb, jsonb) from public;
