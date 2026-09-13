const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_CODE_POINTS = 15;
const MAX_PASSWORD_UTF8_BYTES = 72;

export const PASSWORD_HINT =
  'Use at least 15 characters, at most 72 bytes. Spaces are allowed; passwords are not trimmed.';

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(value);
}

export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function validateEmail(raw: string): string | undefined {
  const value = normalizeEmail(raw);
  if (value.length === 0) return 'Enter your email address.';
  if (value.length > MAX_EMAIL_LENGTH) {
    return 'Email must be 254 characters or fewer.';
  }
  if (!isAscii(value)) return 'Email must use ASCII characters only.';
  if (!EMAIL_PATTERN.test(value)) return 'Enter a valid email address.';
  return undefined;
}

export function validateNewPassword(password: string): string | undefined {
  if (password.includes('\0')) return 'Password must not contain NUL.';
  const bytes = utf8ByteLength(password);
  if (bytes > MAX_PASSWORD_UTF8_BYTES) {
    return 'Password must be 72 bytes or fewer.';
  }
  if (countCodePoints(password) < MIN_PASSWORD_CODE_POINTS) {
    return 'Password must be at least 15 characters.';
  }
  return undefined;
}

export function validateLoginPassword(password: string): string | undefined {
  if (password.length === 0) return 'Enter your password.';
  if (password.includes('\0')) return 'Password must not contain NUL.';
  if (utf8ByteLength(password) > MAX_PASSWORD_UTF8_BYTES) {
    return 'Password must be 72 bytes or fewer.';
  }
  return undefined;
}

export function validateConfirm(
  password: string,
  confirm: string,
): string | undefined {
  if (confirm.length === 0) return 'Confirm your password.';
  if (password !== confirm) return 'Passwords do not match.';
  return undefined;
}

const MAX_HOUSEHOLD_NAME_CODE_POINTS = 100;

const HOUSEHOLD_CONTROL_PATTERN: RegExp = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u001F\\u007F-\\u009F]',
);

export function validateHouseholdName(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0) return 'Enter a household name.';
  if (countCodePoints(value) > MAX_HOUSEHOLD_NAME_CODE_POINTS) {
    return 'Household name must be 100 characters or fewer.';
  }
  if (HOUSEHOLD_CONTROL_PATTERN.test(value)) {
    return 'Household name must not contain control characters.';
  }
  return undefined;
}

export { MAX_EMAIL_LENGTH, MAX_HOUSEHOLD_NAME_CODE_POINTS };
