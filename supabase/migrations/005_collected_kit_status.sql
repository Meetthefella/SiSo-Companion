-- v0.2.5: keep legitimately collected kits separate from physically reconciled kits.
-- Safe data-preserving migration.

alter table public.kit_checks
  drop constraint if exists kit_checks_comparison_status_check;

alter table public.kit_checks
  add constraint kit_checks_comparison_status_check
  check (comparison_status in ('reconciled','collected','siso_update','missing','second_pass'));

-- Existing rows that were absent and had an active booking were previously
-- stored as reconciled. Reclassify them as collected.
update public.kit_checks
set comparison_status = 'collected',
    updated_at = now()
where physical_state = 'absent'
  and booking_state is not null
  and comparison_status = 'reconciled';
