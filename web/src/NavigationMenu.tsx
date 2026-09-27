import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  householdPath,
  navigate,
  type AppRoute,
  type HouseholdPage,
} from './navigation';

const householdPages: ReadonlyArray<[HouseholdPage, string]> = [
  ['overview', 'Overview'],
  ['transactions', 'Transactions'],
  ['accounts', 'Accounts'],
  ['connections', 'Bank connections'],
  ['bank-activity', 'Bank activity'],
  ['members', 'Members'],
  ['invitations', 'Invitations'],
  ['reviews', 'Reviews'],
  ['rules', 'Rules'],
  ['balances', 'Balances'],
  ['repayments', 'Repayments'],
  ['contributions', 'Contributions'],
  ['insights', 'Insights'],
];

export function AppLink({
  to,
  children,
  className,
  current,
  onNavigate,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  current?: boolean;
  onNavigate?: () => void;
}) {
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      event.defaultPrevented
    )
      return;
    event.preventDefault();
    onNavigate?.();
    navigate(to);
  }
  return (
    <a
      href={to}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={follow}
    >
      {children}
    </a>
  );
}

export function NavigationMenu({ route }: { route: AppRoute }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!region.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);
  const id = 'site-navigation';
  return (
    <div
      ref={region}
      className="navigation-disclosure"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="navigation-trigger"
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {open && (
        <nav id={id} aria-label="Main navigation" className="navigation-panel">
          <AppLink
            to="/"
            current={route.kind === 'home'}
            onNavigate={() => setOpen(false)}
          >
            Home
          </AppLink>
          <AppLink
            to="/households"
            current={route.kind === 'directory'}
            onNavigate={() => setOpen(false)}
          >
            Households
          </AppLink>
          <AppLink
            to="/account/security"
            current={route.kind === 'security'}
            onNavigate={() => setOpen(false)}
          >
            Account security
          </AppLink>
          {route.kind === 'household' && (
            <div className="navigation-pages">
              <span className="navigation-label">Household pages</span>
              {householdPages.map(([page, label]) => (
                <AppLink
                  key={page}
                  to={householdPath(route.householdId, page)}
                  current={route.page === page}
                  onNavigate={() => setOpen(false)}
                >
                  {label}
                </AppLink>
              ))}
            </div>
          )}
        </nav>
      )}
    </div>
  );
}
