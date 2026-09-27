import { describe, expect, it } from 'vitest';
import { readAccountLinkRoute } from './route';

const code = 'a'.repeat(43);
describe('operator link routes', () => {
  it('accepts only an exact fragment on the designated path', () => {
    expect(readAccountLinkRoute('/enroll', `#code=${code}`)).toEqual({
      kind: 'enroll',
      code,
      invalid: false,
    });
    expect(readAccountLinkRoute('/recover', `#code=${code}`)).toEqual({
      kind: 'recover',
      code,
      invalid: false,
    });
    expect(
      readAccountLinkRoute(
        '/recover',
        `#code=${code}`,
        '?email=person@example.test',
      ),
    ).toMatchObject({ code: null, invalid: true });
    expect(
      readAccountLinkRoute('/enroll', `#code=${code}&other=x`),
    ).toMatchObject({ code: null, invalid: true });
    expect(readAccountLinkRoute('/enroll', '')).toMatchObject({
      code: null,
      invalid: false,
    });
    expect(readAccountLinkRoute('/join/123', `#code=${code}`)).toBeNull();
  });
});
