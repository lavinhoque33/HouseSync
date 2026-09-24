import type { TransactionCategory } from '../auth/client';

/**
 * Server-returned labels are the only user-visible category names. When the
 * taxonomy could not be loaded, or when a code is absent from it, the calm
 * unavailable text is shown instead: a raw enum token is never rendered as a
 * category name.
 */
export function categoryLabel(
  category: string | null,
  categories: TransactionCategory[] | null,
): string {
  if (category === null) return 'Uncategorized';
  if (categories === null) return 'Category unavailable';
  return (
    categories.find((value) => value.code === category)?.label ??
    'Category unavailable'
  );
}
