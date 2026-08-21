-- Legacy open clients can still write kit_checks directly. Convert those row
-- mutations into a session revision signal, while retaining one revision for
-- current RPC transactions that suppress the activity touch.
alter table public.audit_sessions
  add column if not exists progress_updated_by uuid references auth.users(id);

create or replace function public.set_reconciliation_progress_actor()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.progress_revision is distinct from old.progress_revision then
    new.progress_updated_by = auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists audit_sessions_progress_actor on public.audit_sessions;
create trigger audit_sessions_progress_actor
before update on public.audit_sessions
for each row execute function public.set_reconciliation_progress_actor();

create or replace function public.touch_legacy_kit_check_progress()
returns trigger language plpgsql security definer set search_path = public as $$
declare session_id uuid;
begin
  -- Current RPCs already make one explicit progress update after their complete
  -- transaction. Older direct writers do not set this flag, so they receive a
  -- compatible revision signal for each direct row change.
  if current_setting('siso.suppress_activity_touch', true) = 'on' then
    return coalesce(new, old);
  end if;
  session_id := coalesce((to_jsonb(new)->>'audit_session_id')::uuid, (to_jsonb(old)->>'audit_session_id')::uuid);
  update audit_sessions set progress_revision = progress_revision + 1 where id = session_id;
  return coalesce(new, old);
end;
$$;

drop trigger if exists touch_legacy_kit_check_progress on public.kit_checks;
create trigger touch_legacy_kit_check_progress
after insert or update or delete on public.kit_checks
for each row execute function public.touch_legacy_kit_check_progress();
