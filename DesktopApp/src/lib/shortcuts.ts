const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.includes('Mac');

export type ShortcutId = 'newSession' | 'newTerminal' | 'closeTab' | 'focusSearch' | 'openProjectLauncher';

export type ShortcutDef = {
  id: ShortcutId;
  label: string;
  description: string;
  defaultBinding: string;
};

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'newSession', label: 'Nowa sesja', description: 'Otwiera nową sesję w aktywnym projekcie', defaultBinding: 'mod+n' },
  { id: 'newTerminal', label: 'Nowy terminal', description: 'Otwiera nowy terminal w aktywnym projekcie', defaultBinding: 'mod+t' },
  { id: 'closeTab', label: 'Zamknij tab', description: 'Zamyka aktywny tab (z potwierdzeniem jeśli proces)', defaultBinding: 'mod+w' },
  { id: 'focusSearch', label: 'Szukaj', description: 'Przenosi fokus do wyszukiwarki projektów', defaultBinding: 'mod+k' },
  { id: 'openProjectLauncher', label: 'Szukaj projektu', description: 'Otwiera szybką wyszukiwarkę projektów (nowa sesja / terminal)', defaultBinding: 'mod+shift+n' },
];

export const FIXED_SHORTCUTS = [
  { label: 'Akcja 1–9', description: 'Uruchamia akcję o podanym numerze', binding: 'mod+1…9' },
  { label: 'Przełącz zakładki', description: 'Cyklicznie po ostatnio używanych (Shift = wstecz)', binding: 'ctrl+tab' },
  { label: 'Nawigacja zakładek', description: 'Przyciski myszy wstecz/następny — po historii oglądania', binding: 'mousenav' },
];

export function getBinding(id: ShortcutId, overrides: Record<string, string>): string {
  return overrides[id] || SHORTCUTS.find(s => s.id === id)!.defaultBinding;
}

export function matchesShortcut(
  e: KeyboardEvent,
  id: ShortcutId,
  overrides: Record<string, string>,
): boolean {
  return matchesBinding(e, getBinding(id, overrides));
}

export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.toLowerCase().split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);

  const hasMod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (mods.has('mod') !== hasMod) return false;
  if (mods.has('shift') !== e.shiftKey) return false;
  if (mods.has('alt') !== e.altKey) return false;
  if (IS_MAC && e.ctrlKey) return false;
  if (!IS_MAC && e.metaKey) return false;

  return e.key.toLowerCase() === key;
}

export function eventToBinding(e: KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return null;

  const parts: string[] = [];
  const hasMod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (hasMod) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  if (parts.length === 0) return null;

  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

export function formatBinding(binding: string): string {
  const parts = binding.split('+');
  return parts
    .map(p => {
      if (p === 'ctrl') return IS_MAC ? '⌃' : 'Ctrl';
      if (p === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
      if (p === 'shift') return IS_MAC ? '⇧' : 'Shift';
      if (p === 'alt') return IS_MAC ? '⌥' : 'Alt';
      if (p === '1…9') return '1–9';
      if (p === 'mousenav') return 'Mysz ←/→';
      return p.toUpperCase();
    })
    .join(IS_MAC ? '' : '+');
}
