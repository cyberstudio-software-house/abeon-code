import { useEffect, useRef, useState } from 'react';
import type { SessionMeta, Provider } from '../../types';
import type { HistoryViewMode } from '../../store/settingsSlice';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { getCliModelString } from '../../lib/models';
import { ACTIVITY_DOT, ACTIVITY_LABEL, ACTIVITY_SHORT_LABEL, activityPulses } from '../../lib/activity';
import { PROVIDER_LABEL } from '../../lib/providers';
import { Icon, type IconName } from '../shared/Icon';

type Props = {
  meta: SessionMeta;
  viewMode: HistoryViewMode;
  onViewModeChange: (mode: HistoryViewMode) => void;
  provider?: Provider;
  onToggleSearch: () => void;
  searchOpen?: boolean;
};

type HeaderButtonProps = {
  icon: IconName;
  label: string;
  onClick: () => void;
  loading?: boolean;
  active?: boolean;
};

function HeaderButton({ icon, label, onClick, loading = false, active = false }: HeaderButtonProps) {
  return (
    <button
      type="button"
      onClick={loading ? undefined : onClick}
      aria-label={label}
      aria-busy={loading || undefined}
      title={label}
      disabled={loading}
      className={`grid h-[30px] w-[30px] place-items-center rounded-[7px] transition-colors ${
        active ? 'bg-track text-fg-strong' : 'text-icon hover:bg-raised-strong hover:text-fg-strong'
      } ${loading ? 'cursor-wait opacity-70' : ''}`}
    >
      <Icon
        name={loading ? 'spinner' : icon}
        className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
      />
    </button>
  );
}

const SEGMENT_BASE = 'inline-flex h-[26px] items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] transition-colors';

export function HistoryHeader({ meta, viewMode, onViewModeChange, provider = 'claude', onToggleSearch, searchOpen = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rename = useStore(s => s.renameSession);
  const openTerminal = useStore(s => s.openTerminal);
  const titleGenModelId = useStore(s => s.titleGenModelId);
  const codexTitleGenModelId = useStore(s => s.codexTitleGenModelId);
  const opencodeTitleGenModelId = useStore(s => s.opencodeTitleGenModelId);

  const commitRename = () => {
    const value = inputRef.current?.value.trim();
    if (value && value !== meta.title) {
      rename(meta.projectId, meta.id, value);
    }
    setEditing(false);
  };

  const handleGenerateTitle = async () => {
    if (generating) return;
    setGenerating(true);
    setGenError(null);
    try {
      const modelCli = provider === 'codex'
        ? (codexTitleGenModelId || undefined)
        : provider === 'opencode'
          ? (opencodeTitleGenModelId || undefined)
          : (getCliModelString(titleGenModelId) ?? undefined);
      const title = (await tauri.generateSessionTitle(meta.projectId, meta.id, modelCli, provider)).trim();
      if (title && title !== meta.title) {
        await rename(meta.projectId, meta.id, title);
      }
    } catch (e) {
      const msg =
        e instanceof Error ? e.message :
        (typeof e === 'object' && e !== null && 'message' in e && typeof (e as { message: unknown }).message === 'string')
          ? (e as { message: string }).message :
        typeof e === 'string' ? e :
        JSON.stringify(e);
      setGenError(msg);
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(meta.id);
      setCopied(true);
    } catch {
      // clipboard API can fail in some webviews
    }
  };

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const dateLabel = new Date(meta.lastModified).toLocaleString('pl-PL', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <header className="flex shrink-0 flex-col gap-2.5 border-b border-border px-7 pb-3.5 pt-[18px]">
      <span className="font-mono text-[11px] text-label">
        sesja {meta.id.slice(0, 8)} · {dateLabel}
      </span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {editing ? (
          <input
            ref={inputRef}
            defaultValue={meta.title}
            autoFocus
            onFocus={e => e.target.select()}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="m-0 min-w-0 flex-1 border-b-2 border-accent bg-transparent text-[18px] font-semibold tracking-[-0.01em] text-fg-strong outline-none"
          />
        ) : (
          <h1
            className="m-0 min-w-0 cursor-pointer text-[18px] font-semibold tracking-[-0.01em] text-fg-strong transition-colors hover:text-accent"
            onClick={() => setEditing(true)}
            title="Kliknij, aby zmienić nazwę"
          >
            {meta.title}
          </h1>
        )}
        <span
          title={ACTIVITY_LABEL[meta.activity]}
          className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-border-raised bg-field px-[9px] text-[11.5px] text-icon"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${ACTIVITY_DOT[meta.activity]} ${activityPulses(meta.activity) ? 'activity-pulse' : ''}`}
          />
          {ACTIVITY_SHORT_LABEL[meta.activity]}
        </span>
        <span className="flex-1" />
        {generating ? (
          <span className="font-mono text-[11px] text-fg-secondary">
            Generuję tytuł…
          </span>
        ) : copied ? (
          <span className="font-mono text-[11px] text-fg-secondary">
            Skopiowano ID sesji do schowka
          </span>
        ) : null}
        <div className="flex items-center gap-0.5">
          <HeaderButton icon="search" label="Szukaj w sesji" onClick={onToggleSearch} active={searchOpen} />
          <HeaderButton
            icon="sparkles"
            label={generating ? 'Generuję tytuł…' : 'Generuj tytuł sesji'}
            onClick={handleGenerateTitle}
            loading={generating}
          />
          <HeaderButton
            icon="copy"
            label={copied ? 'Skopiowano' : 'Kopiuj ID sesji'}
            onClick={handleCopyId}
          />
          <HeaderButton
            icon="terminal"
            label="Otwórz terminal"
            onClick={() => openTerminal(meta.projectId, { toggle: false })}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-muted">
          <span>{meta.messageCount} tur</span>
          <span aria-hidden="true" className="text-faint">·</span>
          <span className={meta.gitBranch ? 'text-success' : undefined}>{meta.gitBranch ?? 'no branch'}</span>
          <span aria-hidden="true" className="text-faint">·</span>
          <span>{PROVIDER_LABEL[provider]}</span>
        </span>
        <span className="flex-1" />
        <div
          role="group"
          aria-label="Widok historii"
          className="inline-flex gap-0.5 rounded-[9px] border border-border-raised bg-field p-[3px]"
        >
          <button
            type="button"
            aria-pressed={viewMode === 'communication'}
            onClick={() => onViewModeChange('communication')}
            className={`${SEGMENT_BASE} ${viewMode === 'communication' ? 'bg-pressed text-fg-strong' : 'text-icon hover:text-fg'}`}
            title="Tylko komunikacja (wiadomości użytkownika i asystenta)"
          >
            Komunikacja
          </button>
          <button
            type="button"
            aria-pressed={viewMode === 'full'}
            onClick={() => onViewModeChange('full')}
            className={`${SEGMENT_BASE} ${viewMode === 'full' ? 'bg-pressed text-fg-strong' : 'text-icon hover:text-fg'}`}
            title="Pełny widok (komunikacja + narzędzia + system)"
          >
            Pełny
          </button>
        </div>
      </div>
      {genError && (
        <div className="font-mono text-[11px] text-danger">
          Nie udało się wygenerować tytułu: {genError}
        </div>
      )}
    </header>
  );
}
