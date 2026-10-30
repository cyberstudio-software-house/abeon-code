import type { ReactNode } from 'react';

type Props = {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
};

export function TabButton({ active, onClick, children, className = 'h-[26px] px-[9px] text-[12px]' }: Props) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`${className} rounded-md transition-colors ${
        active
          ? 'bg-bg-elev-2 text-fg-strong'
          : 'text-icon hover:text-fg-strong'
      }`}
    >
      {children}
    </button>
  );
}
