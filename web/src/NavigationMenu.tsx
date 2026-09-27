import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  householdPath,
  navigate,
  type AppRoute,
  type HouseholdPage,
} from './navigation';
import { Icon, type IconName } from './ui/Icon';
import { Overlay } from './ui/Overlay';

const groups: ReadonlyArray<{
  label: string;
  icon: IconName;
  pages: ReadonlyArray<[HouseholdPage, string]>;
}> = [
  {
    label: 'Finance',
    icon: 'wallet',
    pages: [
      ['transactions', 'Transactions'],
      ['accounts', 'Accounts'],
      ['insights', 'Insights'],
    ],
  },
  {
    label: 'Banking',
    icon: 'chart',
    pages: [
      ['connections', 'Bank connections'],
      ['bank-activity', 'Bank activity'],
    ],
  },
  {
    label: 'Shared money',
    icon: 'wallet',
    pages: [
      ['balances', 'Balances'],
      ['repayments', 'Repayments'],
      ['contributions', 'Contributions'],
    ],
  },
  {
    label: 'Management',
    icon: 'users',
    pages: [
      ['members', 'Members'],
      ['invitations', 'Invitations'],
      ['reviews', 'Reviews'],
      ['rules', 'Rules'],
    ],
  },
];

export function AppLink({
  to,
  children,
  className,
  current,
  onNavigate,
  'aria-label': ariaLabel,
  title,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  current?: boolean;
  onNavigate?: () => void;
  'aria-label'?: string;
  title?: string;
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
      aria-label={ariaLabel}
      title={title}
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
  const activeGroup =
    route.kind === 'household'
      ? groups.find((group) =>
          group.pages.some(([page]) => route.page === page),
        )?.label
      : undefined;
  const [householdsOpen, setHouseholdsOpen] = useState(
    route.kind === 'household' ||
      route.kind === 'directory' ||
      route.kind === 'household-create',
  );
  const [householdOpen, setHouseholdOpen] = useState(
    route.kind === 'household',
  );
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set(activeGroup ? [activeGroup] : []),
  );
  const routeKey =
    route.kind === 'household'
      ? householdPath(route.householdId, route.page)
      : route.kind;
  const [previousRouteKey, setPreviousRouteKey] = useState(routeKey);
  if (previousRouteKey !== routeKey) {
    setPreviousRouteKey(routeKey);
    setHouseholdsOpen(
      route.kind === 'household' ||
        route.kind === 'directory' ||
        route.kind === 'household-create',
    );
    setHouseholdOpen(route.kind === 'household');
    setExpandedGroups(new Set(activeGroup ? [activeGroup] : []));
  }
  const close = () => setOpen(false);
  return (
    <div className="navigation-disclosure">
      <button
        ref={trigger}
        type="button"
        className="navigation-trigger icon-button"
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls="site-navigation"
        onClick={() => {
          if (
            route.kind === 'household' ||
            route.kind === 'directory' ||
            route.kind === 'household-create'
          )
            setHouseholdsOpen(true);
          if (route.kind === 'household') {
            setHouseholdOpen(true);
            if (activeGroup)
              setExpandedGroups(
                (current) => new Set([...current, activeGroup]),
              );
          }
          setOpen(true);
        }}
      >
        <Icon name="menu" />
      </button>
      <Overlay open={open} onClose={close} variant="drawer" title="Navigation">
        <nav
          id="site-navigation"
          aria-label="Main navigation"
          className="navigation-panel"
        >
          <AppLink
            className="navigation-link"
            to="/"
            current={route.kind === 'home'}
            onNavigate={close}
          >
            <Icon name="home" /> Home
          </AppLink>
          <button
            type="button"
            className="navigation-group"
            aria-expanded={householdsOpen}
            aria-controls="navigation-households"
            data-active={
              route.kind === 'directory' ||
              route.kind === 'household-create' ||
              route.kind === 'household'
                ? 'true'
                : undefined
            }
            onClick={() => setHouseholdsOpen((value) => !value)}
          >
            <Icon name="users" /> Households{' '}
            <Icon name={householdsOpen ? 'chevron-down' : 'chevron-right'} />
          </button>
          {householdsOpen && (
            <div id="navigation-households" className="navigation-children">
              <AppLink
                className="navigation-link"
                to="/households"
                current={route.kind === 'directory'}
                onNavigate={close}
              >
                Directory
              </AppLink>
              <AppLink
                className="navigation-link"
                to="/households/new"
                current={route.kind === 'household-create'}
                onNavigate={close}
              >
                Create household
              </AppLink>
              {route.kind === 'household' && (
                <>
                  <button
                    type="button"
                    className="navigation-group"
                    aria-expanded={householdOpen}
                    aria-controls="navigation-current-household"
                    data-active="true"
                    onClick={() => setHouseholdOpen((value) => !value)}
                  >
                    Current household{' '}
                    <Icon
                      name={householdOpen ? 'chevron-down' : 'chevron-right'}
                    />
                  </button>
                  {householdOpen && (
                    <div
                      id="navigation-current-household"
                      className="navigation-children"
                    >
                      <AppLink
                        className="navigation-link"
                        to={householdPath(route.householdId, 'overview')}
                        current={route.page === 'overview'}
                        onNavigate={close}
                      >
                        Overview
                      </AppLink>
                      {groups.map(({ label, icon, pages }) => (
                        <div key={label}>
                          <button
                            type="button"
                            className="navigation-group"
                            aria-expanded={expandedGroups.has(label)}
                            aria-controls={`navigation-${label.toLowerCase().replace(' ', '-')}`}
                            data-active={
                              activeGroup === label ? 'true' : undefined
                            }
                            onClick={() =>
                              setExpandedGroups((current) => {
                                const next = new Set(current);
                                if (next.has(label)) next.delete(label);
                                else next.add(label);
                                return next;
                              })
                            }
                          >
                            <Icon name={icon} /> {label}{' '}
                            <Icon
                              name={
                                expandedGroups.has(label)
                                  ? 'chevron-down'
                                  : 'chevron-right'
                              }
                            />
                          </button>
                          {expandedGroups.has(label) && (
                            <div
                              id={`navigation-${label.toLowerCase().replace(' ', '-')}`}
                              className="navigation-children"
                            >
                              {pages.map(([page, name]) => (
                                <AppLink
                                  key={page}
                                  className="navigation-link"
                                  to={householdPath(route.householdId, page)}
                                  current={route.page === page}
                                  onNavigate={close}
                                >
                                  {name}
                                </AppLink>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <AppLink
            className="navigation-link"
            to="/account/security"
            current={route.kind === 'security'}
            onNavigate={close}
          >
            <Icon name="settings" /> Profile Settings
          </AppLink>
        </nav>
      </Overlay>
    </div>
  );
}
