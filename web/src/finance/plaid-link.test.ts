import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadPlaidLinkScript,
  PLAID_LINK_SCRIPT_ID,
  PLAID_LINK_SCRIPT_URL,
  resetPlaidLoaderForTests,
} from './plaid-link';

function fakePlaid() {
  return {
    create: vi.fn(() => ({
      open: vi.fn(),
      destroy: vi.fn(),
    })),
  };
}

afterEach(() => {
  resetPlaidLoaderForTests();
  window.Plaid = undefined;
  vi.unstubAllGlobals();
});

describe('plaid link loader', () => {
  it('creates no script element before the first explicit call', () => {
    expect(document.getElementById(PLAID_LINK_SCRIPT_ID)).toBeNull();
    expect(window.Plaid).toBeUndefined();
  });

  it('injects the exact provider script once and resolves the namespace', async () => {
    const plaid = fakePlaid();
    const first = loadPlaidLinkScript();
    const second = loadPlaidLinkScript();
    const scripts = document.querySelectorAll(`#${PLAID_LINK_SCRIPT_ID}`);
    expect(scripts).toHaveLength(1);
    const script = scripts[0] as HTMLScriptElement;
    expect(script.getAttribute('src')).toBe(PLAID_LINK_SCRIPT_URL);
    expect(script.getAttribute('crossorigin')).toBeNull();
    expect(script.referrerPolicy).toBe('no-referrer');

    window.Plaid = plaid;
    scripts[0]?.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBe(plaid);
    await expect(second).resolves.toBe(plaid);
  });

  it('resolves immediately when the namespace already exists', async () => {
    const plaid = fakePlaid();
    window.Plaid = plaid;
    await expect(loadPlaidLinkScript()).resolves.toBe(plaid);
    expect(document.getElementById(PLAID_LINK_SCRIPT_ID)).toBeNull();
  });

  it('rejects on script error, removes the element, and retries cleanly', async () => {
    const first = loadPlaidLinkScript();
    const script = document.getElementById(PLAID_LINK_SCRIPT_ID);
    expect(script).not.toBeNull();
    script?.dispatchEvent(new Event('error'));
    await expect(first).rejects.toThrow(/could not be loaded/);
    expect(document.getElementById(PLAID_LINK_SCRIPT_ID)).toBeNull();

    const plaid = fakePlaid();
    const retry = loadPlaidLinkScript();
    const fresh = document.getElementById(PLAID_LINK_SCRIPT_ID);
    expect(fresh).not.toBeNull();
    window.Plaid = plaid;
    fresh?.dispatchEvent(new Event('load'));
    await expect(retry).resolves.toBe(plaid);
  });

  it('rejects when the script loads without providing the namespace', async () => {
    const pending = loadPlaidLinkScript();
    document
      .getElementById(PLAID_LINK_SCRIPT_ID)
      ?.dispatchEvent(new Event('load'));
    await expect(pending).rejects.toThrow(/did not start/);
  });

  it('never touches token storage mechanisms', async () => {
    const getItem = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem });
    vi.stubGlobal('sessionStorage', { getItem, setItem });
    const plaid = fakePlaid();
    const pending = loadPlaidLinkScript();
    window.Plaid = plaid;
    document
      .getElementById(PLAID_LINK_SCRIPT_ID)
      ?.dispatchEvent(new Event('load'));
    await expect(pending).resolves.toBe(plaid);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
});
