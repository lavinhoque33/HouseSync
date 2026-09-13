import { describe, expect, it, vi } from 'vitest';
import { ApiError, fetchCsrf, fetchMe, postLogout } from './client';

function hangingBodyResponse(status: number, ok: boolean): Response {
  return {
    status,
    ok,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    text: () => new Promise<string>(() => {}),
  } as unknown as Response;
}

describe('auth request deadline', () => {
  it('bounds a stalled success body by the deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(hangingBodyResponse(200, true)),
    );
    const started = Date.now();
    const failure = await fetchCsrf(undefined, 50).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure as ApiError).toMatchObject({
      code: 'NETWORK_ERROR',
      timedOut: true,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('bounds a stalled error body by the deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(hangingBodyResponse(500, false)),
    );
    const failure = await fetchMe(undefined, 50).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure as ApiError).toMatchObject({
      code: 'NETWORK_ERROR',
      timedOut: true,
    });
  });

  it('reports a parent abort during the body as cancellation, not a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(hangingBodyResponse(200, true)),
    );
    const controller = new AbortController();
    const pending = fetchCsrf(controller.signal, 5_000);
    controller.abort();
    const failure = await pending.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure as ApiError).toMatchObject({
      code: 'UNKNOWN_ERROR',
      timedOut: false,
    });
  });

  it('keeps 204 logout bodyless', async () => {
    let textCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 204,
        ok: true,
        headers: new Headers(),
        text: () => {
          textCalled = true;
          return Promise.resolve('');
        },
      } as unknown as Response),
    );
    await postLogout({ token: 'csrf-token', headerName: 'X-CSRF-TOKEN' });
    expect(textCalled).toBe(false);
  });
});
