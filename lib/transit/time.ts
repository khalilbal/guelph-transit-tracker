const DEFAULT_TIME_ZONE = 'America/Toronto';

export function getTorontoNow(): Date {
  return new Date();
}

export function formatIso(timestampMs: number | null | undefined): string | null {
  if (!timestampMs && timestampMs !== 0) {
    return null;
  }
  return new Date(timestampMs).toISOString();
}

export function getServiceContext(date: Date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = lookup.year;
  const month = lookup.month;
  const day = lookup.day;
  const hour = Number(lookup.hour ?? '0');
  const minute = Number(lookup.minute ?? '0');
  const second = Number(lookup.second ?? '0');
  const weekdayToken = (lookup.weekday ?? 'Mon').slice(0, 3).toLowerCase();
  const weekdayMap: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };

  return {
    dateKey: `${year}${month}${day}`,
    weekday: weekdayMap[weekdayToken] ?? 1,
    secondsSinceMidnight: hour * 3600 + minute * 60 + second,
    isoDate: `${year}-${month}-${day}`,
  };
}

export function parseGtfsTimeToSeconds(value: string): number {
  const [hh = '0', mm = '0', ss = '0'] = value.split(':');
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}

export function formatSecondsToLocalIso(baseDate: Date, seconds: number): string {
  const start = new Date(baseDate);
  start.setHours(0, 0, 0, 0);
  start.setSeconds(seconds);
  return start.toISOString();
}

export function minutesBetween(nowMs: number, futureIso: string): number {
  return Math.round((new Date(futureIso).getTime() - nowMs) / 60000);
}
