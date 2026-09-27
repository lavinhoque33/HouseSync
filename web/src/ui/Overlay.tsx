import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

export function Overlay({
  open,
  onClose,
  title,
  variant = 'sheet',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  variant?: 'drawer' | 'sheet' | 'popover';
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeHandler = useRef(onClose);
  useEffect(() => {
    closeHandler.current = onClose;
  }, [onClose]);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    const onNativeClose = () => {
      if (!dialog.open) closeHandler.current();
    };
    dialog.addEventListener('close', onNativeClose);
    return () => {
      dialog.removeEventListener('close', onNativeClose);
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);
  return (
    <dialog
      ref={dialogRef}
      className={`overlay overlay--${variant}`}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (
          event.key !== 'Tab' ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        const dialog = event.currentTarget;
        let first: HTMLElement | null = null;
        let last: HTMLElement | null = null;
        for (const element of dialog.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, summary, [tabindex]',
        )) {
          if (
            element.tabIndex < 0 ||
            element.matches(':disabled') ||
            element.getClientRects().length === 0 ||
            getComputedStyle(element).visibility !== 'visible'
          )
            continue;
          first ??= element;
          last = element;
        }
        if (
          !first ||
          (event.shiftKey
            ? document.activeElement === first ||
              document.activeElement === dialog
            : document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose();
      }}
    >
      <div className="overlay-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="overlay-content">{children}</div>
    </dialog>
  );
}
