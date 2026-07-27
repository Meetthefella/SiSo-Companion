-- v0.2.2: autonomous kit-presence reconciliation against Manage Bookings.
create table if not exists public.manage_booking_rows (
  id uuid primary key default gen_random_uuid(),
  audit_session_id uuid not null references public.audit_sessions(id) on delete cascade,
  source_row integer,
  asset_barcode text not null,
  state text not null,
  booked_by text,
  booked_by_email text,
  from_date text,
  to_date text,
  asset_name text,
  serial text,
  course text,
  booking_id text,
  original_row jsonb not null default '{}'::jsonb,
  imported_by text,
  created_at timestamptz not null default now()
);
create index if not exists manage_booking_rows_session_barcode_idx on public.manage_booking_rows(audit_session_id, asset_barcode);

create table if not exists public.kit_checks (
  id uuid primary key default gen_random_uuid(),
  audit_session_id uuid not null references public.audit_sessions(id) on delete cascade,
  kit_barcode text not null,
  kit_code text not null,
  kit_group text not null,
  physical_state text not null check (physical_state in ('present','absent')),
  booking_state text,
  comparison_status text not null check (comparison_status in ('reconciled','siso_update','missing','second_pass')),
  detail text,
  checked_by text not null,
  checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(audit_session_id, kit_barcode)
);
create index if not exists kit_checks_session_group_idx on public.kit_checks(audit_session_id, kit_group);

alter table public.manage_booking_rows enable row level security;
alter table public.kit_checks enable row level security;

do $$ declare t text; begin
  foreach t in array array['manage_booking_rows','kit_checks'] loop
    execute format('drop policy if exists "pilot read" on public.%I',t);
    execute format('drop policy if exists "pilot insert" on public.%I',t);
    execute format('drop policy if exists "pilot update" on public.%I',t);
    execute format('drop policy if exists "pilot delete" on public.%I',t);
    execute format('create policy "pilot read" on public.%I for select to authenticated using (true)',t);
    execute format('create policy "pilot insert" on public.%I for insert to authenticated with check (true)',t);
    execute format('create policy "pilot update" on public.%I for update to authenticated using (true) with check (true)',t);
    execute format('create policy "pilot delete" on public.%I for delete to authenticated using (true)',t);
  end loop;
end $$;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='kit_checks') then
    alter publication supabase_realtime add table public.kit_checks;
  end if;
end $$;
