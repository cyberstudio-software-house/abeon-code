import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { Icon } from '../../shared/Icon';
import {
  SHORTCUTS, FIXED_SHORTCUTS, getBinding, formatBinding, eventToBinding,
  type ShortcutId,
} from '../../../lib/shortcuts';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { BUTTON_CLASS, SettingsPage, SettingsRow, SettingsSection } from '../controls';

function ShortcutsTab() {
  const overrides = useStore(s => s.shortcutOverrides);
  const setOverride = useStore(s => s.setShortcutOverride);
  const resetAll = useStore(s => s.resetShortcutOverrides);
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const recordRef = useRef<HTMLButtonElement | null>(null);

  const hasOverrides = Object.keys(overrides).length > 0;

  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setRecordingId(null);
        setConflict(null);
        return;
      }

      const binding = eventToBinding(e);
      if (!binding) return;

      const conflicting = SHORTCUTS.find(
        s => s.id !== recordingId && getBinding(s.id, overrides) === binding,
      );
      if (conflicting) {
        setConflict(conflicting.label);
        return;
      }

      const isActionKey = /^mod\+[1-9]$/.test(binding);
      if (isActionKey) {
        setConflict('Akcja 1–9');
        return;
      }

      const def = SHORTCUTS.find(s => s.id === recordingId);
      if (def && binding === def.defaultBinding) {
        const { [recordingId]: _, ...rest } = overrides;
        useStore.setState({ shortcutOverrides: rest });
      } else {
        setOverride(recordingId, binding);
      }
      setRecordingId(null);
      setConflict(null);
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [recordingId, overrides, setOverride]);

  useEffect(() => {
    if (recordingId && recordRef.current) recordRef.current.focus();
  }, [recordingId]);

  return (
    <>
      <SettingsSection label="Skróty klawiszowe">
        {SHORTCUTS.map(s => {
          const current = getBinding(s.id, overrides);
          const isRecording = recordingId === s.id;
          const isOverridden = !!overrides[s.id];

          return (
            <SettingsRow key={s.id} label={s.label} description={s.description}>
              <div className="flex items-center gap-1.5">
                {isOverridden && !isRecording && (
                  <button
                    type="button"
                    onClick={() => {
                      const { [s.id]: _, ...rest } = overrides;
                      useStore.setState({ shortcutOverrides: rest });
                    }}
                    className="grid h-7 w-7 place-items-center rounded-[7px] text-icon transition-colors hover:text-fg"
                    title="Przywróć domyślny"
                    aria-label={`Przywróć domyślny: ${s.label}`}
                  >
                    <Icon name="close" className="h-3 w-3" strokeWidth={2.4} />
                  </button>
                )}
                <button
                  type="button"
                  ref={isRecording ? recordRef : undefined}
                  onClick={() => {
                    setRecordingId(isRecording ? null : s.id);
                    setConflict(null);
                  }}
                  className={`h-7 min-w-[110px] rounded-[7px] border px-3 text-center font-mono text-[12px] transition-colors ${
                    isRecording
                      ? 'animate-pulse border-accent bg-accent/10 text-accent'
                      : isOverridden
                        ? 'border-accent/50 bg-field text-fg hover:border-accent'
                        : 'border-border-strong bg-field text-fg-secondary hover:text-fg'
                  }`}
                >
                  {isRecording ? 'Naciśnij…' : formatBinding(current)}
                </button>
              </div>
            </SettingsRow>
          );
        })}
      </SettingsSection>

      {conflict && (
        <p className="-mt-3 px-0.5 text-[12px] text-danger">
          Konflikt ze skrótem: {conflict}. Wybierz inną kombinację.
        </p>
      )}

      <SettingsSection label="Stałe skróty">
        {FIXED_SHORTCUTS.map(s => (
          <SettingsRow key={s.label} label={s.label} description={s.description}>
            <span className="inline-flex h-7 min-w-[110px] items-center justify-center rounded-[7px] border border-border-strong px-3 font-mono text-[12px] text-muted">
              {formatBinding(s.binding)}
            </span>
          </SettingsRow>
        ))}
      </SettingsSection>

      {hasOverrides && (
        <div>
          <button type="button" onClick={resetAll} className={BUTTON_CLASS}>
            Przywróć wszystkie domyślne skróty
          </button>
        </div>
      )}
    </>
  );
}

export function ShortcutsCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.shortcuts.label} description={SETTINGS_CATEGORIES.shortcuts.description}>
      <ShortcutsTab />
    </SettingsPage>
  );
}
