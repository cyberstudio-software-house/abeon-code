# Zakładka Modele — uniwersalna detekcja + Auto — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uodpornić detekcję modeli Claude na dowolne nazewnictwo (w tym `claude-fable-5`), auto-promować wykryte modele na listę wyboru i dodać dla Claude opcję „Auto" (pominięcie `--model`) jako nowy domyślny dla świeżych profili.

**Architecture:** Skaner Rust (`commands/models.rs`) przestaje filtrować po whiteliście rodzin i sztywnym `major-minor` — przyjmuje rodzinę alfabetyczną + co najmniej jeden człon numeryczny. Front (`lib/models.ts`) uogólnia parser wersji, reprezentuje modele wykryte surowym aliasem jako `id` (rozwiązywanym przy spawnie tak jak Codex), a `defaultModelId === ''` znaczy „Auto" (CLI bez `--model`). UI (`SettingsDialog`) dostaje radio „Auto" i renderuje wykryte modele jako wybieralne pozycje.

**Tech Stack:** Rust (Tauri 2, cargo test), TypeScript/React 19, Zustand, Vitest.

**Pliki:**
- Modify: `DesktopApp/src-tauri/src/commands/models.rs` (skaner + testy)
- Modify: `DesktopApp/src/lib/models.ts` (parser, helpery, builtin, lista wykrytych)
- Modify: `DesktopApp/src/lib/models.test.ts` (testy frontu)
- Modify: `DesktopApp/src/components/history/HistoryHeader.tsx:43-46` (koercja typu po zmianie sygnatury)
- Modify: `DesktopApp/src/components/dialogs/SettingsDialog.tsx` (`ClaudeModelsSection` + import)

Wszystkie komendy uruchamiać z katalogu `DesktopApp/`.

---

## Task 1: Uniwersalny skaner modeli (Rust)

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/models.rs:8` (usunięcie `FAMILIES`), `:40-76` (`normalize_alias`, `build_models`), `:184-201` (testy)

- [ ] **Step 1: Zaktualizuj testy jednostkowe na nowe zachowanie**

W `src-tauri/src/commands/models.rs` zamień bloki testów `normalizes_clean_alias`, `strips_date_and_v1_suffixes`, `rejects_base_aliases_and_zero_minor_and_non_family` oraz `build_adds_1m_variant_for_opus_only_and_dedupes` na poniższe (family jest teraz `String`, single-major jest akceptowany, nowa rodzina przechodzi):

```rust
    #[test]
    fn normalizes_clean_alias() {
        assert_eq!(
            normalize_alias("claude-opus-4-8"),
            Some(("claude-opus-4-8".to_string(), "opus".to_string()))
        );
    }

    #[test]
    fn accepts_single_major_and_unknown_family() {
        assert_eq!(
            normalize_alias("claude-fable-5"),
            Some(("claude-fable-5".to_string(), "fable".to_string()))
        );
        assert_eq!(
            normalize_alias("claude-newfamily-7"),
            Some(("claude-newfamily-7".to_string(), "newfamily".to_string()))
        );
    }

    #[test]
    fn strips_date_and_v1_suffixes() {
        assert_eq!(
            normalize_alias("claude-haiku-4-5-20251001"),
            Some(("claude-haiku-4-5".to_string(), "haiku".to_string()))
        );
        assert_eq!(
            normalize_alias("claude-opus-4-6-v1"),
            Some(("claude-opus-4-6".to_string(), "opus".to_string()))
        );
        assert_eq!(
            normalize_alias("claude-opus-4-6-fast"),
            Some(("claude-opus-4-6".to_string(), "opus".to_string()))
        );
    }

    #[test]
    fn rejects_zero_minor_numeric_family_and_no_version() {
        assert_eq!(normalize_alias("claude-opus-4-0"), None);
        assert_eq!(normalize_alias("claude-3-5-sonnet"), None);
        assert_eq!(normalize_alias("claude-code"), None);
        assert_eq!(normalize_alias("claude-cli"), None);
    }

    #[test]
    fn build_adds_1m_variant_for_opus_only_and_dedupes() {
        let toks = vec![
            "claude-opus-4-9".to_string(),
            "claude-opus-4-9-20260101".to_string(),
            "claude-fable-5".to_string(),
        ];
        let models = build_models(toks, "binary");
        let ids: Vec<&str> = models.iter().map(|m| m.model_id.as_str()).collect();
        assert!(ids.contains(&"claude-opus-4-9"));
        assert!(ids.contains(&"claude-opus-4-9[1m]"));
        assert!(ids.contains(&"claude-fable-5"));
        assert!(!ids.contains(&"claude-fable-5[1m]"));
        assert_eq!(ids.iter().filter(|i| **i == "claude-opus-4-9").count(), 1);
        assert!(models.iter().all(|m| m.source == "binary"));
    }
```

- [ ] **Step 2: Uruchom testy i potwierdź, że nowe przypadki nie przechodzą (kompilacja lub asercje)**

Run: `npm run test:rust -- models`
Expected: FAIL — `accepts_single_major_and_unknown_family` / `build_adds_1m_variant...` nie przechodzą (stary `normalize_alias` zwraca `&'static str` w krotce i odrzuca `claude-fable-5`).

- [ ] **Step 3: Usuń whitelistę rodzin**

Usuń linię 8:

```rust
const FAMILIES: [&str; 3] = ["opus", "sonnet", "haiku"];
```

(Zostaw `const MAX_FALLBACK_FILES: usize = 50;`.)

- [ ] **Step 4: Przepisz `normalize_alias` na wariant family-agnostyczny**

Zamień całą funkcję `normalize_alias` (linie ~37-51) na:

```rust
/// Reduce a raw token to its clean `claude-family-major[-minor]` alias.
/// Accepts any alphabetic family plus at least one numeric version segment;
/// drops date / `-v1` / `-fast` suffixes; rejects an explicit `.0` minor
/// (base alias) and tokens without a numeric version. Returns `(clean_id, family)`.
fn normalize_alias(token: &str) -> Option<(String, String)> {
    let rest = token.strip_prefix("claude-")?;
    let mut parts = rest.split('-');
    let family = parts.next()?;
    if family.is_empty() || !family.chars().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: Option<u32> = parts.next().and_then(|s| s.parse::<u32>().ok());
    if minor == Some(0) {
        return None;
    }
    let clean = match minor {
        Some(m) => format!("claude-{family}-{major}-{m}"),
        None => format!("claude-{family}-{major}"),
    };
    Some((clean, family.to_string()))
}
```

- [ ] **Step 5: Dostosuj `build_models` do `family: String` i syntezy `[1m]` tylko dla opus**

Zamień ciało pętli w `build_models` (linie ~58-74) na:

```rust
    for tok in tokens {
        let Some((clean, family)) = normalize_alias(&tok) else { continue; };
        let mut variants = vec![clean.clone()];
        if family == "opus" {
            variants.push(format!("{clean}[1m]"));
        }
        for v in variants {
            if seen.insert(v.clone()) {
                out.push(DetectedModel {
                    model_id: v,
                    family: family.clone(),
                    source: source.to_string(),
                });
            }
        }
    }
```

- [ ] **Step 6: Uruchom testy i potwierdź, że przechodzą**

Run: `npm run test:rust -- models`
Expected: PASS (wszystkie testy w `commands::models`).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/models.rs
git commit -m "feat(desktop): make Claude model scanner family-agnostic"
```

---

## Task 2: Parser, helpery i lista modeli (TypeScript)

**Files:**
- Modify: `DesktopApp/src/lib/models.ts`
- Modify: `DesktopApp/src/lib/models.test.ts`
- Modify: `DesktopApp/src/components/history/HistoryHeader.tsx:43-46`

- [ ] **Step 1: Przepisz testy frontu na docelowe API**

Zamień całą zawartość `src/lib/models.test.ts` na:

```ts
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_MODELS,
  DEFAULT_MODEL_ID,
  getCliModelString,
  getModelDisplayLabel,
  detectedClaudeModels,
} from './models';
import type { DetectedModel } from '../types';

describe('builtin list', () => {
  it('exposes Opus 4.8 200k and 1M variants', () => {
    const ids = BUILTIN_MODELS.map(m => m.modelId);
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-opus-4-8[1m]');
  });

  it('includes Fable 5', () => {
    expect(BUILTIN_MODELS.map(m => m.modelId)).toContain('claude-fable-5');
  });

  it('defaults to Auto', () => {
    expect(DEFAULT_MODEL_ID).toBe('');
  });
});

describe('getCliModelString', () => {
  it('returns null for Auto', () => {
    expect(getCliModelString('', [])).toBeNull();
  });

  it('resolves a builtin id to its CLI alias', () => {
    expect(getCliModelString('opus-4.8-1m', [])).toBe('claude-opus-4-8[1m]');
  });

  it('passes a raw detected alias through', () => {
    expect(getCliModelString('claude-opus-4-9', [])).toBe('claude-opus-4-9');
  });

  it('falls back to sonnet for an unknown non-alias id', () => {
    expect(getCliModelString('garbage', [])).toBe('claude-sonnet-4-6');
  });
});

describe('getModelDisplayLabel', () => {
  it('labels Auto', () => {
    expect(getModelDisplayLabel('', [])).toBe('Auto');
  });

  it('formats a builtin label with context', () => {
    expect(getModelDisplayLabel('opus-4.8-200k', [])).toBe('Opus 4.8 (200k)');
    expect(getModelDisplayLabel('opus-4.8-1m', [])).toBe('Opus 4.8 (1M)');
  });

  it('labels a raw detected alias', () => {
    expect(getModelDisplayLabel('claude-fable-5', [])).toBe('Fable 5');
  });
});

const d = (modelId: string, family: string): DetectedModel => ({ modelId, family, source: 'binary' });

describe('detectedClaudeModels', () => {
  it('drops models already in the static list', () => {
    expect(detectedClaudeModels([d('claude-opus-4-8', 'opus')], [])).toEqual([]);
  });

  it('drops models older than the newest known in their family', () => {
    expect(detectedClaudeModels([d('claude-opus-4-5', 'opus')], [])).toEqual([]);
  });

  it('surfaces a newer opus with a 1M label', () => {
    const out = detectedClaudeModels(
      [d('claude-opus-4-9', 'opus'), d('claude-opus-4-9[1m]', 'opus')],
      [],
    );
    expect(out).toEqual([
      { modelId: 'claude-opus-4-9', label: 'Claude Opus 4.9' },
      { modelId: 'claude-opus-4-9[1m]', label: 'Claude Opus 4.9 (1M)' },
    ]);
  });

  it('surfaces an unknown family (single-major) as a suggestion', () => {
    expect(detectedClaudeModels([d('claude-newfamily-7', 'newfamily')], [])).toEqual([
      { modelId: 'claude-newfamily-7', label: 'Claude Newfamily 7' },
    ]);
  });

  it('drops models already present as custom models', () => {
    const custom = [{ id: 'custom-1', modelId: 'claude-opus-4-9', label: 'x' }];
    expect(detectedClaudeModels([d('claude-opus-4-9', 'opus')], custom)).toEqual([]);
  });
});
```

- [ ] **Step 2: Uruchom testy i potwierdź, że nie przechodzą**

Run: `npm test -- models`
Expected: FAIL — m.in. brak eksportu `detectedClaudeModels` / `DEFAULT_MODEL_ID !== ''` / brak Fable.

- [ ] **Step 3: Dodaj Fable 5 do `BUILTIN_MODELS` i ustaw domyślną na Auto**

W `src/lib/models.ts` zamień tablicę `BUILTIN_MODELS` (linie 19-28) tak, by zaczynała się od Fable, oraz zmień `DEFAULT_MODEL_ID` (linia 30):

```ts
export const BUILTIN_MODELS: BuiltinModel[] = [
  { id: 'fable-5', modelId: 'claude-fable-5', label: 'Claude Fable 5', supportsEffort: false },
  { id: 'opus-4.8-200k', modelId: 'claude-opus-4-8', label: 'Claude Opus 4.8', context: '200k', supportsEffort: true },
  { id: 'opus-4.8-1m', modelId: 'claude-opus-4-8[1m]', label: 'Claude Opus 4.8', context: '1M', supportsEffort: true },
  { id: 'opus-4.7-200k', modelId: 'claude-opus-4-7', label: 'Claude Opus 4.7', context: '200k', supportsEffort: true },
  { id: 'opus-4.7-1m', modelId: 'claude-opus-4-7[1m]', label: 'Claude Opus 4.7', context: '1M', supportsEffort: true },
  { id: 'opus-4.6-200k', modelId: 'claude-opus-4-6', label: 'Claude Opus 4.6', context: '200k', supportsEffort: true },
  { id: 'opus-4.6-1m', modelId: 'claude-opus-4-6[1m]', label: 'Claude Opus 4.6', context: '1M', supportsEffort: true },
  { id: 'sonnet-4.6', modelId: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', supportsEffort: false },
  { id: 'haiku-4.5', modelId: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', supportsEffort: false },
];

export const DEFAULT_MODEL_ID = '';
```

- [ ] **Step 4: Zmień `getCliModelString` (Auto → null, surowy alias → przepuść)**

Zamień funkcję `getCliModelString` (linie 32-41) na:

```ts
export function getCliModelString(
  defaultModelId: string,
  customModels: CustomModel[],
): string | null {
  if (defaultModelId === '') return null;
  const builtin = BUILTIN_MODELS.find(m => m.id === defaultModelId);
  if (builtin) return builtin.modelId;
  const custom = customModels.find(m => m.id === defaultModelId);
  if (custom) return custom.modelId;
  if (defaultModelId.startsWith('claude-')) return defaultModelId;
  return 'claude-sonnet-4-6';
}
```

- [ ] **Step 5: Zmień `getModelDisplayLabel` (Auto + surowy alias)**

Zamień funkcję `getModelDisplayLabel` (linie 43-54) na:

```ts
export function getModelDisplayLabel(
  modelId: string,
  customModels: CustomModel[],
): string {
  if (modelId === '') return 'Auto';
  const builtin = BUILTIN_MODELS.find(m => m.id === modelId);
  if (builtin) {
    const name = builtin.label.replace('Claude ', '');
    return builtin.context ? `${name} (${builtin.context})` : name;
  }
  const custom = customModels.find(m => m.id === modelId);
  if (custom) return custom.label;
  if (modelId.startsWith('claude-')) return claudeAliasLabel(modelId).replace('Claude ', '');
  return modelId;
}
```

- [ ] **Step 6: Uogólnij parser wersji i etykietowanie aliasów, zastąp `detectUnknownModels`**

Zamień cały blok od `export type DetectedSuggestion` do końca pliku (linie 56-104) na:

```ts
export type DetectedSuggestion = { modelId: string; label: string };

type Version = { family: string; major: number; minor: number };

function parseVersion(modelId: string): Version | null {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(modelId);
  if (!m) return null;
  return { family: m[1], major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 };
}

function isNewer(a: Version, b: Version): boolean {
  return a.major > b.major || (a.major === b.major && a.minor > b.minor);
}

function suggestionLabel(modelId: string, v: Version): string {
  const fam = v.family.charAt(0).toUpperCase() + v.family.slice(1);
  const ver = v.minor > 0 ? `${v.major}.${v.minor}` : `${v.major}`;
  const ctx = modelId.includes('[1m]') ? ' (1M)' : '';
  return `Claude ${fam} ${ver}${ctx}`;
}

export function claudeAliasLabel(modelId: string): string {
  const v = parseVersion(modelId);
  return v ? suggestionLabel(modelId, v) : modelId;
}

export function detectedClaudeModels(
  detected: DetectedModel[],
  customModels: CustomModel[],
): DetectedSuggestion[] {
  const known = new Set<string>([
    ...BUILTIN_MODELS.map(m => m.modelId),
    ...customModels.map(m => m.modelId),
  ]);

  const newest: Record<string, Version> = {};
  for (const m of BUILTIN_MODELS) {
    const v = parseVersion(m.modelId);
    if (!v) continue;
    if (!newest[v.family] || isNewer(v, newest[v.family])) newest[v.family] = v;
  }

  const out: DetectedSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of detected) {
    if (known.has(item.modelId) || seen.has(item.modelId)) continue;
    const v = parseVersion(item.modelId);
    if (!v) continue;
    const ref = newest[v.family];
    if (ref && !isNewer(v, ref)) continue;
    seen.add(item.modelId);
    out.push({ modelId: item.modelId, label: claudeAliasLabel(item.modelId) });
  }
  return out;
}
```

- [ ] **Step 7: Napraw typ w `HistoryHeader.tsx` po zmianie sygnatury**

W `src/components/history/HistoryHeader.tsx` zamień wyrażenie (linie 43-45) na koercję `null → undefined`, bo `generateSessionTitle` przyjmuje `string | undefined`:

```tsx
      const modelCli = provider === 'codex'
        ? (codexTitleGenModelId || undefined)
        : (getCliModelString(titleGenModelId, customModels) ?? undefined);
```

- [ ] **Step 8: Uruchom testy frontu i lint**

Run: `npm test -- models && npm run lint`
Expected: PASS (testy `models`), 0 błędów `tsc`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/models.ts src/lib/models.test.ts src/components/history/HistoryHeader.tsx
git commit -m "feat(desktop): generalize Claude model parsing and add Auto sentinel"
```

---

## Task 3: UI — opcja Auto i auto-promocja wykrytych (SettingsDialog)

**Files:**
- Modify: `DesktopApp/src/components/dialogs/SettingsDialog.tsx:7` (import), `:627-805` (`ClaudeModelsSection`)

- [ ] **Step 1: Zaktualizuj import z `lib/models`**

W `src/components/dialogs/SettingsDialog.tsx` zamień linię 7 na:

```tsx
import { BUILTIN_MODELS, detectedClaudeModels, getModelDisplayLabel, type EffortLevel, type DetectedSuggestion } from '../../lib/models';
```

- [ ] **Step 2: Podmień stan i logikę wykrytych w `ClaudeModelsSection`**

Zamień blok od `const [detected, setDetected]` do `submitCustom` włącznie (linie 640-664) na poniższe. Usuwa `suggestions`/`promoteSuggestion`, dodaje wybieralne wiersze wykrytych oraz wiersz dla zaznaczonego-ale-niewykrytego aliasu (przeżywa restart):

```tsx
  const [detected, setDetected] = useState<DetectedModel[]>([]);
  const refreshDetected = useCallback((force?: boolean) => {
    tauri.detectModels(force).then(setDetected).catch(() => setDetected([]));
  }, []);
  useEffect(() => { refreshDetected(); }, [refreshDetected]);

  const detectedRows = useMemo<DetectedSuggestion[]>(() => {
    const rows = detectedClaudeModels(detected, customModels);
    const isRawSelected =
      defaultModelId.startsWith('claude-') &&
      !customModels.some(m => m.id === defaultModelId) &&
      !rows.some(r => r.modelId === defaultModelId);
    return isRawSelected
      ? [...rows, { modelId: defaultModelId, label: getModelDisplayLabel(defaultModelId, customModels) }]
      : rows;
  }, [detected, customModels, defaultModelId]);

  const submitCustom = () => {
    const label = newLabel.trim();
    const modelId = newModelId.trim();
    if (!label || !modelId) return;
    const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
    addCustomModel({ id, modelId, label });
    setNewLabel('');
    setNewModelId('');
    setAdding(false);
  };
```

- [ ] **Step 3: Dodaj radio „Auto" na początku listy wbudowanych**

W zwracanym JSX, wewnątrz `<div className="space-y-0.5 mb-4">` (linia 676), dodaj wiersz Auto bezpośrednio przed `{BUILTIN_MODELS.map(...)}`:

```tsx
      <div className="space-y-0.5 mb-4">
        <ModelRow
          label="Auto (domyślny model Claude)"
          selected={defaultModelId === ''}
          onSelect={() => setDefaultModel('')}
        />
        {BUILTIN_MODELS.map(m => (
          <ModelRow
            key={m.id}
            label={m.label}
            context={m.context}
            selected={defaultModelId === m.id}
            effort={m.supportsEffort ? (modelEfforts[m.id] ?? 'medium') : undefined}
            onSelect={() => setDefaultModel(m.id)}
            onEffortChange={m.supportsEffort ? (e) => setModelEffort(m.id, e) : undefined}
          />
        ))}
      </div>
```

- [ ] **Step 4: Zamień blok sugestii (Add-flow) na wybieralne radio wykrytych**

Zamień cały blok `{suggestions.length > 0 && ( ... )}` (linie 724-758) na poniższy (wybór ustawia surowy alias jako `defaultModelId`, znacznik „wykryty", przycisk „Odśwież" zachowany):

```tsx
      {detectedRows.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-[10px] text-muted uppercase tracking-wider">
              Wykryte modele
            </label>
            <button
              onClick={() => refreshDetected(true)}
              className="text-[11px] text-muted hover:text-fg transition-colors"
            >
              Odśwież
            </button>
          </div>
          <p className="text-[11px] text-muted mb-2">
            Modele wykryte w Claude Code, których nie ma na liście wbudowanej.
          </p>
          <div className="space-y-0.5 mb-4">
            {detectedRows.map(s => (
              <label
                key={s.modelId}
                className={`flex items-center gap-3 py-1.5 px-2 cursor-pointer ${defaultModelId === s.modelId ? 'bg-bg-elev-2' : 'hover:bg-bg-elev-2'}`}
              >
                <input
                  type="radio"
                  name="default-model"
                  checked={defaultModelId === s.modelId}
                  onChange={() => setDefaultModel(s.modelId)}
                  className="accent-accent"
                />
                <span className="text-[13px]">{s.label}</span>
                <span className="text-[11px] text-muted font-mono">{s.modelId}</span>
                <span className="text-[10px] text-muted border border-border px-1.5 py-0.5 rounded">wykryty</span>
              </label>
            ))}
          </div>
        </>
      )}
```

- [ ] **Step 5: Lint i build typów**

Run: `npm run lint`
Expected: 0 błędów. (Sprawdza m.in. że nie został martwy import `DetectedSuggestion`/`getModelDisplayLabel` — oba są używane.)

- [ ] **Step 6: Weryfikacja manualna w aplikacji**

Run: `npm run tauri dev`
Sprawdź w Ustawienia → Modele:
- pozycja „Auto (domyślny model Claude)" jest pierwsza i zaznaczona na świeżym profilu;
- „Claude Fable 5" jest na liście wbudowanej;
- jeśli CLI udostępnia nowszy/nieznany model, pojawia się w „Wykryte modele" jako wybieralny ze znacznikiem „wykryty", a „Odśwież" go odświeża;
- wybór Auto → nowa sesja Claude startuje bez `--model` (stopka sidebara pokazuje „Auto").

- [ ] **Step 7: Commit**

```bash
git add src/components/dialogs/SettingsDialog.tsx
git commit -m "feat(desktop): add Auto option and auto-promote detected Claude models"
```

---

## Task 4: Weryfikacja końcowa

- [ ] **Step 1: Pełny zestaw testów i lint**

Run: `npm test && npm run test:rust && npm run lint`
Expected: wszystkie testy PASS, 0 błędów `tsc`.

- [ ] **Step 2: Regresja istniejącego użytkownika (bez migracji)**

Z istniejącym `defaultModelId === 'sonnet-4.6'` w localStorage/SQLite: po starcie aplikacji nadal zaznaczony Sonnet 4.6 (Auto NIE nadpisuje zapisanego wyboru). Potwierdza decyzję „Auto domyślne tylko dla świeżych profili".
