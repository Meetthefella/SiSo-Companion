-- SiSo Companion v0.2.4
-- Catalogue operational kit barcodes even when the SiSo record is not typed as a Kit
-- and has no serial number. Safe additive migration.

create table if not exists public.kit_catalog (
  id uuid primary key default gen_random_uuid(),
  audit_session_id uuid not null references public.audit_sessions(id) on delete cascade,
  source_row integer,
  kit_barcode text not null,
  kit_code text not null,
  kit_group text not null,
  asset_name text,
  category text,
  original_row jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (audit_session_id, kit_barcode)
);

create index if not exists kit_catalog_session_group_idx
  on public.kit_catalog(audit_session_id, kit_group);

alter table public.kit_catalog enable row level security;

drop policy if exists "authenticated read kit catalog" on public.kit_catalog;
drop policy if exists "authenticated import kit catalog" on public.kit_catalog;
drop policy if exists "authenticated update kit catalog" on public.kit_catalog;
drop policy if exists "authenticated delete kit catalog" on public.kit_catalog;

create policy "authenticated read kit catalog"
on public.kit_catalog for select to authenticated using (true);

create policy "authenticated import kit catalog"
on public.kit_catalog for insert to authenticated with check (true);

create policy "authenticated update kit catalog"
on public.kit_catalog for update to authenticated using (true) with check (true);

create policy "authenticated delete kit catalog"
on public.kit_catalog for delete to authenticated using (true);
