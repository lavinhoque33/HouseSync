import type { CSSProperties } from 'react';

const paths = {
  menu: 'M5 12h.01M12 12h.01M19 12h.01',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  inbox: 'M4 4h16l2 11v5H2v-5L4 4ZM2 15h6l2 3h4l2-3h6M8 8h8M9 11h6',
  'chevron-right': 'm9 5 7 7-7 7',
  'chevron-down': 'm5 9 7 7 7-7',
  'arrow-right': 'M4 12h16m-6-6 6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M6 18 18 6',
  filter: 'M4 7h16M7 12h10M10 17h4',
  settings:
    'm9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3H9ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  home: 'm3 10 9-7 9 7v11h-7v-7h-4v7H3V10Z',
  wallet:
    'M3 6a2 2 0 0 1 2-2h14v4H5a2 2 0 0 1-2-2Zm0 0v13a2 2 0 0 0 2 2h16V8M21 12h-6v5h6M17 14.5h.01',
  chart: 'M4 3v17h17M8 15v-4m5 4V7m5 8V4',
  users:
    'M14 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM3 21v-3a8 8 0 0 1 16 0v3M17 4a3 3 0 0 1 0 6m3 4a7 7 0 0 1 2 5v2',
  shield: 'm12 3 9 4v5c0 5-9 10-9 10S3 17 3 12V7l9-4Zm-4 9 3 3 5-6',
  logout: 'M9 3H3v18h6M8 12h13m-5-5 5 5-5 5',
  check: 'm5 12 4 4L19 6',
  search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6',
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  className,
  style,
}: {
  name: IconName;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={className ? `ui-icon ${className}` : 'ui-icon'}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'menu' ? 3.5 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
