import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// JSDOM has dialog markup but not the native modal methods. Browser acceptance
// verifies top-layer inertness and focus containment; this shim only supplies
// open/close state and restoration for component interaction tests.
if (!HTMLDialogElement.prototype.showModal) {
  const returnFocus = new WeakMap<HTMLDialogElement, HTMLElement>();
  HTMLDialogElement.prototype.showModal = function () {
    if (document.activeElement instanceof HTMLElement) {
      returnFocus.set(this, document.activeElement);
    }
    this.setAttribute('open', '');
    this.querySelector<HTMLElement>('button, a[href], input, select')?.focus();
  };
  HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.removeAttribute('open');
    const target = returnFocus.get(this);
    if (target?.isConnected) target.focus();
    returnFocus.delete(this);
    this.dispatchEvent(new Event('close'));
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
