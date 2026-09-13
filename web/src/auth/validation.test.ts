import { describe, expect, it } from 'vitest';
import {
  countCodePoints,
  normalizeEmail,
  utf8ByteLength,
  validateConfirm,
  validateEmail,
  validateLoginPassword,
  validateNewPassword,
} from './validation';

describe('identity validation', () => {
  it('normalizes email by trimming and lowercasing', () => {
    expect(normalizeEmail('  Person@Example.TEST  ')).toBe(
      'person@example.test',
    );
  });

  it('rejects overlong, non-ascii, and malformed emails', () => {
    expect(validateEmail('')).toBeDefined();
    expect(validateEmail(`${'a'.repeat(250)}@b.test`)).toBeDefined();
    expect(validateEmail('persön@example.test')).toBeDefined();
    expect(validateEmail('not-an-email')).toBeDefined();
    expect(validateEmail('person@example.test')).toBeUndefined();
  });

  it('enforces new-password code-point minimum and byte maximum', () => {
    expect(validateNewPassword('short-1234567')).toBeDefined();
    expect(validateNewPassword('a'.repeat(14))).toBeDefined();
    expect(
      validateNewPassword('correct horse battery staple extra'),
    ).toBeUndefined();
    // 72-byte boundary: 18 x 4-byte emoji = 72 bytes, 18 code points.
    expect(validateNewPassword('🙂'.repeat(18))).toBeUndefined();
    expect(validateNewPassword('🙂'.repeat(19))).toBeDefined();
    expect(validateNewPassword('valid-password-123\0')).toBeDefined();
  });

  it('does not trim spaces in new passwords', () => {
    // Leading/trailing spaces count toward the minimum.
    expect(validateNewPassword('  padded password 1')).toBeUndefined();
    expect(countCodePoints('  padded password 1')).toBeGreaterThanOrEqual(15);
  });

  it('keeps login passwords permissive except empty and overlong', () => {
    expect(validateLoginPassword('')).toBeDefined();
    expect(validateLoginPassword('short')).toBeUndefined();
    expect(validateLoginPassword('x'.repeat(73))).toBeDefined();
  });

  it('requires confirmation to match', () => {
    expect(
      validateConfirm('correct horse battery staple', 'different'),
    ).toBeDefined();
    expect(validateConfirm('correct horse battery staple', '')).toBeDefined();
    expect(
      validateConfirm(
        'correct horse battery staple',
        'correct horse battery staple',
      ),
    ).toBeUndefined();
  });

  it('measures utf8 bytes independently of code points', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('🙂')).toBe(4);
    expect(countCodePoints('🙂')).toBe(1);
  });
});
