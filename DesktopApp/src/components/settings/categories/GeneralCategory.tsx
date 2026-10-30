import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useStore } from '../../../store';
import type { HistoryViewMode, SessionRestoreMode } from '../../../store/settingsSlice';
import { tauri } from '../../../lib/tauri';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import type { ShellInfo, EditorInfo } from '../../../types';
import {
  BUTTON_CLASS, FIELD_CLASS, MONO_FIELD_CLASS, Segmented, SelectField, SettingsPage, SettingsRow, SettingsSection,
} from '../controls';

const SESSION_RESTORE_OPTIONS: { value: SessionRestoreMode; label: string }[] = [
  { value: 'ask', label: 'Pytaj' },
  { value: 'always', label: 'Wznawiaj automatycznie' },
  { value: 'never', label: 'Nie wznawiaj' },
];

const HISTORY_VIEW_OPTIONS: { value: HistoryViewMode; label: string }[] = [
  { value: 'communication', label: 'Komunikacja' },
  { value: 'full', label: 'Pełny' },
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

  const selectedShell = showCustom ? '__custom__' : shellPath;
  const selectedEditor = showEditorCustom ? '__custom__' : editorPath;

  return (
    <SettingsPage title={SETTINGS_CATEGORIES.general.label} description={SETTINGS_CATEGORIES.general.description}>
      <SettingsSection label="Profil i projekty">
        <SettingsRow
          label="Nazwa wyświetlana"
          htmlFor="settings-general-name"
          description="Wyświetlana w stopce panelu bocznego. Puste pole oznacza użycie nazwy z Git."
        >
          <input
            id="settings-general-name"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Domyślnie z konfiguracji Git"
            className={`${FIELD_CLASS} flex-[0_1_280px]`}
          />
        </SettingsRow>
        <SettingsRow
          label="Ścieżka bazowa projektów"
          htmlFor="settings-general-base"
          description="Od tego katalogu zaczyna się wybór folderu przy dodawaniu nowego projektu."
        >
          <div className="flex min-w-0 flex-[0_1_280px] gap-1.5">
            <input
              id="settings-general-base"
              value={projectsBasePath}
              onChange={e => setProjectsBasePath(e.target.value)}
              placeholder="Nie ustawiono"
              className={`${MONO_FIELD_CLASS} min-w-0 flex-1`}
            />
            <button type="button" onClick={pickProjectsBase} className={BUTTON_CLASS}>
              Wybierz…
            </button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label="Sesje">
        <SettingsRow
          label="Sesje po uruchomieniu"
          labelId="settings-general-restore"
          description="Dotyczy sesji, które działały w chwili zamknięcia programu. „Pytaj” pokazuje ich listę przy starcie."
        >
          <Segmented
            value={sessionRestoreMode}
            options={SESSION_RESTORE_OPTIONS}
            onChange={setSessionRestoreMode}
            labelledBy="settings-general-restore"
          />
        </SettingsRow>
        <SettingsRow
          label="Domyślny widok historii"
          labelId="settings-general-history"
          description="„Komunikacja” pokazuje tylko wiadomości użytkownika i asystenta. „Pełny” zawiera też narzędzia, hooki i zdarzenia systemowe."
        >
          <Segmented
            value={historyViewMode}
            options={HISTORY_VIEW_OPTIONS}
            onChange={setHistoryViewMode}
            labelledBy="settings-general-history"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label="Narzędzia systemowe">
        <SettingsRow
          label="Domyślny shell"
          htmlFor="settings-general-shell"
          description={
            <>
              Dotyczy tylko interaktywnych terminali (tab Shell).
              {detectedName ? <> Wykryto: <code className="font-mono text-fg-secondary">{detectedName}</code>.</> : null}
            </>
          }
        >
          <div className="flex min-w-0 flex-[0_1_280px] flex-col gap-2">
            <SelectField
              id="settings-general-shell"
              wrapperClassName="w-full"
              value={selectedShell}
              onChange={e => {
                const v = e.target.value;
                if (v === '__custom__') {
                  setCustomMode(true);
                } else {
                  setCustomMode(false);
                  setShellPath(v);
                }
              }}
            >
              <option value="">Auto (z $SHELL)</option>
              {shells.map(s => (
                <option key={s.path} value={s.name}>{s.name} ({s.path})</option>
              ))}
              <option value="__custom__">Inny…</option>
            </SelectField>
            {showCustom && (
              <input
                aria-label="Ścieżka shella"
                value={shellPath}
                onChange={e => setShellPath(e.target.value)}
                placeholder="/opt/homebrew/bin/fish"
                className={`${MONO_FIELD_CLASS} w-full`}
              />
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          label="Domyślny edytor"
          htmlFor="settings-general-editor"
          description={
            <>
              Edytor używany do otwierania projektów z panelu bocznego.
              {editors.length > 0 ? <> Wykryto: {editors.map(s => s.name).join(', ')}.</> : null}
            </>
          }
        >
          <div className="flex min-w-0 flex-[0_1_280px] flex-col gap-2">
            <SelectField
              id="settings-general-editor"
              wrapperClassName="w-full"
              value={selectedEditor}
              onChange={e => {
                const v = e.target.value;
                if (v === '__custom__') {
                  setEditorCustomMode(true);
                } else {
                  setEditorCustomMode(false);
                  setEditorPath(v);
                }
              }}
            >
              <option value="">Auto (pierwszy wykryty)</option>
              {editors.map(s => (
                <option key={s.path} value={s.name}>{s.name} ({s.path})</option>
              ))}
              <option value="__custom__">Inny…</option>
            </SelectField>
            {showEditorCustom && (
              <input
                aria-label="Ścieżka edytora"
                value={editorPath}
                onChange={e => setEditorPath(e.target.value)}
                placeholder="/usr/bin/code"
                className={`${MONO_FIELD_CLASS} w-full`}
              />
            )}
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
