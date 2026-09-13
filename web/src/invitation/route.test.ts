import { describe, expect, it } from 'vitest';
import {
  buildJoinLink,
  clearJoinFragment,
  isInviteSecret,
  isJoinPath,
  isUuid,
  parseJoinPathId,
  parseJoinRoute,
} from './route';

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECRET = 'hGgem9rtrw2Z_PHXg76mXTNiof78wQArhcJVnsxQK6A';
const OTHER_SECRET = '0123456789_-abcdefghijklmnopqrstuvwxyz01234';

describe('strict capability parsing', () => {
  it('accepts an exact join path plus an exact invite fragment', () => {
    expect(parseJoinRoute(`/join/${UUID}`, `#invite=${SECRET}`)).toEqual({
      invitationId: UUID,
      secret: SECRET,
    });
  });

  it('accepts a trailing slash on the path', () => {
    expect(parseJoinRoute(`/join/${UUID}/`, `#invite=${SECRET}`)).toEqual({
      invitationId: UUID,
      secret: SECRET,
    });
  });

  it('rejects non-join paths', () => {
    expect(parseJoinRoute('/', `#invite=${SECRET}`)).toBeNull();
    expect(
      parseJoinRoute(`/households/${UUID}`, `#invite=${SECRET}`),
    ).toBeNull();
    expect(
      parseJoinRoute(`/join/${UUID}/extra`, `#invite=${SECRET}`),
    ).toBeNull();
  });

  it('rejects malformed invitation ids', () => {
    expect(parseJoinRoute('/join/not-a-uuid', `#invite=${SECRET}`)).toBeNull();
    expect(parseJoinRoute('/join/', `#invite=${SECRET}`)).toBeNull();
    expect(parseJoinRoute('/join/%2e%2e', `#invite=${SECRET}`)).toBeNull();
  });

  it('rejects missing, renamed, or extended fragments', () => {
    expect(parseJoinRoute(`/join/${UUID}`, '')).toBeNull();
    expect(parseJoinRoute(`/join/${UUID}`, '#')).toBeNull();
    expect(parseJoinRoute(`/join/${UUID}`, `#secret=${SECRET}`)).toBeNull();
    expect(
      parseJoinRoute(`/join/${UUID}`, `#invite=${SECRET}&next=1`),
    ).toBeNull();
    expect(
      parseJoinRoute(`/join/${UUID}`, `#invite=${SECRET}#frag`),
    ).toBeNull();
  });

  it('rejects padded, short, long, or foreign secrets', () => {
    expect(parseJoinRoute(`/join/${UUID}`, '#invite=abc')).toBeNull();
    expect(parseJoinRoute(`/join/${UUID}`, `#invite=${SECRET}=`)).toBeNull();
    expect(
      parseJoinRoute(`/join/${UUID}`, `#invite=${SECRET.slice(0, 42)}`),
    ).toBeNull();
    expect(parseJoinRoute(`/join/${UUID}`, `#invite=${SECRET}X`)).toBeNull();
    expect(
      parseJoinRoute(`/join/${UUID}`, `#invite=${'ü'.repeat(43)}`),
    ).toBeNull();
  });

  it('never takes the secret from the query string', () => {
    expect(parseJoinRoute(`/join/${UUID}?invite=${SECRET}`, '')).toBeNull();
  });

  it('rejects any non-empty query string without activating', () => {
    expect(
      parseJoinRoute(`/join/${UUID}`, `#invite=${SECRET}`, '?x=1'),
    ).toBeNull();
    expect(
      parseJoinRoute(`/join/${UUID}`, `#invite=${SECRET}`, '?invite=x'),
    ).toBeNull();
    expect(parseJoinRoute(`/join/${UUID}`, '', `?invite=${SECRET}`)).toBeNull();
    expect(parseJoinRoute(`/join/${UUID}`, `#invite=${SECRET}`, '')).toEqual({
      invitationId: UUID,
      secret: SECRET,
    });
  });
});

describe('path helpers', () => {
  it('matches join path shapes and validates uuids and secrets', () => {
    expect(isJoinPath(`/join/${UUID}`)).toBe(true);
    expect(isJoinPath('/households')).toBe(false);
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isInviteSecret(SECRET)).toBe(true);
    expect(isInviteSecret('short')).toBe(false);
  });

  it('extracts a well-formed path id without needing the fragment', () => {
    expect(parseJoinPathId(`/join/${UUID}`)).toBe(UUID);
    expect(parseJoinPathId('/join/bad-id')).toBeNull();
    expect(parseJoinPathId('/')).toBeNull();
  });
});

describe('link building and fragment cleanup', () => {
  it('builds the link on the current origin with the secret in the fragment', () => {
    const link = buildJoinLink('https://app.example.test', {
      invitationId: UUID,
      secret: OTHER_SECRET,
    });
    expect(link).toBe(
      `https://app.example.test/join/${UUID}#invite=${OTHER_SECRET}`,
    );
    const [beforeFragment] = link.split('#');
    expect(beforeFragment).not.toContain(OTHER_SECRET);
  });

  it('removes the fragment while keeping the join path', () => {
    window.history.pushState(null, '', `/join/${UUID}#invite=${SECRET}`);
    expect(window.location.hash).toBe(`#invite=${SECRET}`);
    clearJoinFragment(UUID);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe(`/join/${UUID}`);
    window.history.pushState(null, '', '/');
  });
});
