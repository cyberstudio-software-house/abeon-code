import type { IconName } from '../components/shared/Icon';

export type SettingsCategoryId =
  | 'general' | 'appearance' | 'terminal' | 'notifications' | 'shortcuts'
  | 'providers' | 'models' | 'permissions' | 'supervisor'
  | 'cloud' | 'clickup';

export type SettingsGroupId = 'app' | 'agents' | 'integrations';

export type SettingsGroup = {
  id: SettingsGroupId;
  label: string;
  categories: SettingsCategoryId[];
};

export type SettingsCategory = {
  label: string;
  description: string;
  icon: IconName;
  keywords: string[];
};

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { id: 'app', label: 'Aplikacja', categories: ['general', 'appearance', 'terminal', 'notifications', 'shortcuts'] },
  { id: 'agents', label: 'Agenci', categories: ['providers', 'models', 'permissions', 'supervisor'] },
  { id: 'integrations', label: 'Integracje', categories: ['cloud', 'clickup'] },
];

export const SETTINGS_CATEGORIES: Record<SettingsCategoryId, SettingsCategory> = {
  general: {
    label: 'Ogólne',
    description: 'Profil, projekty, sesje i narzędzia systemowe.',
    icon: 'settings',
    keywords: [
      'Nazwa wyświetlana', 'Ścieżka bazowa projektów', 'Wybierz', 'Sesje po uruchomieniu',
      'Pytaj', 'Wznawiaj automatycznie', 'Nie wznawiaj', 'Domyślny widok historii',
      'Komunikacja', 'Pełny', 'Domyślny shell', 'Domyślny edytor', 'profil', 'git',
    ],
  },
  appearance: {
    label: 'Wygląd',
    description: 'Motyw aplikacji i układ panelu bocznego.',
    icon: 'eye',
    keywords: [
      'Motyw', 'Ciemny', 'Jasny', 'Systemowy', 'Pokaż aktywne sesje nad projektami',
    ],
  },
  terminal: {
    label: 'Terminal',
    description: 'Wygląd konsoli w sesjach agentów, akcjach i terminalach shell. Zmiany widać od razu w podglądzie.',
    icon: 'terminal',
    keywords: [
      'Krój', 'Czcionka', 'Geist Mono', 'JetBrains Mono', 'IBM Plex Mono', 'Systemowa monospace',
      'Rozmiar', 'Interlinia', 'Paleta ANSI', 'Grafit', 'Wysoki kontrast', 'Obecna', 'Własna',
      'Kształt kursora', 'Blok', 'Belka', 'Podkreślenie', 'Miganie', 'Podgląd', 'Przywróć domyślne',
    ],
  },
  notifications: {
    label: 'Powiadomienia',
    description: 'Kiedy aplikacja ma powiadamiać o zakończonej turze lub pytaniu agenta.',
    icon: 'bell',
    keywords: [
      'Powiadomienia pulpitu', 'Wyzwalaj na', 'Każde zakończenie tury',
      'Tylko pytania / prośby o uprawnienie', 'Oba', 'Hook pytań Claude Code', 'Zainstaluj hook',
    ],
  },
  shortcuts: {
    label: 'Skróty klawiszowe',
    description: 'Przypisania klawiszy do poleceń aplikacji.',
    icon: 'code',
    keywords: [
      'Skróty', 'Klawisze', 'Przywróć domyślny', 'Przywróć wszystkie', 'Przypisanie',
    ],
  },
  providers: {
    label: 'Dostawcy CLI',
    description: 'Włączone narzędzia CLI, generowanie tytułów oraz integracja z terminalem.',
    icon: 'claudeLogo',
    keywords: [
      'Claude Code', 'Codex', 'OpenCode', 'Dostawcy', 'Generowanie tytułów', 'Haiku',
      'Komenda terminala', 'abeon-code', 'PATH', 'Skill dla Claude Code',
    ],
  },
  models: {
    label: 'Modele',
    description: 'Domyślne modele, poziom effort i własne modele dla każdego dostawcy.',
    icon: 'sparkles',
    keywords: [
      'Model domyślny', 'Domyślny model', 'Effort', 'Zaawansowane', 'Własny model',
      'Nazwa', 'ID modelu (CLI)', 'Wykryty', 'Auto', 'Dodaj model', 'Usuń model',
    ],
  },
  permissions: {
    label: 'Uprawnienia',
    description: 'Sposób obsługi pytań o uprawnienia zadawanych przez agentów.',
    icon: 'lock',
    keywords: [
      'Pomijaj pytania o uprawnienia', 'bypass', 'skip permissions', 'dangerously',
    ],
  },
  supervisor: {
    label: 'Agent sterujący',
    description: 'Automatyczne odpowiadanie na pytania agentów, rozmowa przez Discord i reguły produkcyjne.',
    icon: 'msgSquare',
    keywords: [
      'Poziom', 'Wyłączony', 'Przekaźnik', 'Asystent', 'Autonomiczny', 'Karencja (s)',
      'Próg obecności (min)', 'Model', 'Operacje produkcyjne', 'Dodatkowe reguły',
      'Discord', 'Rozmowa przez Discord', 'Token bota', 'Kod parowania',
      'Wyciszaj Discord, gdy jestem przy komputerze', 'Konfiguracja bota',
    ],
  },
  cloud: {
    label: 'AbeonCloud',
    description: 'Zdalne sterowanie sesjami z aplikacji mobilnej przez AbeonCloud.',
    icon: 'layers',
    keywords: [
      'Włącz zdalny most', 'Zezwól na zdalne wznawianie sesji', 'Adres usługi', 'URL usługi',
      'Parowanie', 'Urządzenia', 'Aplikacja mobilna', 'Centrifugo',
    ],
  },
  clickup: {
    label: 'ClickUp',
    description: 'Połączenie z ClickUp: token API i test połączenia.',
    icon: 'chart',
    keywords: [
      'Token', 'Token API', 'Zapisz token', 'Testuj połączenie', 'Usuń token', 'Zadania', 'API',
    ],
  },
};

const TERMINAL_SEEN_KEY = 'abeoncode.settings.terminalSeen';

export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l');
}

export function filterSettingsCategories(query: string): SettingsCategoryId[] {
  const needle = normalizeSearch(query).trim();
  const ordered = SETTINGS_GROUPS.flatMap(group => group.categories);
  if (needle === '') return ordered;
  return ordered.filter(id => {
    const category = SETTINGS_CATEGORIES[id];
    return [category.label, ...category.keywords].some(text => normalizeSearch(text).includes(needle));
  });
}

export function isTerminalCategorySeen(): boolean {
  try {
    return localStorage.getItem(TERMINAL_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTerminalCategorySeen(): void {
  try {
    localStorage.setItem(TERMINAL_SEEN_KEY, '1');
  } catch {
    return;
  }
}
