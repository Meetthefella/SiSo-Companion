export interface BoardKit {
  barcode: string;
  group: string;
}

export interface BoardCheck {
  comparison_status: string;
}

export function visibleKitsForGroup<T extends BoardKit>(
  kits: T[],
  group: string,
  filter: string,
  checks: Map<string, BoardCheck | undefined>,
): T[];
