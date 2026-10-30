import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { Icon } from '../../shared/Icon';
import {
  SHORTCUTS, FIXED_SHORTCUTS, getBinding, formatBinding, eventToBinding,
  type ShortcutId,
} from '../../../lib/shortcuts';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { SettingsPage } from '../controls';

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
    <div>
      <label className="block text-[10px] text-muted uppercase tracking-wider mb-3">
        Skróty klawiszowe
      </label>

      <div className="space-y-0.5">
        {SHORTCUTS.map(s => {
          const current = getBinding(s.id, overrides);
          const isRecording = recordingId === s.id;
          const isOverridden = !!overrides[s.id];

          return (
            <div
              key={s.id}
              className="flex items-center gap-3 py-2 px-2 hover:bg-bg-elev-2"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px]">{s.label}</div>
                <div className="text-[11px] text-muted">{s.description}</div>
              </div>
              <button
                ref={isRecording ? recordRef : undefined}
                onClick={() => {
                  setRecordingId(isRecording ? null : s.id);
                  setConflict(null);
                }}
                className={`font-mono text-[12px] px-3 py-1 border min-w-[100px] text-center transition-colors ${
                  isRecording
                    ? 'border-accent bg-accent/10 text-accent animate-pulse'
                    : isOverridden
                      ? 'border-accent/50 text-fg hover:border-accent'
                      : 'border-border text-fg-secondary hover:border-fg-secondary'
                }`}
              >
                {isRecording ? 'Naciśnij…' : formatBinding(current)}
              </button>
              {isOverridden && !isRecording && (
                <button
                  onClick={() => {
                    const { [s.id]: _, ...rest } = overrides;
                    useStore.setState({ shortcutOverrides: rest });
                  }}
                  className="text-muted hover:text-fg transition-colors p-1"
                  title="Przywróć domyślny"
                >
                  <Icon name="close" className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {conflict && (
        <p className="text-[11px] text-danger mt-2 px-2">
          Konflikt ze skrótem: {conflict}. Wybierz inną kombinację.
        </p>
      )}

      <div className="border-t border-border mt-4 pt-4">
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-3">
          Stałe skróty
        </label>
        <div className="space-y-0.5">
          {FIXED_SHORTCUTS.map(s => (
            <div key={s.label} className="flex items-center gap-3 py-2 px-2">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-fg-secondary">{s.label}</div>
                <div className="text-[11px] text-muted">{s.description}</div>
              </div>
              <span className="font-mono text-[12px] px-3 py-1 border border-border text-muted min-w-[100px] text-center">
                {formatBinding(s.binding)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {hasOverrides && (
        <div className="mt-4 pt-3 border-t border-border">
          <button
            onClick={resetAll}
            className="text-[12px] text-muted hover:text-danger transition-colors"
          >
            Przywróć wszystkie domyślne skróty
          </button>
        </div>
      )}
    </div>
  );
}

export function ShortcutsCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.shortcuts.label} description={SETTINGS_CATEGORIES.shortcuts.description}>
      <ShortcutsTab />
    </SettingsPage>
  );
}
