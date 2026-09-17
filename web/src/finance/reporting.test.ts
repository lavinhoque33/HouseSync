import { describe, expect, it } from 'vitest';
import {
  currentMonthIntervalInZone,
  describeReportingPeriod,
  isFutureDateInZone,
  isRegionShapedZone,
  isSupportedReportBoundaryDate,
  resolveCalculationZone,
  todayInZone,
  validateReportInterval,
  validateReportingZoneInput,
} from './reporting';

describe('reporting zone input', () => {
  it('accepts IANA region names including nested areas', () => {
    expect(validateReportingZoneInput('Etc/UTC')).toEqual({
      ok: true,
      zone: 'Etc/UTC',
    });
    expect(validateReportingZoneInput('America/Sao_Paulo')).toEqual({
      ok: true,
      zone: 'America/Sao_Paulo',
    });
    expect(
      validateReportingZoneInput('America/Argentina/Buenos_Aires'),
    ).toEqual({
      ok: true,
      zone: 'America/Argentina/Buenos_Aires',
    });
  });

  it('rejects surrounding whitespace like the money inputs do', () => {
    expect(validateReportingZoneInput('  Etc/UTC  ')).toEqual({
      ok: false,
      error: 'Remove spaces from the time zone name.',
    });
  });

  it('rejects short aliases, bare offsets, and empty input', () => {
    for (const value of [
      '',
      '   ',
      'EST',
      'CET',
      'UTC',
      '+03:00',
      '-04:00',
      'GMT+3',
      'America/Sao Paulo',
      'America/ Sao_Paulo',
      'Etc /UTC',
    ]) {
      expect(validateReportingZoneInput(value).ok).toBe(false);
    }
  });
});

describe('returned zone shape', () => {
  it('accepts region-shaped zones for strict response parsing', () => {
    expect(isRegionShapedZone('Etc/UTC')).toBe(true);
    expect(isRegionShapedZone('America/Sao_Paulo')).toBe(true);
    expect(isRegionShapedZone('America/Argentina/Buenos_Aires')).toBe(true);
  });

  it('rejects offsets, short aliases, and malformed values', () => {
    for (const value of [
      '',
      'EST',
      'UTC',
      '+03:00',
      'GMT+3',
      'Etc /UTC',
      '/UTC',
      'Etc/',
    ]) {
      expect(isRegionShapedZone(value)).toBe(false);
    }
  });
});

describe('calculation zone resolution', () => {
  it('uses zones the host browser supports without fallback', () => {
    expect(resolveCalculationZone('Etc/UTC')).toEqual({
      zone: 'Etc/UTC',
      fellBack: false,
    });
    expect(resolveCalculationZone('America/Sao_Paulo')).toEqual({
      zone: 'America/Sao_Paulo',
      fellBack: false,
    });
  });

  it('falls back explicitly instead of throwing for unsupported zones', () => {
    // Region-shaped but unknown to the host ICU: render and event code must
    // never see the RangeError.
    expect(resolveCalculationZone('Mars/Olympus')).toEqual({
      zone: 'Etc/UTC',
      fellBack: true,
    });
  });
});

describe('report boundary dates', () => {
  it('supports the full reporting range including the reserved boundary', () => {
    expect(isSupportedReportBoundaryDate('1900-01-01')).toBe(true);
    expect(isSupportedReportBoundaryDate('2026-09-16')).toBe(true);
    expect(isSupportedReportBoundaryDate('9999-12-30')).toBe(true);
    // Report boundaries extend through 9999-12-31 so the final supported
    // transaction date stays queryable in a half-open interval.
    expect(isSupportedReportBoundaryDate('9999-12-31')).toBe(true);
  });

  it('rejects out-of-range, malformed, and impossible dates', () => {
    expect(isSupportedReportBoundaryDate('1899-12-31')).toBe(false);
    expect(isSupportedReportBoundaryDate('2026-9-6')).toBe(false);
    expect(isSupportedReportBoundaryDate('2026/09/16')).toBe(false);
    expect(isSupportedReportBoundaryDate('2026-02-29')).toBe(false);
    expect(isSupportedReportBoundaryDate('2024-02-29')).toBe(true);
    expect(isSupportedReportBoundaryDate('2026-13-01')).toBe(false);
  });

  it('validates explicit intervals with strict ordering', () => {
    expect(validateReportInterval('2026-09-01', '2026-10-01')).toBeUndefined();
    expect(validateReportInterval('2026-10-01', '2026-10-01')).toBe(
      'The start date must be before the end date.',
    );
    expect(validateReportInterval('2026-10-01', '2026-09-01')).toBe(
      'The start date must be before the end date.',
    );
    expect(validateReportInterval('not-a-date', '2026-10-01')).toContain(
      'YYYY-MM-DD',
    );
  });
});

describe('zone-derived defaults', () => {
  it('derives the calendar month containing the zone-local today', () => {
    expect(
      currentMonthIntervalInZone('Etc/UTC', new Date('2026-09-17T12:00:00Z')),
    ).toEqual({ from: '2026-09-01', to: '2026-10-01' });
    expect(todayInZone('Etc/UTC', new Date('2026-09-17T12:00:00Z'))).toBe(
      '2026-09-17',
    );
  });

  it('rolls December into January of the next year', () => {
    expect(
      currentMonthIntervalInZone('Etc/UTC', new Date('2026-12-15T12:00:00Z')),
    ).toEqual({ from: '2026-12-01', to: '2027-01-01' });
  });

  it('is host-zone-independent at a month boundary', () => {
    // 2026-09-30T23:30Z is still September in New York (UTC-4) but already
    // October in Kiritimati (UTC+14). The derived month must follow the
    // requested zone, whatever zone the test host runs in.
    const instant = new Date('2026-09-30T23:30:00Z');
    expect(currentMonthIntervalInZone('America/New_York', instant)).toEqual({
      from: '2026-09-01',
      to: '2026-10-01',
    });
    expect(currentMonthIntervalInZone('Pacific/Kiritimati', instant)).toEqual({
      from: '2026-10-01',
      to: '2026-11-01',
    });
    expect(todayInZone('America/New_York', instant)).toBe('2026-09-30');
    expect(todayInZone('Pacific/Kiritimati', instant)).toBe('2026-10-01');
  });

  it('survives daylight-saving transitions without inventing midnights', () => {
    // US spring forward on 2026-03-08 and fall back on 2026-11-01: the
    // zone-local month is still well-defined on both transition days.
    expect(
      currentMonthIntervalInZone(
        'America/New_York',
        new Date('2026-03-08T07:30:00Z'),
      ),
    ).toEqual({ from: '2026-03-01', to: '2026-04-01' });
    expect(
      currentMonthIntervalInZone(
        'America/New_York',
        new Date('2026-11-01T05:30:00Z'),
      ),
    ).toEqual({ from: '2026-11-01', to: '2026-12-01' });
  });

  it('rejects unknown zones loudly instead of falling back silently', () => {
    expect(() =>
      currentMonthIntervalInZone(
        'Nope/Nowhere',
        new Date('2026-09-17T12:00:00Z'),
      ),
    ).toThrow(RangeError);
  });

  it('compares supported dates against the zone-local today', () => {
    const now = new Date('2026-09-17T12:00:00Z');
    expect(isFutureDateInZone('2026-09-18', 'Etc/UTC', now)).toBe(true);
    expect(isFutureDateInZone('2026-09-17', 'Etc/UTC', now)).toBe(false);
    expect(isFutureDateInZone('2026-09-16', 'Etc/UTC', now)).toBe(false);
    // The same instant can be "tomorrow" in one zone and "today" in another.
    const boundary = new Date('2026-09-30T23:30:00Z');
    expect(isFutureDateInZone('2026-10-01', 'America/New_York', boundary)).toBe(
      true,
    );
    expect(
      isFutureDateInZone('2026-10-01', 'Pacific/Kiritimati', boundary),
    ).toBe(false);
  });

  it('describes the applied period and zone in one line', () => {
    expect(describeReportingPeriod('2026-09-01', '2026-10-01', 'Etc/UTC')).toBe(
      'Showing 2026-09-01 to 2026-10-01 (end date excluded) in Etc/UTC.',
    );
  });
});
