import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Icon } from '../shared/Icon';

export function SavedHint() {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-muted">
      <Icon name="check" className="w-[13px] h-[13px] text-success" strokeWidth={2.7} />
      Zmiany zapisują się automatycznie
    </span>
  );
}

export function SettingsPage({ title, description, badge, actions, wide, children }: {
  title: string;
  description: string;
  badge?: string;
  actions?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`mx-auto flex flex-col gap-7 ${wide ? 'max-w-[1100px]' : 'max-w-[760px]'}`}>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex-[1_1_300px] min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-fg">{title}</h1>
            {badge && (
              <span className="rounded-full bg-accent/[0.14] px-2 py-0.5 text-[11px] font-medium text-accent">{badge}</span>
            )}
          </div>
          <p className="mt-1.5 text-[13px] text-muted">{description}</p>
        </div>
        {actions ?? <SavedHint />}
      </div>
      {children}
    </div>
  );
}

const FIELD_BASE =
  'h-8 min-w-0 rounded-[8px] border border-border-strong bg-field px-2.5 text-fg placeholder:text-muted disabled:opacity-50';

export const FIELD_CLASS = `${FIELD_BASE} text-[13px]`;

export const MONO_FIELD_CLASS = `${FIELD_BASE} font-mono text-[12px]`;

export const TEXTAREA_CLASS =
  'min-w-0 resize-y rounded-[8px] border border-border-strong bg-field px-2.5 py-2 font-mono text-[12px] text-fg placeholder:text-muted';

const BUTTON_BASE =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[8px] px-3 text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50';

export const BUTTON_CLASS = `${BUTTON_BASE} border border-border-strong bg-button text-fg hover:bg-pressed`;

export const PRIMARY_BUTTON_CLASS = `${BUTTON_BASE} bg-accent font-medium text-accent-fg hover:bg-accent-hover`;

export function SettingsSection({ label, description, action, children }: {
  label: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <h2 id={id} className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.06em] text-label">{label}</h2>
        {action}
      </div>
      {description && <p className="px-0.5 text-[12px] leading-[1.5] text-muted">{description}</p>}
      <div className="rounded-[12px] border border-border bg-sunken divide-y divide-border-subtle">{children}</div>
    </section>
  );
}

const ROW_LABEL = 'block text-[13.5px] font-medium text-fg-strong';

export function SettingsRow({ label, description, htmlFor, labelId, children }: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  labelId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-[18px] py-4">
      <div className="flex-[1_1_280px] min-w-0">
        {htmlFor
          ? <label htmlFor={htmlFor} data-settings-row-label="" className={ROW_LABEL}>{label}</label>
          : <span id={labelId} data-settings-row-label="" className={ROW_LABEL}>{label}</span>}
        {description && (
          <p data-settings-row-description="" className="mt-[3px] text-[12px] leading-[1.5] text-muted">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, labelledBy }: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  labelledBy: string;
}) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="inline-flex flex-wrap gap-0.5 rounded-[9px] border border-border-raised bg-field p-[3px]"
    >
      {options.map(option => {
        const pressed = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(option.value)}
            className={`inline-flex h-[26px] items-center gap-[7px] rounded-[6px] px-2.5 text-[12.5px] transition-colors ${
              pressed ? 'bg-pressed text-fg-strong' : 'text-icon hover:text-fg'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ checked, onChange, labelledBy, disabled }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  labelledBy: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-pressed'
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 h-4 w-4 rounded-full transition-[left] ${
          checked ? 'left-[18px] bg-accent-fg' : 'left-0.5 bg-icon'
        }`}
      />
    </button>
  );
}

const STEPPER_BUTTON =
  'grid h-[30px] w-8 place-items-center text-fg-secondary transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';

export function Stepper({ value, min, max, unit, onChange, labelledBy, decreaseLabel, increaseLabel }: {
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
  labelledBy: string;
  decreaseLabel: string;
  increaseLabel: string;
}) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="inline-flex items-center rounded-[9px] border border-border-strong bg-field"
    >
      <button
        type="button"
        aria-label={decreaseLabel}
        disabled={value <= min}
        onClick={() => onChange(Math.min(max, Math.max(min, value - 1)))}
        className={STEPPER_BUTTON}
      >
        <Icon name="minus" className="h-3 w-3" strokeWidth={2.5} />
      </button>
      <span className="min-w-14 border-x border-border-raised text-center font-mono text-[12.5px] leading-[30px]">
        {value} {unit}
      </span>
      <button
        type="button"
        aria-label={increaseLabel}
        disabled={value >= max}
        onClick={() => onChange(Math.max(min, Math.min(max, value + 1)))}
        className={STEPPER_BUTTON}
      >
        <Icon name="plus" className="h-3 w-3" strokeWidth={2.5} />
      </button>
    </div>
  );
}

export function SelectField({ className = '', wrapperClassName = 'flex-[0_1_280px]', ...props }: SelectHTMLAttributes<HTMLSelectElement> & {
  wrapperClassName?: string;
}) {
  return (
    <span className={`relative block min-w-0 ${wrapperClassName}`}>
      <select
        {...props}
        className={`h-8 w-full cursor-pointer appearance-none rounded-[8px] border border-border-strong bg-field pl-2.5 pr-[30px] text-[13px] text-fg disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      />
      <Icon
        name="chevron"
        className="pointer-events-none absolute right-[11px] top-[10px] h-3 w-3 text-icon"
        strokeWidth={2.4}
      />
    </span>
  );
}
