import { describe, expect, it } from 'vitest';
import type { FinancialAccountCurrency } from './money';
import {
  CURRENCY_SCALES,
  decodeMoneyAmount,
  encodeMoneyMagnitude,
  formatMoney,
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
