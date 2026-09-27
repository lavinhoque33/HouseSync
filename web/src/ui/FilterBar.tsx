import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Overlay } from './Overlay';

export function FilterBar({
  summary,
  activeCount,
  onReset,
  children,
  disabled = false,
  title = 'Filters',
}: {
  summary: string;
  activeCount: number;
  onReset: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const summaryId = useId();
  return (
    <div className="filter-bar">
      <span id={summaryId} className="filter-summary">
        {summary}
      </span>
      <div className="filter-bar-actions">
        {activeCount > 0 && (
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={onReset}
          >
            Clear filters
          </button>
        )}
        <button
          type="button"
          className="filter-trigger"
          aria-haspopup="dialog"
          aria-describedby={summaryId}
          aria-label={
            activeCount > 0
              ? `Filters, ${activeCount} active ${activeCount === 1 ? 'filter' : 'filters'}`
              : undefined
          }
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <Icon name="filter" />
          <span>Filters</span>
          {activeCount > 0 && (
            <span className="filter-count" aria-hidden="true">
              {activeCount}
            </span>
          )}
        </button>
      </div>
      <Overlay open={open} onClose={() => setOpen(false)} title={title}>
        <div className="filter-sheet-fields">{children}</div>
        <div className="overlay-footer">
          <button
            type="button"
            className="household-button household-button--secondary"
            disabled={disabled}
            onClick={onReset}
          >
            Reset filters
          </button>
          <button
            type="button"
            className="household-button"
            onClick={() => setOpen(false)}
          >
            Done
          </button>
        </div>
      </Overlay>
    </div>
  );
}
