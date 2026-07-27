-- Required for the real SiSo export: some serial values are duplicated or damaged by spreadsheet scientific notation.
do $$ declare constraint_name text; begin
  select tc.constraint_name into constraint_name from information_schema.table_constraints tc join information_schema.constraint_column_usage ccu on ccu.constraint_name=tc.constraint_name and ccu.constraint_schema=tc.constraint_schema where tc.table_schema='public' and tc.table_name='inventory_assets' and tc.constraint_type='UNIQUE' group by tc.constraint_name having array_agg(ccu.column_name order by ccu.column_name)=array['audit_session_id','serial_normalized'];
  if constraint_name is not null then execute format('alter table public.inventory_assets drop constraint %I',constraint_name); end if;
end $$;
create unique index if not exists inventory_assets_session_source_row_uidx on public.inventory_assets(audit_session_id,source_row);
