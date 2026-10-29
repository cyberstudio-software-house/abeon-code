import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { buildClaudeModelRows, FALLBACK_EFFORT_LEVELS } from '../../lib/models';
import {
  SUPERVISOR_GRACE_RANGE, SUPERVISOR_PRESENCE_RANGE,
} from '../../store/settingsSlice';
import { SupervisorDiscordSection } from './SupervisorDiscordSection';
import type { ClaudeOptions, SupervisorLevel } from '../../types';

const FIELD_BASE =
  'bg-bg-elev-2 border border-border rounded text-fg px-2 py-1 text-[12px] transition-colors hover:border-muted focus:outline-none focus:border-accent';

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

function NumberField({ id, label, value, min, max, onCommit }: {
  id: string;
  label: string;
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
    <div className="flex items-center gap-2 text-[12px]">
      <label htmlFor={id} className="text-muted w-40">{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); }}
        className={`${FIELD_BASE} w-24`}
      />
      <span className="text-[11px] text-muted">{min}–{max}</span>
    </div>
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
    <div className="space-y-5">
      <div>
        <h3 className="text-[12px] font-semibold text-fg mb-2">Agent sterujący</h3>
        <div className="flex items-center gap-2 text-[12px]">
          <label htmlFor="supervisor-level" className="text-muted w-40">Poziom</label>
          <select
            id="supervisor-level"
            value={level}
            onChange={e => setLevel(e.target.value as SupervisorLevel)}
            className={`${FIELD_BASE} cursor-pointer`}
          >
            {LEVEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <p className="text-[11px] text-muted mt-2">{LEVEL_HINTS[level]}</p>
        <p className="text-[11px] text-muted mt-1">{UNSUPERVISED_NOTE}</p>
      </div>

      <div className="space-y-2">
        <NumberField
          id="supervisor-grace"
          label="Karencja (s)"
          value={graceSeconds}
          min={SUPERVISOR_GRACE_RANGE.min}
          max={SUPERVISOR_GRACE_RANGE.max}
          onCommit={setGrace}
        />
        <p className="text-[11px] text-muted">
          Tyle czasu masz na własną odpowiedź na pytanie sesji, zanim zajmie się nim agent.
        </p>
        <NumberField
          id="supervisor-presence"
          label="Próg obecności (min)"
          value={presenceMinutes}
          min={SUPERVISOR_PRESENCE_RANGE.min}
          max={SUPERVISOR_PRESENCE_RANGE.max}
          onCommit={setPresence}
        />
        <p className="text-[11px] text-muted">
          Po tylu minutach bez aktywności uznajemy, że nie ma Cię przy komputerze.
        </p>
      </div>

      <div className="flex items-center gap-2 text-[12px]">
        <label htmlFor="supervisor-model" className="text-muted w-40">Model</label>
        <select
          id="supervisor-model"
          value={modelId}
          onChange={e => setModelId(e.target.value)}
          className={`${FIELD_BASE} cursor-pointer`}
        >
          <option value="">Domyślny</option>
          {modelRows.map(row => <option key={row.modelId} value={row.modelId}>{row.label}</option>)}
        </select>
      </div>

      <div>
        <h3 className="text-[12px] font-semibold text-fg mb-2">Operacje produkcyjne</h3>
        <p className="text-[11px] text-muted mb-2">
          Poniższe operacje zawsze wymagają Twojej zgody, niezależnie od poziomu.
        </p>
        <ul className="space-y-1 mb-2">
          {BUILT_IN_RULES.map(rule => (
            <li key={rule} className="text-[11px] font-mono bg-bg-elev-2 border border-border px-2 py-1">{rule}</li>
          ))}
        </ul>
        <p className="text-[11px] text-muted mb-3">
          Narzędzia bandzior ze wstępnym podglądem wymagają zgody dopiero przy faktycznym potwierdzeniu zmiany.
        </p>

        <label htmlFor="supervisor-rules" className="block text-[10px] text-muted uppercase tracking-wider mb-1">
          Dodatkowe reguły
        </label>
        <textarea
          id="supervisor-rules"
          value={rulesDraft}
          onChange={e => setRulesDraft(e.target.value)}
          onBlur={() => setExtraRules(parseRules(rulesDraft))}
          rows={4}
          placeholder={'bash:^kubectl delete\nmcp:mcp__bandzior__*'}
          className="w-full bg-bg border border-border px-3 py-2 text-[12px] font-mono resize-y placeholder:text-muted/60"
        />
        <p className="text-[11px] text-muted mt-1">
          Jedna reguła w linii: <code>bash:&lt;regex&gt;</code> dla poleceń shella albo <code>mcp:&lt;glob&gt;</code> dla narzędzi MCP.
        </p>
        {invalidRules.length > 0 && (
          <p className="text-[11px] text-danger mt-1">
            Reguły bez prefiksu bash: lub mcp: nie będą działać ({invalidRules.length}).
          </p>
        )}
      </div>

      <div>
        <h3 className="text-[12px] font-semibold text-fg mb-2">Discord</h3>
        <SupervisorDiscordSection />
      </div>

      <div className="border-t border-border pt-4">
        <button
          onClick={() => { void startNewConversation(); }}
          disabled={busy}
          className="px-3 py-1.5 border border-border bg-bg-elev-2 text-[12px] text-fg-secondary hover:text-fg disabled:opacity-50"
        >
          Nowa rozmowa agenta
        </button>
        <p className="text-[11px] text-muted mt-2">
          Zaczyna agenta od czystego kontekstu. Poprzednia rozmowa zostaje zamknięta.
        </p>
        {error && <p className="text-[11px] text-danger mt-2">{error}</p>}
      </div>
    </div>
  );
}
