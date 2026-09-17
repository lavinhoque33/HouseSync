import { describe, expect, it } from 'vitest';
import type { FinancialAccountCurrency } from './money';
import {
  CURRENCY_SCALES,
  decodeMoneyAmount,
  encodeMoneyMagnitude,
  formatMoney,
  isAggregateAmountString,
  magnitudeOfMinorUnits,
  minorUnitsOfMagnitude,
} from './money';

const ok = (
  raw: string,
  currency: FinancialAccountCurrency,
  sign: 'positive' | 'negative' = 'positive',
) => encodeMoneyMagnitude(raw, currency, sign);

describe('currency scales', () => {
  it('declares the accepted scale table exactly', () => {
    expect(CURRENCY_SCALES).toEqual({
      BRL: 2,
      USD: 2,
      EUR: 2,
      GBP: 2,
      JPY: 0,
      KWD: 3,
      CAD: 2,
    });
  });

  it('encodes Canadian dollars at strict scale 2', () => {
    expect(ok('10', 'CAD')).toEqual({ ok: true, amount: '10.00' });
    expect(ok('10.5', 'CAD')).toEqual({ ok: true, amount: '10.50' });
    expect(ok('10.00', 'CAD')).toEqual({ ok: true, amount: '10.00' });
    expect(ok('10.001', 'CAD')).toMatchObject({ ok: false });
    expect(ok('10.00', 'CAD', 'negative')).toEqual({
      ok: true,
      amount: '-10.00',
    });
    expect(ok('0.00', 'CAD')).toEqual({
      ok: false,
      error: 'Enter a nonzero amount.',
    });
  });
});

describe('magnitude grammar', () => {
  it('accepts documented forms and pads to the currency scale', () => {
    expect(ok('12.34', 'BRL')).toEqual({ ok: true, amount: '12.34' });
    expect(ok('12.3', 'BRL')).toEqual({ ok: true, amount: '12.30' });
    expect(ok('1', 'BRL')).toEqual({ ok: true, amount: '1.00' });
    expect(ok('1', 'KWD')).toEqual({ ok: true, amount: '1.000' });
    expect(ok('1.23', 'KWD')).toEqual({ ok: true, amount: '1.230' });
    expect(ok('0.01', 'USD')).toEqual({ ok: true, amount: '0.01' });
    expect(ok('999999999999.99', 'BRL')).toEqual({
      ok: true,
      amount: '999999999999.99',
    });
    expect(ok('999999999999', 'JPY')).toEqual({
      ok: true,
      amount: '999999999999',
    });
    expect(ok('999999999999.999', 'KWD')).toEqual({
      ok: true,
      amount: '999999999999.999',
    });
    expect(ok('1000000000000', 'JPY', 'negative')).toEqual({
      ok: false,
      error: 'The amount is too large.',
    });
  });

  it('rejects whitespace, signs, symbols, commas, and exponent notation', () => {
    for (const bad of [
      ' 12.50',
      '12.50 ',
      '1 2.50',
      '12,50',
      'R$12.50',
      '$12.50',
      '+12.50',
      '-12.50',
      '1e5',
      '1E5',
      '.50',
      '12.',
      '١٢',
    ]) {
      const result = ok(bad, 'BRL');
      expect(result.ok, bad).toBe(false);
    }
  });

  it('bounds the raw length before any parsing', () => {
    expect(ok('9'.repeat(18), 'BRL').ok).toBe(false);
    expect(ok('9'.repeat(17), 'KWD')).toEqual({
      ok: false,
      error: 'The amount is too large.',
    });
  });

  it('rejects leading zeros as a format problem', () => {
    expect(ok('01.50', 'BRL')).toMatchObject({ ok: false });
    expect(ok('00', 'BRL')).toMatchObject({ ok: false });
  });

  it('rejects excess precision even when trimming would keep the value', () => {
    expect(ok('1.230', 'BRL')).toMatchObject({ ok: false });
    expect(ok('1.0', 'JPY')).toMatchObject({ ok: false });
    expect(ok('1.2340', 'KWD')).toMatchObject({ ok: false });
  });

  it('rejects zero magnitudes', () => {
    expect(ok('0', 'BRL')).toEqual({
      ok: false,
      error: 'Enter a nonzero amount.',
    });
    expect(ok('0.00', 'BRL')).toEqual({
      ok: false,
      error: 'Enter a nonzero amount.',
    });
    expect(ok('0.000', 'KWD')).toEqual({
      ok: false,
      error: 'Enter a nonzero amount.',
    });
  });

  it('requires an amount without a leading sign', () => {
    expect(ok('', 'BRL')).toEqual({ ok: false, error: 'Enter an amount.' });
    expect(ok('   ', 'BRL')).toEqual({
      ok: false,
      error: 'Remove spaces from the amount.',
    });
    expect(ok('-12.50', 'BRL')).toMatchObject({ ok: false });
    expect(ok('+12.50', 'BRL')).toMatchObject({ ok: false });
  });
});

describe('sign encoding', () => {
  it('encodes the economic sign from the positive magnitude', () => {
    expect(ok('12.34', 'BRL', 'negative')).toEqual({
      ok: true,
      amount: '-12.34',
    });
    expect(ok('12.3', 'BRL', 'negative')).toEqual({
      ok: true,
      amount: '-12.30',
    });
    expect(ok('20', 'JPY', 'positive')).toEqual({ ok: true, amount: '20' });
  });
});

describe('decode for editing', () => {
  it('returns magnitude and sign without recomputing numbers', () => {
    expect(decodeMoneyAmount('-12.34', 'BRL')).toEqual({
      magnitude: '12.34',
      sign: 'negative',
    });
    expect(decodeMoneyAmount('20', 'JPY')).toEqual({
      magnitude: '20',
      sign: 'positive',
    });
    expect(decodeMoneyAmount('12.30', 'BRL')).toEqual({
      magnitude: '12.30',
      sign: 'positive',
    });
  });

  it('rejects shapes outside the documented grammar', () => {
    expect(decodeMoneyAmount('', 'BRL')).toBeNull();
    expect(decodeMoneyAmount('12.3', 'BRL')).toBeNull();
    expect(decodeMoneyAmount('12.34', 'KWD')).toBeNull();
    expect(decodeMoneyAmount('12.0', 'JPY')).toBeNull();
    expect(decodeMoneyAmount('1e5', 'BRL')).toBeNull();
    expect(decodeMoneyAmount('01.00', 'BRL')).toBeNull();
    expect(decodeMoneyAmount('a'.repeat(18), 'BRL')).toBeNull();
  });
});

describe('display formatting', () => {
  it('shows the exact stored string with the currency code', () => {
    expect(formatMoney('-12.34', 'BRL')).toBe('-12.34 BRL');
    expect(formatMoney('20', 'JPY')).toBe('20 JPY');
    expect(formatMoney('1.000', 'KWD')).toBe('1.000 KWD');
  });
});

describe('aggregate amounts (shares and balances)', () => {
  it('accepts documented aggregate forms at the exact currency scale', () => {
    expect(isAggregateAmountString('0', 'JPY')).toBe(true);
    expect(isAggregateAmountString('1000', 'JPY')).toBe(true);
    expect(isAggregateAmountString('0.00', 'USD')).toBe(true);
    expect(isAggregateAmountString('6.66', 'USD')).toBe(true);
    expect(isAggregateAmountString('-3.33', 'USD')).toBe(true);
    expect(isAggregateAmountString('0.000', 'KWD')).toBe(true);
    expect(isAggregateAmountString('-0.001', 'KWD')).toBe(true);
  });

  it('accepts aggregates beyond the per-record bound inside the length bound', () => {
    expect(isAggregateAmountString('10000000000000.00', 'USD')).toBe(true);
    expect(isAggregateAmountString('9'.repeat(64), 'JPY')).toBe(true);
    expect(isAggregateAmountString('-' + '9'.repeat(63), 'JPY')).toBe(true);
  });

  it('bounds the aggregate length before any parsing', () => {
    expect(isAggregateAmountString('9'.repeat(65), 'JPY')).toBe(false);
    expect(isAggregateAmountString('-' + '9'.repeat(64), 'JPY')).toBe(false);
    expect(isAggregateAmountString('9'.repeat(62) + '.99', 'USD')).toBe(false);
    expect(isAggregateAmountString('', 'USD')).toBe(false);
  });

  it('rejects negative zero in every currency scale', () => {
    expect(isAggregateAmountString('-0', 'JPY')).toBe(false);
    expect(isAggregateAmountString('-0.00', 'USD')).toBe(false);
    expect(isAggregateAmountString('-0.000', 'KWD')).toBe(false);
  });

  it('rejects malformed syntax and scale mismatches', () => {
    for (const bad of ['01.00', '+1.00', '1e5', '1E5', '.50', '1.', '12,50']) {
      expect(isAggregateAmountString(bad, 'USD'), bad).toBe(false);
    }
    expect(isAggregateAmountString('01', 'JPY')).toBe(false);
    // Scale mismatches: wrong digit count or a point on a scale-0 currency.
    expect(isAggregateAmountString('6.6', 'USD')).toBe(false);
    expect(isAggregateAmountString('6.666', 'USD')).toBe(false);
    expect(isAggregateAmountString('6.66', 'JPY')).toBe(false);
    expect(isAggregateAmountString('1.00', 'KWD')).toBe(false);
  });
});

describe('minor-unit conversion', () => {
  it('converts scale-valid magnitudes to exact minor units', () => {
    expect(minorUnitsOfMagnitude('12.34', 'BRL')).toBe(1234n);
    expect(minorUnitsOfMagnitude('0.05', 'BRL')).toBe(5n);
    expect(minorUnitsOfMagnitude('5.00', 'BRL')).toBe(500n);
    expect(minorUnitsOfMagnitude('20', 'JPY')).toBe(20n);
    expect(minorUnitsOfMagnitude('0', 'JPY')).toBe(0n);
    expect(minorUnitsOfMagnitude('1.230', 'KWD')).toBe(1230n);
    expect(minorUnitsOfMagnitude('0.001', 'KWD')).toBe(1n);
    expect(minorUnitsOfMagnitude('999999999999.99', 'BRL')).toBe(
      99999999999999n,
    );
    expect(minorUnitsOfMagnitude('999999999999.999', 'KWD')).toBe(
      999999999999999n,
    );
  });

  it('rebuilds the exact magnitude string from checked minor units', () => {
    expect(magnitudeOfMinorUnits(1234n, 'BRL')).toBe('12.34');
    expect(magnitudeOfMinorUnits(5n, 'BRL')).toBe('0.05');
    expect(magnitudeOfMinorUnits(500n, 'BRL')).toBe('5.00');
    expect(magnitudeOfMinorUnits(20n, 'JPY')).toBe('20');
    expect(magnitudeOfMinorUnits(1230n, 'KWD')).toBe('1.230');
    expect(magnitudeOfMinorUnits(999999999999999n, 'KWD')).toBe(
      '999999999999.999',
    );
  });

  it('round-trips through bigint without any floating point', () => {
    const cases = [
      ['0.05', 'BRL'],
      ['12.34', 'BRL'],
      ['999999999999.99', 'BRL'],
      ['7', 'JPY'],
      ['999999999999', 'JPY'],
      ['0.001', 'KWD'],
      ['12.345', 'KWD'],
    ] as const;
    for (const [magnitude, currency] of cases) {
      expect(
        magnitudeOfMinorUnits(
          minorUnitsOfMagnitude(magnitude, currency),
          currency,
        ),
      ).toBe(magnitude);
    }
  });
});
