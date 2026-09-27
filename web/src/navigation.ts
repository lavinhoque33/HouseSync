import { isUuid } from './invitation/route';

export type HouseholdPage =
  | 'overview'
  | 'transactions'
  | 'accounts'
  | 'connections'
  | 'bank-activity'
  | 'members'
  | 'invitations'
  | 'reviews'
  | 'rules'
  | 'balances'
  | 'repayments'
  | 'contributions'
  | 'insights';

export type AppRoute =
  | { kind: 'home' }
  | { kind: 'security' }
  | { kind: 'directory' }
  | { kind: 'household-create' }
  | { kind: 'household'; householdId: string; page: HouseholdPage }
  | { kind: 'link' }
  | { kind: 'not-found' };

const pages: readonly HouseholdPage[] = [
  'overview',
  'transactions',
  'accounts',
  'connections',
  'bank-activity',
  'members',
  'invitations',
  'reviews',
  'rules',
  'balances',
  'repayments',
  'contributions',
  'insights',
];

export function readAppRoute(
  pathname: string = window.location.pathname,
): AppRoute {
  if (pathname === '/') return { kind: 'home' };
  if (pathname === '/account/security') return { kind: 'security' };
  if (pathname === '/households') return { kind: 'directory' };
  if (pathname === '/households/new') return { kind: 'household-create' };
  if (
    pathname === '/enroll' ||
    pathname === '/recover' ||
    /^\/join\/[^/]+\/?$/.test(pathname)
  ) {
    return { kind: 'link' };
  }
  const match = /^\/households\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (
    match &&
    isUuid(match[1] ?? '') &&
    pages.includes(match[2] as HouseholdPage)
  ) {
    return {
      kind: 'household',
      householdId: match[1]!.toLowerCase(),
      page: match[2] as HouseholdPage,
    };
  }
  return { kind: 'not-found' };
}

export function householdPath(id: string, page: HouseholdPage): string {
  return `/households/${id}/${page}`;
}

export const NAVIGATION_EVENT = 'housesync:navigate';

export function navigate(path: string): void {
  if (
    path !==
    window.location.pathname + window.location.search + window.location.hash
  ) {
    window.history.pushState(null, '', path);
  }
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}
