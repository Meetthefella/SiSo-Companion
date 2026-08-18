-- Lead-owned, reversible export exclusions for retired Stock families.
alter table public.audit_sessions add column if not exists ignored_groups_revision integer not null default 0;

create table if not exists public.ignored_kit_groups (
  audit_session_id uuid not null references public.audit_sessions(id) on delete cascade,
  kit_group text not null,
  ignored_by text not null,
  ignored_at timestamptz not null default now(),
  primary key (audit_session_id, kit_group)
);

alter table public.ignored_kit_groups enable row level security;
drop policy if exists "read ignored kit groups" on public.ignored_kit_groups;
create policy "read ignored kit groups" on public.ignored_kit_groups for select to authenticated using (true);

create or replace function public.set_kit_group_ignored(p_audit_session_id uuid, p_kit_group text, p_ignored boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if nullif(trim(p_kit_group), '') is null then raise exception 'A kit group is required.'; end if;
  if not exists (select 1 from audit_sessions where id = p_audit_session_id and status = 'open' and lead_user_id = auth.uid()) then raise exception 'Only the reconciliation lead can change ignored groups.'; end if;
  if not exists (select 1 from kit_catalog where audit_session_id = p_audit_session_id and kit_group = trim(p_kit_group)) then raise exception 'That kit group is not part of this reconciliation Stock scope.'; end if;
  if p_ignored then
    insert into ignored_kit_groups (audit_session_id, kit_group, ignored_by)
    values (p_audit_session_id, trim(p_kit_group), auth.uid()::text)
    on conflict (audit_session_id, kit_group) do nothing;
  else
    delete from ignored_kit_groups where audit_session_id = p_audit_session_id and kit_group = trim(p_kit_group);
  end if;
  update audit_sessions set ignored_groups_revision = ignored_groups_revision + 1 where id = p_audit_session_id;
end;
$$;

grant execute on function public.set_kit_group_ignored(uuid, text, boolean) to authenticated;
revoke execute on function public.set_kit_group_ignored(uuid, text, boolean) from public;
