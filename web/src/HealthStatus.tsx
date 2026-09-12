import { useEffect, useState } from 'react';

type Health = 'loading' | 'available' | 'unavailable';

const messages: Record<Health, { title: string; detail: string }> = {
  loading: {
    title: 'Checking backend',
    detail: 'Waiting for a response from the health endpoint.',
  },
  available: {
    title: 'Backend available',
    detail: 'The backend reported UP when this page opened.',
  },
  unavailable: {
    title: 'Backend unavailable',
    detail:
      'A healthy backend response could not be confirmed. The web shell is still available.',
  },
};

export function HealthStatus() {
  const [health, setHealth] = useState<Health>('loading');

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = window.setTimeout(() => {
      controller.abort();
      setHealth('unavailable');
    }, 5_000);

    async function checkHealth() {
      try {
        const response = await fetch('/actuator/health', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Health request failed.');
        const body: unknown = await response.json();
        const isUp =
          typeof body === 'object' &&
          body !== null &&
          'status' in body &&
          body.status === 'UP';

        if (!disposed && !controller.signal.aborted) {
          setHealth(isUp ? 'available' : 'unavailable');
        }
      } catch {
        if (!disposed) setHealth('unavailable');
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void checkHealth();

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  return (
    <aside className="health" aria-labelledby="health-title">
      <h3 id="health-title">Service connection</h3>
      <div role="status" aria-live="polite" aria-atomic="true">
        <p className="health-label">
          <span
            className={`status-dot status-dot--${health}`}
            aria-hidden="true"
          />
          {messages[health].title}
        </p>
        <p className="health-detail">{messages[health].detail}</p>
      </div>
      <p className="health-note">
        <code>GET /actuator/health</code>
        <br />
        Checked on page load, with a five-second timeout.
      </p>
    </aside>
  );
}
