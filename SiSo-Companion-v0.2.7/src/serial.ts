export function normalizeSerial(value: unknown): string {
  return String(value ?? '')
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]/g, '');
}

const substitutions: Record<string, string[]> = {
  O: ['0'], 0: ['O'], I: ['1', 'L'], L: ['1', 'I'], 1: ['I', 'L'],
  S: ['5'], 5: ['S'], B: ['8'], 8: ['B'], Z: ['2'], 2: ['Z'],
};

export function serialVariants(serial: string, maxChanges = 2): string[] {
  const clean = normalizeSerial(serial);
  const found = new Set<string>([clean]);
  let frontier = new Set<string>([clean]);

  for (let depth = 0; depth < maxChanges; depth += 1) {
    const next = new Set<string>();
    for (const value of frontier) {
      [...value].forEach((char, index) => {
        for (const replacement of substitutions[char] ?? []) {
          const candidate = value.slice(0, index) + replacement + value.slice(index + 1);
          if (!found.has(candidate)) {
            found.add(candidate);
            next.add(candidate);
          }
        }
      });
    }
    frontier = next;
  }
  return [...found];
}

export function deriveKitLabel(barcode: string | null): string | null {
  if (!barcode) return null;
  const first = barcode.split(',')[0]?.trim().toUpperCase();
  if (!first) return null;
  const withoutBms = first.replace(/^BMS/, '');
  const match = withoutBms.match(/^([A-Z]+)0*(\d+)$/);
  if (!match) return withoutBms;
  return `${match[1]} ${Number(match[2])}`;
}
