import type { IconName } from '../components/shared/Icon';
import { ALL_PROVIDERS, PROVIDER_LABEL } from './providers';
import { FIXED_SHORTCUTS, SHORTCUTS } from './shortcuts';

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
    icon: 'sliders',
    keywords: [
      'Profil i projekty', 'Nazwa wyświetlana',
      'Wyświetlana w stopce panelu bocznego. Puste pole oznacza użycie nazwy z Git.',
      'Ścieżka bazowa projektów', 'Wybierz',
      'Od tego katalogu zaczyna się wybór folderu przy dodawaniu nowego projektu.',
      'Sesje po uruchomieniu', 'Pytaj', 'Wznawiaj automatycznie', 'Nie wznawiaj',
      'Dotyczy sesji, które działały w chwili zamknięcia programu. „Pytaj” pokazuje ich listę przy starcie.',
      'Domyślny widok historii', 'Komunikacja', 'Pełny',
      '„Komunikacja” pokazuje tylko wiadomości użytkownika i asystenta. „Pełny” zawiera też narzędzia, hooki i zdarzenia systemowe.',
      'Narzędzia systemowe', 'Domyślny shell', 'Auto (z $SHELL)',
      'Dotyczy tylko interaktywnych terminali (tab Shell).',
      'Domyślny edytor', 'Auto (pierwszy wykryty)',
      'Edytor używany do otwierania projektów z panelu bocznego.',
    ],
  },
  appearance: {
    label: 'Wygląd',
    description: 'Motyw aplikacji i układ paska bocznego.',
    icon: 'contrast',
    keywords: [
      'Motyw', 'Ciemny', 'Jasny', 'Systemowy',
      'Opcja „Systemowy” automatycznie dostosowuje motyw do ustawień systemu operacyjnego.',
      'Pasek boczny', 'Pokaż aktywne sesje nad projektami',
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
      'Czcionka monospace dla wszystkich terminali.', 'W pikselach, od 10 do 20.',
      'Większa poprawia czytelność długich odpowiedzi agenta.', 'Kształt',
      '16 kolorów terminala. Zmienia też kolory paska statusu Claude Code, jeśli Twój skrypt statusline używa kolorów ANSI.',
      'xterm.js', 'JSON',
    ],
  },
  notifications: {
    label: 'Powiadomienia',
    description: 'Powiadomienia systemowe o zakończonej turze lub pytaniu agenta oraz hook pytań Claude Code.',
    icon: 'bell',
    keywords: [
      'Powiadomienia systemowe, gdy sesja czeka na Ciebie', 'Wyzwalaj na', 'Każde zakończenie tury',
      'Tylko pytania / prośby o uprawnienie', 'Oba', 'Hook Claude Code', 'Hook pytań Claude Code',
      'Tryb „tylko pytania” wymaga hooka. Instalacja dopisuje wpis do ~/.claude/settings.json (Twoje istniejące hooki zostają nienaruszone).',
      'Zainstaluj', 'zainstalowany',
    ],
  },
  shortcuts: {
    label: 'Skróty klawiszowe',
    description: 'Przypisania klawiszy do poleceń aplikacji.',
    icon: 'keyboard',
    keywords: [
      'Stałe skróty', 'Przywróć domyślny', 'Przywróć wszystkie domyślne skróty',
      ...SHORTCUTS.flatMap(shortcut => [shortcut.label, shortcut.description]),
      ...FIXED_SHORTCUTS.flatMap(shortcut => [shortcut.label, shortcut.description]),
    ],
  },
  providers: {
    label: 'Dostawcy CLI',
    description: 'Włączone narzędzia CLI, model do generowania tytułów, komenda terminala i skill dla Claude Code.',
    icon: 'layers',
    keywords: [
      'Dostawcy CLI', ...ALL_PROVIDERS.map(provider => PROVIDER_LABEL[provider]),
      'nie znaleziono w PATH',
      'Gdy włączony jest więcej niż jeden dostawca, „New session” najpierw pyta, w którym CLI uruchomić sesję.',
      'Model do generowania tytułów', 'Haiku (najnowszy)',
      'Używany przy ręcznym wywołaniu „Generuj tytuł sesji” (ikona ✨ w nagłówku sesji). Zwykle wystarczy najszybszy/najtańszy model.',
      'Terminal i skill', 'Komenda terminala', 'Zainstaluj komendę',
      'Instaluje komendę abeon-code w ~/.local/bin. Użyj abeon-code ., aby otworzyć projekt i nową sesję z konsoli. Upewnij się, że ten katalog jest w PATH.',
      'Skill dla Claude Code', 'Zainstaluj skill',
      'Instaluje skille abeon-open-session i abeon-notes w ~/.claude/skills. Pozwalają agentowi uruchomić w tle nową sesję w innym projekcie z gotowym promptem („odpal sesję w ~/projects/x i dodaj endpoint…”) oraz dodawać i czytać notatki projektu („dodaj notatkę z informacją o…”, „przeczytaj notatki”). Instaluje też (aktualizuje) komendę abeon-code w ~/.local/bin, która musi być dostępna w PATH.',
      'notatki', 'abeon-notes',
    ],
  },
  models: {
    label: 'Modele',
    description: 'Domyślne i własne modele każdego dostawcy oraz poziom effort modeli Claude.',
    icon: 'cube',
    keywords: [
      ...ALL_PROVIDERS.map(provider => PROVIDER_LABEL[provider]),
      'Model używany przy tworzeniu nowych sesji. Istniejące sesje zachowują swój model. Lista pochodzi z zainstalowanego Claude Code.',
      'Model używany przy tworzeniu nowych sesji Codex. „Auto” pozostawia wybór konfiguracji Codexa.',
      'Model używany przy tworzeniu nowych sesji OpenCode. „Auto” pozostawia wybór konfiguracji OpenCode.',
      'Auto (domyślny model Claude)', 'Auto (konfiguracja Codexa)', 'Auto (konfiguracja OpenCode)',
      'Effort', 'Domyślny', 'Niski', 'Średni', 'Wysoki', 'Bardzo wysoki', 'Maksymalny',
      'Odśwież', 'Pokaż starsze wersje', 'niewykryty', 'wykryty',
      'Zaawansowane', 'Modele własne — gdy wykrywanie nie znajduje potrzebnego ID (np. Bedrock/Vertex).',
      'Dodaj własny model', 'Nazwa', 'ID modelu (CLI)', 'Usuń model',
    ],
  },
  permissions: {
    label: 'Uprawnienia',
    description: 'Sposób obsługi pytań o uprawnienia zadawanych przez agentów.',
    icon: 'shield',
    keywords: [
      'Pomijaj pytania o uprawnienia', 'bypass',
      'Dodaje flagę --dangerously-skip-permissions do każdej sesji Claude. Claude będzie mógł wykonywać operacje bez pytania o zgodę.',
    ],
  },
  supervisor: {
    label: 'Agent sterujący',
    description: 'Odpowiadanie na pytania sesji, operacje produkcyjne wymagające zgody i rozmowa przez Discord.',
    icon: 'crosshair',
    keywords: [
      'Poziom', 'Wyłączony', 'Przekaźnik', 'Asystent (zalecany)', 'Samodzielny',
      'Agent sterujący nie działa, a pytania sesji trafiają do Ciebie jak dotychczas.',
      'Agent sam niczego nie rozstrzyga: każde pytanie sesji przekazuje Tobie (po karencji, gdy jesteś przy komputerze). Przekazuje Twoje odpowiedzi, robi podsumowania i wykonuje polecenia na Twoją prośbę.',
      'Agent odpowiada na pytania sesji w zakresie zadania: po karencji, gdy jesteś przy komputerze, od razu, gdy Cię nie ma. Sprawy zastrzeżone dla Ciebie i te, których nie jest pewien, przekazuje Tobie. Nowe sesje otwiera tylko na Twoją prośbę.',
      'Jak Asystent, a do tego może sam otwierać nowe sesje agentów i mówi Ci, co uruchomił.',
      'Sesje uruchomione, gdy agent był wyłączony, nie są nadzorowane, dopóki ich nie uruchomisz ponownie.',
      'Karencja (s)', 'Tyle czasu masz na własną odpowiedź na pytanie sesji, zanim zajmie się nim agent.',
      'Próg obecności (min)', 'Po tylu minutach bez aktywności uznajemy, że nie ma Cię przy komputerze.',
      'Model',
      'Operacje produkcyjne', 'Poniższe operacje zawsze wymagają Twojej zgody, niezależnie od poziomu.',
      'Narzędzia bandzior ze wstępnym podglądem wymagają zgody dopiero przy faktycznym potwierdzeniu zmiany.',
      'Dodatkowe reguły', 'Jedna reguła w linii: bash:<regex> dla poleceń shella albo mcp:<glob> dla narzędzi MCP.',
      'Discord', 'Rozmowa przez Discord', 'Wyciszaj Discord, gdy jestem przy komputerze',
      'Konfiguracja bota', 'Jak utworzyć bota', 'Token bota', 'Zapisz token',
      'Kod parowania', 'Napisz do bota na Discordzie dowolną wiadomość — odpowie kodem parowania.',
      'Rozmowa agenta', 'Czysty kontekst', 'Nowa rozmowa agenta',
      'Zaczyna agenta od czystego kontekstu. Poprzednia rozmowa zostaje zamknięta.',
    ],
  },
  cloud: {
    label: 'AbeonCloud',
    description: 'Zdalne sterowanie sesjami z aplikacji mobilnej przez AbeonCloud.',
    icon: 'cloud',
    keywords: [
      'Zdalne sterowanie', 'Włącz zdalny most', 'Wymaga restartu aplikacji.',
      'Zezwól na zdalne wznawianie sesji', 'Adres CloudService', 'Aplikacja mobilna', 'Sparuj telefon',
    ],
  },
  clickup: {
    label: 'ClickUp',
    description: 'Połączenie z ClickUp: token API i test połączenia.',
    icon: 'checkSquare',
    keywords: [
      'Połączenie', 'Połączono', 'Brak tokenu', 'Token nieprawidłowy', 'Token API',
      'Token wygenerujesz w ClickUp: Settings → Apps → API Token.',
      'Zapisz token', 'Testuj połączenie', 'Usuń token',
    ],
  },
};

const TERMINAL_SEEN_KEY = 'abeoncode.settings.terminalSeen';

export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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
