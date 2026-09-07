import type { ReactNode } from 'react';

type Props = {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
};

export function TabButton({ active, onClick, children, className = 'px-3 py-2 text-[12px]' }: Props) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`${className} font-medium border-b-2 transition-colors -mb-px ${
        active
          ? 'border-accent text-fg'
          : 'border-transparent text-muted hover:text-fg-secondary'
      }`}
    >
      {children}
    </button>
  );
}
