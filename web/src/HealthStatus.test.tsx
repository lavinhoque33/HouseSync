import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { HealthStatus } from './HealthStatus';

describe('backend health', () => {
  it('announces loading and calls the same-origin endpoint', () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<HealthStatus />);

    expect(screen.getByRole('status')).toHaveTextContent('Checking backend');
    expect(fetchMock).toHaveBeenCalledWith(
      '/actuator/health',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      }),
    );
  });

  it('announces availability only after a successful UP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ status: 'UP' })),
    );
    render(<HealthStatus />);

    expect(await screen.findByText('Backend available')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('reported UP');
  });

  it.each([
    ['an unhealthy service', () => Response.json({ status: 'DOWN' })],
    ['a missing status', () => Response.json({})],
    ['a null body', () => Response.json(null)],
    ['an HTTP failure', () => Response.json({ status: 'UP' }, { status: 503 })],
    [
      'an HTML fallback',
      () => new Response('<html>Not an API response</html>'),
    ],
  ])('shows unavailable for %s', async (_, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    render(<HealthStatus />);

    expect(await screen.findByText('Backend unavailable')).toBeInTheDocument();
  });

  it('keeps the foundation usable when the network request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Network error')),
    );
    render(<App />);

    expect(await screen.findByText('Backend unavailable')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'A shared home for household finances.',
    );
    expect(
      screen.getByText(/financial features are still ahead/),
    ).toBeInTheDocument();
    // The health panel is a generic block, not a complementary landmark:
    // inside <main> an <aside> would violate the top-level landmark rule.
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    // A role-less generic container cannot carry aria-labelledby; the
    // heading and the live status region keep the panel navigable.
    const healthPanel = screen
      .getByRole('heading', { level: 3, name: 'Service connection' })
      .closest('.health');
    expect(healthPanel).not.toHaveAttribute('aria-labelledby');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('times out a stalled request and ignores a late success', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<HealthStatus />);

    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(screen.getByRole('status')).toHaveTextContent('Backend unavailable');
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    await act(async () => {
      finish(Response.json({ status: 'UP' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Backend unavailable');
  });

  it('aborts the request and clears its timeout on unmount', () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      () => new Promise<Response>(() => {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<HealthStatus />);

    unmount();

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
