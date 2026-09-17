/**
 * Exact string-money rules from the accepted manual-finance contract
 * (docs/architecture/manual-finance-api.md, "Money boundary"), extended with
 * CAD scale 2 by the connected-finance contract
 * (docs/architecture/connected-finance-contract.md, section 2). This module
 * is a leaf: the typed API client imports the currency table from here.
 *
 * - Amounts are decimal strings, never numbers. Signs are encoded by kind
 *   and (for transfers) direction from a positive magnitude input.
 * - Input grammar `-?(0|[1-9][0-9]{0,11})(\.[0-9]+)?` is bounded to 17
 *   characters before parsing; the UI accepts the unsigned magnitude form
 *   and appends the economic sign itself.
 * - Currencies have fixed scales: BRL/USD/EUR/GBP/CAD 2, JPY 0, KWD 3. Fewer
 *   fractional digits are accepted and padded; excess precision, decimal
 *   points on scale-0 currencies, negative zero, and zero values fail.
 * - No number, parseFloat, or binary floating-point arithmetic is used.
 */

export type FinancialAccountCurrency =
  'BRL' | 'USD' | 'EUR' | 'GBP' | 'JPY' | 'KWD' | 'CAD';

export const CURRENCY_SCALES: Record<FinancialAccountCurrency, number> = {
  BRL: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  CAD: 2,
};

export function isFinancialAccountCurrency(
  value: unknown,
): value is FinancialAccountCurrency {
  return (
    value === 'BRL' ||
    value === 'USD' ||
    value === 'EUR' ||
    value === 'GBP' ||
    value === 'JPY' ||
    value === 'KWD' ||
    value === 'CAD'
  );
}

/** Maximum integral digits every supported currency allows. */
const MAX_INTEGRAL_DIGITS = 12;
/** Longest valid amount: sign, 12 integral digits, point, 3 digits. */
const MAX_AMOUNT_LENGTH = 17;

/** Unsigned magnitude grammar before the sign is applied. */
const MAGNITUDE_GRAMMAR = /^(0|[1-9][0-9]{0,11})(\.[0-9]+)?$/;
/** Digits-and-optional-point shape separating size from format errors. */
const DIGIT_SHAPE = /^[0-9]+(\.[0-9]+)?$/;
/** Stored/response amounts: one minus sign, exact currency scale. */
const SIGNED_AMOUNT_GRAMMAR = /^-?(0|[1-9][0-9]{0,11})(\.[0-9]+)?$/;

export type MoneySign = 'positive' | 'negative';

export type MoneyValidationResult =
  | { readonly ok: true; readonly amount: string }
  | { readonly ok: false; readonly error: string };

/**
 * Validate an unsigned magnitude the user typed and encode the exact signed
 * wire string for the currency. Rejection happens before any parsing, so a
 * driver can never round excess precision.
 */
export function encodeMoneyMagnitude(
  raw: string,
  currency: FinancialAccountCurrency,
  sign: MoneySign,
): MoneyValidationResult {
  const scale = CURRENCY_SCALES[currency];
  const value = raw.trim();
  if (/\s/u.test(raw)) {
    return { ok: false, error: 'Remove spaces from the amount.' };
  }
  if (value.length === 0) {
    return { ok: false, error: 'Enter an amount.' };
  }
  if (value.startsWith('-') || value.startsWith('+')) {
    return {
      ok: false,
      error:
        'Enter the size of the amount without a sign; the entry type sets the direction.',
    };
  }
  if (value.length > MAX_AMOUNT_LENGTH) {
    return { ok: false, error: 'The amount is too long.' };
  }
  if (!DIGIT_SHAPE.test(value)) {
    return {
      ok: false,
      error:
        'Enter the amount as plain digits with an optional decimal point, like 12.50. Commas, symbols, and spaces are not accepted.',
    };
  }
  if (integralDigits(value) > MAX_INTEGRAL_DIGITS) {
    return { ok: false, error: 'The amount is too large.' };
  }
  if (!MAGNITUDE_GRAMMAR.test(value)) {
    return {
      ok: false,
      error:
        'Enter the amount as plain digits with an optional decimal point, like 12.50.',
    };
  }
  const [integral, fractional] = splitParts(value);
  if (fractional !== undefined && scale === 0) {
    return {
      ok: false,
      error: `${currency} amounts have no decimal places.`,
    };
  }
  if (fractional !== undefined && fractional.length > scale) {
    return {
      ok: false,
      error: `${currency} accepts at most ${scale} decimal ${scale === 1 ? 'digit' : 'digits'}.`,
    };
  }
  if (isZeroMagnitude(integral, fractional)) {
    return { ok: false, error: 'Enter a nonzero amount.' };
  }
  // Fewer fractional digits are accepted and padded to the currency scale
  // exactly as the contract normalizes them.
  const padded = (fractional ?? '').padEnd(scale, '0');
  const magnitude = scale === 0 ? `${integral}` : `${integral}.${padded}`;
  return {
    ok: true,
    amount: sign === 'negative' ? `-${magnitude}` : magnitude,
  };
}

function splitParts(value: string): [string, string | undefined] {
  const point = value.indexOf('.');
  if (point === -1) return [value, undefined];
  return [value.slice(0, point), value.slice(point + 1)];
}

function integralDigits(value: string): number {
  return splitParts(value)[0]?.length ?? 0;
}

function isZeroMagnitude(
  integral: string,
  fractional: string | undefined,
): boolean {
  const digits =
    fractional === undefined ? integral : `${integral}${fractional}`;
  return /^0+$/.test(digits);
}

/**
 * Validate a stored/response transaction amount string: grammar-valid,
 * exactly the currency scale, and never zero (transactions must be
 * nonzero, including retained voided ones). Excess trailing zeros, leading
 * zeros, signs other than one minus, and exponent notation fail.
 */
export function isSupportedAmountString(
  amount: string,
  currency: FinancialAccountCurrency,
): boolean {
  if (amount.length === 0 || amount.length > MAX_AMOUNT_LENGTH) return false;
  if (!SIGNED_AMOUNT_GRAMMAR.test(amount)) return false;
  // Zero and negative zero are invalid stored amounts.
  const magnitude = amount.startsWith('-') ? amount.slice(1) : amount;
  if (/^0+(\.0+)?$/.test(magnitude)) return false;
  const scale = CURRENCY_SCALES[currency];
  const point = amount.indexOf('.');
  if (point === -1) return scale === 0;
  const fractional = amount.slice(point + 1);
  return scale > 0 && fractional.length === scale;
}

/**
 * Decode a stored amount into its unsigned magnitude parts for editing.
 * Returns null for amounts outside the documented grammar; the UI never
 * re-derives a sign from display text.
 */
export function decodeMoneyAmount(
  amount: string,
  currency: FinancialAccountCurrency,
): { magnitude: string; sign: MoneySign } | null {
  if (
    amount.length === 0 ||
    amount.length > MAX_AMOUNT_LENGTH ||
    !SIGNED_AMOUNT_GRAMMAR.test(amount)
  ) {
    return null;
  }
  const scale = CURRENCY_SCALES[currency];
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [integral, fractional] = splitParts(unsigned);
  if (fractional !== undefined) {
    if (scale === 0 || fractional.length !== scale) return null;
  } else if (scale > 0) {
    // A scale-bearing currency without a point cannot come from the
    // documented response; tolerating it here only seeds the edit form.
    return {
      magnitude: `${integral}.${'0'.repeat(scale)}`,
      sign: negative ? 'negative' : 'positive',
    };
  }
  return { magnitude: unsigned, sign: negative ? 'negative' : 'positive' };
}

/**
 * Exact minor-unit integer for a magnitude string already validated at the
 * currency scale (documented grammar, no sign). All arithmetic is `bigint`,
 * so no float or Number rounding can touch financial values.
 */
export function minorUnitsOfMagnitude(
  magnitude: string,
  currency: FinancialAccountCurrency,
): bigint {
  const scale = CURRENCY_SCALES[currency];
  const [integral, fractional] = splitParts(magnitude);
  return BigInt(`${integral}${(fractional ?? '').padEnd(scale, '0')}`);
}

/**
 * Inverse of `minorUnitsOfMagnitude`: the exact scale-correct magnitude
 * string for non-negative checked minor units, rebuilt from decimal digits
 * only. Precondition: `units` is a non-negative integer.
 */
export function magnitudeOfMinorUnits(
  units: bigint,
  currency: FinancialAccountCurrency,
): string {
  const scale = CURRENCY_SCALES[currency];
  if (scale === 0) return units.toString();
  const base = 10n ** BigInt(scale);
  return `${units / base}.${(units % base).toString().padStart(scale, '0')}`;
}

/**
 * Aggregate/response amount strings (allocation shares, member balances)
 * keep the currency scale but may exceed the per-record 12 integral-digit
 * input bound, so they get a dedicated bounded grammar: optional single
 * minus, no leading zeros, no exponent, exactly the currency's scale, zero
 * allowed. Negative zero (`-0`, `-0.00`, …) is a signed artifact, never a
 * distinct balance, and is rejected. Length stays bounded before any
 * parsing.
 */
const AGGREGATE_AMOUNT_GRAMMAR = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const AGGREGATE_NEGATIVE_ZERO = /^-0+(\.0+)?$/;
const MAX_AGGREGATE_AMOUNT_LENGTH = 64;

export function isAggregateAmountString(
  amount: string,
  currency: FinancialAccountCurrency,
): boolean {
  if (amount.length === 0 || amount.length > MAX_AGGREGATE_AMOUNT_LENGTH) {
    return false;
  }
  if (!AGGREGATE_AMOUNT_GRAMMAR.test(amount)) return false;
  if (AGGREGATE_NEGATIVE_ZERO.test(amount)) return false;
  const scale = CURRENCY_SCALES[currency];
  const point = amount.indexOf('.');
  if (point === -1) return scale === 0;
  return scale > 0 && amount.length - point - 1 === scale;
}

/** Display string preserving every stored digit with the currency code. */
export function formatMoney(amount: string, currency: string): string {
  return `${amount} ${currency}`;
}

const TRANSACTION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Documented transaction-date support: ISO calendar dates from
 * `1900-01-01` through `9999-12-30`; the final reporting boundary
 * `9999-12-31` stays reserved and is not a valid transaction date.
 */
export function isSupportedTransactionDate(value: string): boolean {
  if (!TRANSACTION_DATE_PATTERN.test(value)) return false;
  if (value < '1900-01-01' || value > '9999-12-30') return false;
  // Calendar validity: a UTC round-trip must reproduce the same date,
  // which rejects impossible dates such as leap-day misuse.
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
 * Today's date in the household reporting zone. Without a stored
 * zone, the documented initial zone is `Etc/UTC`,
 * so the UTC clock date is the default manual date and warning basis.
 */
export function householdZoneToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** True when a supported date lies after the household-zone today. */
export function isFutureDate(value: string): boolean {
  return isSupportedTransactionDate(value) && value > householdZoneToday();
}
