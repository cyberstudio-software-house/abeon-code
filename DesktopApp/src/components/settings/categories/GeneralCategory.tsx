import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useStore } from '../../../store';
import type { SessionRestoreMode } from '../../../store/settingsSlice';
import { tauri } from '../../../lib/tauri';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import type { ShellInfo, EditorInfo } from '../../../types';
import { SettingsPage } from '../controls';
import { SELECT_BASE } from './shared';

const SESSION_RESTORE_OPTIONS: { value: SessionRestoreMode; label: string }[] = [
  { value: 'ask', label: 'Pytaj' },
  { value: 'always', label: 'Wznawiaj automatycznie' },
  { value: 'never', label: 'Nie wznawiaj' },
];

export function GeneralCategory() {
  const displayName = useStore(s => s.displayName);
  const setDisplayName = useStore(s => s.setDisplayName);
  const projectsBasePath = useStore(s => s.projectsBasePath);
  const setProjectsBasePath = useStore(s => s.setProjectsBasePath);
  const shellPath = useStore(s => s.shellPath);
  const setShellPath = useStore(s => s.setShellPath);
  const editorPath = useStore(s => s.editorPath);
  const setEditorPath = useStore(s => s.setEditorPath);
  const historyViewMode = useStore(s => s.historyViewMode);
  const setHistoryViewMode = useStore(s => s.setHistoryViewMode);
  const sessionRestoreMode = useStore(s => s.sessionRestoreMode);
  const setSessionRestoreMode = useStore(s => s.setSessionRestoreMode);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [detectedName, setDetectedName] = useState<string | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [editorCustomMode, setEditorCustomMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, detected, editorList] = await Promise.all([
          tauri.listAvailableShells(),
          tauri.detectDefaultShell(),
          tauri.listAvailableEditors(),
        ]);
        if (cancelled) return;
        setShells(list);
        setEditors(editorList);
        if (detected) {
          const match = list.find(s => s.path === detected || s.name === detected);
          setDetectedName(match?.name ?? detected);
        }
      } catch (err) {
        console.error('[settings] failed to load shells/editors', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const isCustom = shellPath !== '' && !shells.some(s => s.name === shellPath || s.path === shellPath);
  const showCustom = isCustom || customMode;
  const isEditorCustom = editorPath !== '' && !editors.some(s => s.name === editorPath || s.path === editorPath);
  const showEditorCustom = isEditorCustom || editorCustomMode;

  const pickProjectsBase = async () => {
    const sel = await open({
      directory: true,
      multiple: false,
      defaultPath: projectsBasePath || undefined,
    });
    if (typeof sel === 'string') setProjectsBasePath(sel);
  };

  return (
    <SettingsPage title={SETTINGS_CATEGORIES.general.label} description={SETTINGS_CATEGORIES.general.description}>
      <div className="space-y-6">
        <div>
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
            Nazwa wyświetlana
          </label>
          <input
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Domyślnie z konfiguracji Git"
            className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] placeholder:text-muted/60"
          />
          <p className="text-[11px] text-muted mt-2">
            Wyświetlana w stopce panelu bocznego. Puste pole oznacza użycie nazwy z Git.
          </p>
        </div>

        <div>
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
            Ścieżka bazowa projektów
          </label>
          <div className="flex gap-2">
            <input
              value={projectsBasePath}
              onChange={e => setProjectsBasePath(e.target.value)}
              placeholder="Nie ustawiono"
              className="flex-1 bg-bg border border-border px-3 py-1.5 text-[13px] font-mono placeholder:text-muted/60"
            />
            <button
              onClick={pickProjectsBase}
              className="px-3 py-1.5 border border-border bg-bg-elev-2 text-[12px] text-fg-secondary hover:text-fg shrink-0"
            >
              Wybierz…
            </button>
          </div>
          <p className="text-[11px] text-muted mt-2">
            Katalog, od którego rozpoczyna się wybieranie folderu przy dodawaniu nowego projektu.
          </p>
        </div>

        <div>
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
            Sesje po uruchomieniu
          </label>
          <div className="flex gap-1">
            {SESSION_RESTORE_OPTIONS.map(o => (
              <button
                key={o.value}
                onClick={() => setSessionRestoreMode(o.value)}
                className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                  sessionRestoreMode === o.value
                    ? 'bg-fg text-bg border-fg'
                    : 'bg-bg border-border text-muted hover:text-fg'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted mt-2">
            Dotyczy sesji, które działały w terminalu w chwili zamknięcia programu. Opcja „Pytaj"
            pokazuje ich listę przy starcie.
          </p>
        </div>

        <div>
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
            Domyślny widok historii
          </label>
          <div className="flex gap-1">
            <button
              onClick={() => setHistoryViewMode('communication')}
              className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                historyViewMode === 'communication'
                  ? 'bg-fg text-bg border-fg'
                  : 'bg-bg border-border text-muted hover:text-fg'
              }`}
            >
              Komunikacja
            </button>
            <button
              onClick={() => setHistoryViewMode('full')}
              className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                historyViewMode === 'full'
                  ? 'bg-fg text-bg border-fg'
                  : 'bg-bg border-border text-muted hover:text-fg'
              }`}
            >
              Pełny
            </button>
          </div>
          <p className="text-[11px] text-muted mt-2">
            Tryb „Komunikacja" pokazuje tylko wiadomości użytkownika i asystenta.
            „Pełny" zawiera też narzędzia, hooki i zdarzenia systemowe.
          </p>
        </div>

        <div>
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
            Domyślny shell
          </label>
          <select
            value={showCustom ? '__custom__' : shellPath}
            onChange={e => {
              const v = e.target.value;
              if (v === '__custom__') {
                setCustomMode(true);
              } else {
                setCustomMode(false);
                setShellPath(v);
              }
            }}
            className={`${SELECT_BASE} w-full px-3 py-1.5 text-[13px]`}
          >
            <option value="">Auto (z $SHELL)</option>
            {shells.map(s => (
              <option key={s.path} value={s.name}>{s.name} ({s.path})</option>
            ))}
            <option value="__custom__">Inny…</option>
          </select>
          {showCustom && (
            <input
              value={shellPath}
              onChange={e => setShellPath(e.target.value)}
              placeholder="/opt/homebrew/bin/fish"
              className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] font-mono mt-2"
            />
          )}
          <p className="text-[11px] text-muted mt-2">
            {detectedName
              ? <>Wykryto: <code className="font-mono text-fg-secondary">{detectedName}</code>. </>
              : null}
            Dotyczy tylko interaktywnych terminali (tab Shell).
          </p>
        </div>

        <div>
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
            Domyślny edytor
          </label>
          <select
            value={showEditorCustom ? '__custom__' : editorPath}
            onChange={e => {
              const v = e.target.value;
              if (v === '__custom__') {
                setEditorCustomMode(true);
              } else {
                setEditorCustomMode(false);
                setEditorPath(v);
              }
            }}
            className={`${SELECT_BASE} w-full px-3 py-1.5 text-[13px]`}
          >
            <option value="">Auto (pierwszy wykryty)</option>
            {editors.map(s => (
              <option key={s.path} value={s.name}>{s.name} ({s.path})</option>
            ))}
            <option value="__custom__">Inny…</option>
          </select>
          {showEditorCustom && (
            <input
              value={editorPath}
              onChange={e => setEditorPath(e.target.value)}
              placeholder="/usr/bin/code"
              className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] font-mono mt-2"
            />
          )}
          <p className="text-[11px] text-muted mt-2">
            {editors.length > 0
              ? <>Wykryto: {editors.map(s => s.name).join(', ')}. </>
              : null}
            Edytor używany do otwierania projektów z panelu bocznego.
          </p>
        </div>
      </div>
    </SettingsPage>
  );
}
