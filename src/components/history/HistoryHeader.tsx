import { useEffect, useRef, useState } from 'react';
import type { SessionMeta } from '../../types';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { getCliModelString } from '../../lib/models';
import { IconBtn } from '../shared/IconBtn';
import { ACTIVITY_DOT, ACTIVITY_LABEL, ACTIVITY_ICON } from '../../lib/activity';
import { Icon } from '../shared/Icon';

type Props = { meta: SessionMeta };

export function HistoryHeader({ meta }: Props) {
  const [editing, setEditing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rename = useStore(s => s.renameSession);
  const openTerminal = useStore(s => s.openNewTerminalTab);
  const titleGenModelId = useStore(s => s.titleGenModelId);
  const customModels = useStore(s => s.customModels);

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
      const modelCli = getCliModelString(titleGenModelId, customModels);
      const title = (await tauri.generateSessionTitle(meta.projectId, meta.id, modelCli)).trim();
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
      // clipboard API can fail in some webviews — ignore silently
    }
  };

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <header className="px-7 pt-[18px] pb-3.5 border-b border-border bg-bg shrink-0">
      <div className="font-mono text-[10px] text-muted tracking-wide">
        sesja {meta.id.slice(0, 8)} · {new Date(meta.lastModified).toLocaleString('pl-PL')}
      </div>
      <div className="mt-1.5 flex items-baseline gap-3.5">
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
            className="m-0 text-[20px] font-medium tracking-[-0.3px] bg-transparent border-b-2 border-accent outline-none text-fg flex-1 min-w-0"
          />
        ) : (
          <h1
            className="m-0 text-[20px] font-medium tracking-[-0.3px] cursor-pointer hover:text-accent transition-colors"
            onClick={() => setEditing(true)}
            title="Kliknij, aby zmienić nazwę"
          >
            {meta.title}
          </h1>
        )}
        <span
          className={`inline-flex items-center gap-1.5 text-[10px] font-mono ${ACTIVITY_DOT[meta.activity]} text-bg px-[7px] py-0.5 rounded-full`}
          title={ACTIVITY_LABEL[meta.activity]}
        >
          <Icon
            name={ACTIVITY_ICON[meta.activity]}
            className={`w-3 h-3 ${meta.activity === 'running' ? 'animate-spin' : ''}`}
          />
          {ACTIVITY_LABEL[meta.activity]}
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          {generating ? (
            <span className="text-[11px] text-fg-secondary font-mono">
              Generuję tytuł…
            </span>
          ) : copied ? (
            <span className="text-[11px] text-fg-secondary font-mono">
              Skopiowano ID sesji do schowka
            </span>
          ) : null}
          <div className="flex gap-1.5">
            <IconBtn
              icon="sparkles"
              label={generating ? 'Generuję tytuł…' : 'Generuj tytuł sesji'}
              onClick={handleGenerateTitle}
              loading={generating}
            />
            <IconBtn
              icon="copy"
              label={copied ? 'Skopiowano' : 'Kopiuj ID sesji'}
              onClick={handleCopyId}
            />
            <IconBtn
              icon="terminal"
              label="Otwórz terminal"
              onClick={() => openTerminal(meta.projectId)}
            />
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex gap-[18px] text-[11px] text-fg-secondary font-mono">
        <span>{meta.messageCount} tur</span>
        <span className="text-muted">·</span>
        <span>{meta.gitBranch ?? 'no branch'}</span>
      </div>
      {genError && (
        <div className="mt-2 text-[11px] text-danger font-mono">
          Nie udało się wygenerować tytułu: {genError}
        </div>
      )}
    </header>
  );
}
