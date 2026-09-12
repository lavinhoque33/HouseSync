import { HealthStatus } from './HealthStatus';

export function App() {
  return (
    <div className="shell">
      <header className="site-header">
        <span className="identity">
          <svg
            className="brand-mark"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
          >
            <path d="M5 15 16 5l11 10v12h-8v-8h-6v8H5Z" />
          </svg>
          HouseSync
        </span>
        <span className="area-badge">Foundation</span>
      </header>

      <main id="main-content">
        <section className="intro" aria-labelledby="welcome-title">
          <p className="eyebrow">A little more together.</p>
          <h1 id="welcome-title">A shared home for household finances.</h1>
          <p className="intro-copy">
            HouseSync is taking shape: a place to understand household spending
            together, with room for personal privacy.
          </p>
        </section>

        <section className="foundation" aria-labelledby="foundation-title">
          <div className="foundation-copy">
            <p className="eyebrow">Where we are</p>
            <h2 id="foundation-title">First, a solid foundation.</h2>
            <p>
              The web shell is running. This build establishes the technical
              starting point; accounts, households, and financial features are
              still ahead.
            </p>
          </div>
          <HealthStatus />
        </section>
      </main>

      <footer className="site-footer">
        <p>HouseSync · Built for the household, mindful of the individual.</p>
        <p>Foundation preview — no financial data connected.</p>
      </footer>
    </div>
  );
}
