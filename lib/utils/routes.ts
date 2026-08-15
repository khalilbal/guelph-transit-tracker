export function compactRouteLabel(routeShortName: string, headsign?: string | null) {
  const short = routeShortName?.trim() || '';
  const head = (headsign || '').trim();
  const numericMatch = head.match(/\b(\d+[A-Za-z]*)\b/) || short.match(/\b(\d+[A-Za-z]*)\b/);
  const base = numericMatch?.[1] ?? short;

  if (!base) {
    return 'Route';
  }

  const paddedBase = (() => {
    const match = base.match(/^(\d+)([A-Za-z]*)$/);
    if (!match) {
      return base.toUpperCase();
    }
    const [, digits, suffix] = match;
    return `${digits.padStart(3, '0')}${suffix.toUpperCase()}`;
  })();

  const lower = head.toLowerCase();
  if (/northbound|\bnorth\b/.test(lower)) return `${paddedBase}N`;
  if (/southbound|\bsouth\b/.test(lower)) return `${paddedBase}S`;
  if (/eastbound|\beast\b/.test(lower)) return `${paddedBase}E`;
  if (/westbound|\bwest\b/.test(lower)) return `${paddedBase}W`;

  return paddedBase;
}
