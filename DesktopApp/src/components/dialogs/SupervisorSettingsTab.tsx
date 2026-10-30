import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { buildClaudeModelRows, FALLBACK_EFFORT_LEVELS } from '../../lib/models';
import {
  SUPERVISOR_GRACE_RANGE, SUPERVISOR_PRESENCE_RANGE,
} from '../../store/settingsSlice';
import {
  BUTTON_CLASS, MONO_FIELD_CLASS, SelectField, SettingsRow, SettingsSection, TEXTAREA_CLASS,
} from '../settings/controls';
import { SupervisorDiscordSection } from './SupervisorDiscordSection';
import type { ClaudeOptions, SupervisorLevel } from '../../types';

const LEVEL_OPTIONS: { value: SupervisorLevel; label: string }[] = [
  { value: 'off', label: 'Wyłączony' },
  { value: 'relay', label: 'Przekaźnik' },
  { value: 'assistant', label: 'Asystent (zalecany)' },
  { value: 'autonomous', label: 'Samodzielny' },
];

const LEVEL_HINTS: Record<SupervisorLevel, string> = {
  off: 'Agent sterujący nie działa, a pytania sesji trafiają do Ciebie jak dotychczas.',
  relay: 'Agent sam niczego nie rozstrzyga: każde pytanie sesji przekazuje Tobie (po karencji, gdy jesteś przy komputerze). Przekazuje Twoje odpowiedzi, robi podsumowania i wykonuje polecenia na Twoją prośbę.',
  assistant: 'Agent odpowiada na pytania sesji w zakresie zadania: po karencji, gdy jesteś przy komputerze, od razu, gdy Cię nie ma. Sprawy zastrzeżone dla Ciebie i te, których nie jest pewien, przekazuje Tobie. Nowe sesje otwiera tylko na Twoją prośbę.',
  autonomous: 'Jak Asystent, a do tego może sam otwierać nowe sesje agentów i mówi Ci, co uruchomił.',
};

const UNSUPERVISED_NOTE =
  'Sesje uruchomione, gdy agent był wyłączony, nie są nadzorowane, dopóki ich nie uruchomisz ponownie.';

const BUILT_IN_RULES: string[] = [
  'git push → main/master',
  'task release',
  'Scalanie PR: gh pr merge, bkt pr merge',
  'Narzędzia zapisu bandzior: config_update, deployment_*, env_vars_set, resource_create/update/delete, secret_create',
];

const RULE_PREFIXES = ['bash:', 'mcp:'];

const parseRules = (text: string) =>
  text.split('\n').map(line => line.trim()).filter(line => line !== '');

function useClaudeModelOptions() {
  const [options, setOptions] = useState<ClaudeOptions>({ models: [], effortLevels: FALLBACK_EFFORT_LEVELS });
  useEffect(() => {
    let disposed = false;
    tauri.detectClaudeOptions()
      .then(result => { if (!disposed) setOptions(result); })
      .catch(() => {});
    return () => { disposed = true; };
  }, []);
  return options;
}

function NumberField({ id, label, description, value, min, max, onCommit }: {
  id: string;
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    onCommit(parsed);
    setDraft(String(Math.max(min, Math.min(max, Math.round(parsed)))));
  };

  return (
    <SettingsRow label={label} htmlFor={id} description={description}>
      <div className="flex items-center gap-2.5">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); }}
          className={`${MONO_FIELD_CLASS} w-24`}
        />
        <span className="text-[12px] text-muted">{min}–{max}</span>
      </div>
    </SettingsRow>
  );
}

export function SupervisorSettingsTab() {
  const level = useStore(s => s.supervisorLevel);
  const graceSeconds = useStore(s => s.supervisorGraceSeconds);
  const presenceMinutes = useStore(s => s.supervisorPresenceMinutes);
  const modelId = useStore(s => s.supervisorModelId);
  const extraRules = useStore(useShallow(s => s.supervisorExtraRules));
  const customModels = useStore(useShallow(s => s.customModels));
  const setLevel = useStore(s => s.setSupervisorLevel);
  const setGrace = useStore(s => s.setSupervisorGraceSeconds);
  const setPresence = useStore(s => s.setSupervisorPresenceMinutes);
  const setModelId = useStore(s => s.setSupervisorModelId);
  const setExtraRules = useStore(s => s.setSupervisorExtraRules);

  const options = useClaudeModelOptions();
  const rows = useMemo(
    () => buildClaudeModelRows(options.models, customModels, modelId),
    [options.models, customModels, modelId],
  );
  const modelRows = [...rows.latest, ...rows.older, ...rows.custom, ...(rows.undetected ? [rows.undetected] : [])];

  const rulesText = extraRules.join('\n');
  const [rulesDraft, setRulesDraft] = useState(rulesText);
  useEffect(() => { setRulesDraft(rulesText); }, [rulesText]);
  const rulesDraftRef = useRef(rulesDraft);
  useEffect(() => { rulesDraftRef.current = rulesDraft; }, [rulesDraft]);
  useEffect(() => () => {
    const state = useStore.getState();
    const rules = parseRules(rulesDraftRef.current);
    if (rules.join('\n') !== state.supervisorExtraRules.join('\n')) state.setSupervisorExtraRules(rules);
  }, []);
  const invalidRules = parseRules(rulesDraft).filter(rule => !RULE_PREFIXES.some(prefix => rule.startsWith(prefix)));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startNewConversation = async () => {
    setBusy(true);
    setError(null);
    try {
      await tauri.supervisorNewConversation();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsSection label="Agent sterujący" description={UNSUPERVISED_NOTE}>
        <SettingsRow label="Poziom" htmlFor="supervisor-level" description={LEVEL_HINTS[level]}>
          <SelectField
            id="supervisor-level"
            value={level}
            onChange={e => setLevel(e.target.value as SupervisorLevel)}
          >
            {LEVEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </SelectField>
        </SettingsRow>
        <NumberField
          id="supervisor-grace"
          label="Karencja (s)"
          description="Tyle czasu masz na własną odpowiedź na pytanie sesji, zanim zajmie się nim agent."
          value={graceSeconds}
          min={SUPERVISOR_GRACE_RANGE.min}
          max={SUPERVISOR_GRACE_RANGE.max}
          onCommit={setGrace}
        />
        <NumberField
          id="supervisor-presence"
          label="Próg obecności (min)"
          description="Po tylu minutach bez aktywności uznajemy, że nie ma Cię przy komputerze."
          value={presenceMinutes}
          min={SUPERVISOR_PRESENCE_RANGE.min}
          max={SUPERVISOR_PRESENCE_RANGE.max}
          onCommit={setPresence}
        />
        <SettingsRow label="Model" htmlFor="supervisor-model">
          <SelectField id="supervisor-model" value={modelId} onChange={e => setModelId(e.target.value)}>
            <option value="">Domyślny</option>
            {modelRows.map(row => <option key={row.modelId} value={row.modelId}>{row.label}</option>)}
          </SelectField>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        label="Operacje produkcyjne"
        description="Poniższe operacje zawsze wymagają Twojej zgody, niezależnie od poziomu."
      >
        <div className="px-[18px] py-4">
          <ul className="flex flex-col gap-1.5">
            {BUILT_IN_RULES.map(rule => (
              <li
                key={rule}
                className="rounded-[7px] border border-border-subtle bg-field px-2.5 py-1.5 font-mono text-[12px] text-fg-secondary"
              >
                {rule}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] leading-[1.5] text-muted">
            Narzędzia bandzior ze wstępnym podglądem wymagają zgody dopiero przy faktycznym potwierdzeniu zmiany.
          </p>
        </div>
        <SettingsRow
          label="Dodatkowe reguły"
          htmlFor="supervisor-rules"
          description={
            <>
              Jedna reguła w linii: <code className="font-mono text-fg-secondary">bash:&lt;regex&gt;</code> dla poleceń shella albo <code className="font-mono text-fg-secondary">mcp:&lt;glob&gt;</code> dla narzędzi MCP.
              {invalidRules.length > 0 && (
                <span className="mt-1 block text-danger">
                  Reguły bez prefiksu bash: lub mcp: nie będą działać ({invalidRules.length}).
                </span>
              )}
            </>
          }
        >
          <textarea
            id="supervisor-rules"
            value={rulesDraft}
            onChange={e => setRulesDraft(e.target.value)}
            onBlur={() => setExtraRules(parseRules(rulesDraft))}
            rows={4}
            placeholder={'bash:^kubectl delete\nmcp:mcp__bandzior__*'}
            className={`${TEXTAREA_CLASS} basis-full`}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label="Discord">
        <SupervisorDiscordSection />
      </SettingsSection>

      <SettingsSection label="Rozmowa agenta">
        <SettingsRow
          label="Czysty kontekst"
          description={
            <>
              Zaczyna agenta od czystego kontekstu. Poprzednia rozmowa zostaje zamknięta.
              {error && <span className="mt-1 block text-danger">{error}</span>}
            </>
          }
        >
          <button type="button" onClick={() => { void startNewConversation(); }} disabled={busy} className={BUTTON_CLASS}>
            Nowa rozmowa agenta
          </button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
