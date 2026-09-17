/**
 * Reporting helpers: the household zone owns "today" and the default
 * dashboard month. Every date derivation here takes an explicit IANA zone and
 * an injected clock, and formats through `Intl` with that zone — never the
 * browser or server default zone — so defaults and warnings stay
 * host-zone-independent and testable at zone boundaries.
 */

export const REPORTING_ZONE_FALLBACK = 'Etc/UTC';

/** Longest zone name the editor accepts; IANA region names are far shorter. */
const MAX_ZONE_LENGTH = 64;

/**
 * IANA region shape (`Area/Name`, allowing nested areas such as
 * `America/Argentina/Buenos_Aires`): letters with digits, underscores,
 * hyphens, plus signs, and slashes. Bare offsets (`+03:00`, `GMT+3`) and
 * short aliases (`EST`, `CET`, `UTC`) carry no slash and are rejected, as is
 * anything with whitespace.
 *
 * This shape is the host-independent part of the contract's zone rule. It is
 * shared by draft validation and by strict parsing of server-returned zones:
 * a stored value outside this shape is contract drift no matter which host
 * renders it.
 */
export const REPORTING_ZONE_REGION_PATTERN =
  /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/;

/** True for region-shaped zone names; the server allowlist stays authoritative. */
export function isRegionShapedZone(zone: string): boolean {
  return REPORTING_ZONE_REGION_PATTERN.test(zone);
}

/**
 * Resolve the zone used for local date calculations. Region-shaped zones
 * the browser's `Intl` cannot support (a contract-valid JVM zone the host
 * ICU lacks) fall back explicitly to the documented initial zone instead of
 * throwing a `RangeError` into render or event handlers. Callers display the
 * server-returned zone as authoritative and surface `fellBack` as an
 * explicit, recoverable warning.
 */
export function resolveCalculationZone(zone: string): {
  readonly zone: string;
  readonly fellBack: boolean;
} {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return { zone, fellBack: false };
  } catch {
    return { zone: REPORTING_ZONE_FALLBACK, fellBack: true };
  }
}

/**
 * Validate a reporting-zone draft before it is sent. The server allowlist
 * (the JVM zone-ID set) stays authoritative; this rejects only values the
 * contract already rules out, with a calm message naming the expected shape.
 */
export function validateReportingZoneInput(
  value: string,
):
  | { readonly ok: true; readonly zone: string }
  | { readonly ok: false; readonly error: string } {
  const zone = value.trim();
  if (zone.length === 0) {
    return { ok: false, error: 'Enter a reporting time zone.' };
  }
  if (zone.length > MAX_ZONE_LENGTH) {
    return { ok: false, error: 'That time zone name is too long.' };
  }
  if (/\s/u.test(value)) {
    return { ok: false, error: 'Remove spaces from the time zone name.' };
  }
  if (!isRegionShapedZone(zone)) {
    return {
      ok: false,
      error:
        'Enter an IANA region time zone such as Etc/UTC or America/Sao_Paulo. Short names like EST and offsets like +03:00 are not accepted.',
    };
  }
  return { ok: true, zone };
}

const BOUNDARY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Report/filter boundary dates: ISO calendar dates from `1900-01-01` through
 * `9999-12-31`, so the final supported transaction date (`9999-12-30`)
 * stays queryable in a half-open interval.
 */
export function isSupportedReportBoundaryDate(value: string): boolean {
  if (!BOUNDARY_DATE_PATTERN.test(value)) return false;
  if (value < '1900-01-01' || value > '9999-12-31') return false;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/**
 * Validate an explicit dashboard interval: both bounds present, supported,
 * and strictly ordered (`from < to` compares lexicographically because the
 * shape is fixed-width ISO).
 */
export function validateReportInterval(
  from: string,
  to: string,
): string | undefined {
  if (
    !isSupportedReportBoundaryDate(from) ||
    !isSupportedReportBoundaryDate(to)
  ) {
    return 'Enter both dates as YYYY-MM-DD between 1900-01-01 and 9999-12-31.';
  }
  if (!(from < to)) {
    return 'The start date must be before the end date.';
  }
  return undefined;
}

function zoneLocalYearMonthDay(
  zone: string,
  now: Date,
): {
  year: number;
  month: number;
  day: number;
} {
  // `en-CA` yields ISO-like numeric parts; every part is read back as a
  // number in the requested zone, so the host default zone never leaks in.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const find = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    const parsed = part === undefined ? Number.NaN : Number(part.value);
    if (!Number.isInteger(parsed)) {
      throw new RangeError(`The time zone “${zone}” gave no usable date.`);
    }
    return parsed;
  };
  return { year: find('year'), month: find('month'), day: find('day') };
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Today's calendar date in the household reporting zone for an injected
 * clock. Throws a `RangeError` for an unknown zone, which callers surface as
 * a recoverable notice rather than a silent fallback to another zone.
 */
export function todayInZone(zone: string, now: Date = new Date()): string {
  const { year, month, day } = zoneLocalYearMonthDay(zone, now);
  return `${year}-${padTwo(month)}-${padTwo(day)}`;
}

/**
 * The default dashboard interval: the whole calendar month containing the
 * household zone's today, as a half-open `[from, to)` pair. December rolls
 * into January of the next year.
 */
export function currentMonthIntervalInZone(
  zone: string,
  now: Date = new Date(),
): { readonly from: string; readonly to: string } {
  const { year, month } = zoneLocalYearMonthDay(zone, now);
  const from = `${year}-${padTwo(month)}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return { from, to: `${nextYear}-${padTwo(nextMonth)}-01` };
}

/** True when a supported boundary date lies after the zone's today. */
export function isFutureDateInZone(
  value: string,
  zone: string,
  now: Date = new Date(),
): boolean {
  return isSupportedReportBoundaryDate(value) && value > todayInZone(zone, now);
}

/**
 * The actual period and zone line the dashboard always shows, built from the
 * server-echoed interval rather than the request, so what the user reads is
 * what the server applied.
 */
export function describeReportingPeriod(
  from: string,
  to: string,
  reportingTimeZone: string,
): string {
  return `Showing ${from} to ${to} (end date excluded) in ${reportingTimeZone}.`;
}
