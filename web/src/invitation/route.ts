export interface PendingInvite {
  invitationId: string;
  secret: string;
}

export interface JoinRouteState {
  joinActive: boolean;
  joinInvalid: boolean;
  invite: PendingInvite | null;
}

/**
 * Read the join route from explicit location parts (defaulting to the live
 * window location). Kept here so component files export components only.
 */
export function readJoinRoute(
  pathname: string = window.location.pathname,
  hash: string = window.location.hash,
  search: string = window.location.search,
): JoinRouteState {
  if (!isJoinPath(pathname)) {
    return { joinActive: false, joinInvalid: false, invite: null };
  }
  if (search !== '') {
    // A join link must never carry a query string: the secret is
    // fragment-only, and query-bearing links are not activated.
    return { joinActive: true, joinInvalid: true, invite: null };
  }
  const invite = parseJoinRoute(pathname, hash, search);
  if (invite) {
    return { joinActive: true, joinInvalid: false, invite };
  }
  if (parseJoinPathId(pathname) === null) {
    return { joinActive: true, joinInvalid: true, invite: null };
  }
  // Well-formed path without a usable fragment: the tab lost the secret
  // (reload or fragment-less open). Ask to reopen the original link.
  return { joinActive: true, joinInvalid: false, invite: null };
}

export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const INVITE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const JOIN_PATH_PATTERN = /^\/join\/([^/]+)\/?$/;
const INVITE_FRAGMENT_PATTERN = /^#invite=([A-Za-z0-9_-]{43})$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isInviteSecret(value: string): boolean {
  return INVITE_SECRET_PATTERN.test(value);
}

export function isJoinPath(pathname: string): boolean {
  return JOIN_PATH_PATTERN.test(pathname);
}

/**
 * Strictly extract the invitation UUID from a join path. A well-formed path
 * without a usable fragment (for example after a reload discarded the
 * in-memory secret) is a "reopen the link" state, not an invalid link.
 */
export function parseJoinPathId(pathname: string): string | null {
  const pathMatch = JOIN_PATH_PATTERN.exec(pathname);
  if (!pathMatch) return null;
  const invitationId = pathMatch[1] ?? '';
  return isUuid(invitationId) ? invitationId : null;
}

/**
 * Strictly parse a join route. Only an exact `/join/{uuid}` path plus an
 * exact `#invite={43-char secret}` fragment yields a capability. Any
 * non-empty query string rejects the route outright: secrets are never
 * sourced from the query, and a link carrying query parameters is not
 * activated. Path secrets, padded/alternate encodings, and extra fragment
 * parameters are never accepted either.
 */
export function parseJoinRoute(
  pathname: string,
  hash: string,
  search: string = '',
): PendingInvite | null {
  if (search !== '') return null;
  const pathMatch = JOIN_PATH_PATTERN.exec(pathname);
  if (!pathMatch) return null;
  const invitationId = pathMatch[1] ?? '';
  if (!isUuid(invitationId)) return null;
  const hashMatch = INVITE_FRAGMENT_PATTERN.exec(hash);
  if (!hashMatch) return null;
  const secret = hashMatch[1] ?? '';
  if (!isInviteSecret(secret)) return null;
  return { invitationId, secret };
}

/**
 * Build the shareable capability link on the current origin. The secret
 * travels in the fragment so it never reaches the server on navigation.
 */
export function buildJoinLink(origin: string, invite: PendingInvite): string {
  return `${origin}/join/${invite.invitationId}#invite=${invite.secret}`;
}

/**
 * Immediately remove the fragment from the address bar after extraction so
 * the secret does not linger in the visible URL, history entries, or
 * subsequent same-document navigations.
 */
export function clearJoinFragment(invitationId: string): void {
  window.history.replaceState(null, '', `/join/${invitationId}`);
}
