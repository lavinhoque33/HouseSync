import { useRef, useState } from 'react';
import type { SafeUser } from './client';
import { AppLink } from '../NavigationMenu';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';

export function ProfileMenu({
  user,
  onLogout,
  disabled,
  loggingOut,
}: {
  user: SafeUser;
  onLogout: () => void;
  disabled: boolean;
  loggingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="profile-menu">
      <button
        ref={trigger}
        type="button"
        className="profile-trigger icon-button"
        aria-label="Open profile menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon name="user" />
      </button>
      <Overlay
        open={open}
        onClose={() => setOpen(false)}
        title="Profile"
        variant="popover"
      >
        <div className="profile-identity">
          <span className="profile-avatar" aria-hidden="true">
            <Icon name="user" />
          </span>
          <div>
            <span className="profile-label">Signed in as</span>
            <p className="profile-email">{user.email}</p>
          </div>
        </div>
        <details className="profile-details">
          <summary>Account information</summary>
          <p>Account ID: {user.id}</p>
        </details>
        <div className="profile-actions">
          <AppLink
            to="/account/security"
            className="profile-settings"
            onNavigate={() => setOpen(false)}
          >
            <Icon name="settings" /> Profile Settings{' '}
            <Icon name="arrow-right" />
          </AppLink>
          <button
            type="button"
            className="profile-signout"
            disabled={disabled}
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <Icon name="logout" /> {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </Overlay>
    </div>
  );
}
