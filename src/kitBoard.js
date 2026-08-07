export function visibleKitsForGroup(kits, group, filter, checks) {
  return kits.filter((kit) => {
    if (kit.group !== group) return false;
    const status = checks.get(kit.barcode)?.comparison_status ?? 'not_checked';
    if (filter === 'all') return true;
    if (filter === 'further_action') return status === 'missing' || status === 'siso_update';
    return status === filter;
  });
}
