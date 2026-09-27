export type AccountLinkKind = 'enroll' | 'recover';
export interface AccountLinkRoute {
  kind: AccountLinkKind;
  code: string | null;
  invalid: boolean;
}

// Never accept a secret from a query string, path segment, or an extra fragment field.
export function readAccountLinkRoute(
  pathname: string = window.location.pathname,
  hash: string = window.location.hash,
  search: string = window.location.search,
): AccountLinkRoute | null {
  const kind =
    pathname === '/enroll'
      ? 'enroll'
      : pathname === '/recover'
        ? 'recover'
        : null;
  if (!kind) return null;
  const match = /^#code=([A-Za-z0-9_-]{43})$/.exec(hash);
  return {
    kind,
    code: search === '' ? (match?.[1] ?? null) : null,
    invalid: search !== '' || (hash !== '' && !match),
  };
}

export function clearAccountLinkFragment(): void {
  window.history.replaceState(null, '', window.location.pathname);
}
