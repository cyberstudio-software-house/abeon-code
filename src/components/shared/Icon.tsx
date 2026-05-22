import type { ReactNode, SVGProps } from 'react';

const paths: Record<string, ReactNode> = {
  search:   <g><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></g>,
  chevR:    <polyline points="9 6 15 12 9 18"/>,
  chevD:    <polyline points="6 9 12 15 18 9"/>,
  chevU:    <polyline points="6 15 12 9 18 15"/>,
  plus:     <g><path d="M12 5v14"/><path d="M5 12h14"/></g>,
  play:     <polygon points="6 4 20 12 6 20" fill="currentColor" stroke="none"/>,
  pause:    <g fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></g>,
  stop:     <rect x="6" y="6" width="12" height="12" fill="currentColor" stroke="none"/>,
  branch:   <g><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v6a6 6 0 0 0 6 6"/></g>,
  copy:     <g><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></g>,
  more:     <g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></g>,
  clock:    <g><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></g>,
  arrow:    <g><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></g>,
  settings: <g><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></g>,
  folder:   <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>,
  dot:      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>,
  terminal: <g><polyline points="4 6 9 11 4 16"/><line x1="12" y1="16" x2="20" y2="16"/></g>,
  refresh:  <g><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></g>,
  trash:    <g><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></g>,
  close:    <g><path d="M18 6 6 18"/><path d="m6 6 12 12"/></g>,
};

export type IconName = keyof typeof paths;

type Props = {
  name: IconName;
  className?: string;
  strokeWidth?: number;
} & Omit<SVGProps<SVGSVGElement>, 'children'>;

export function Icon({ name, className = 'w-3.5 h-3.5', strokeWidth = 2, ...rest }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
