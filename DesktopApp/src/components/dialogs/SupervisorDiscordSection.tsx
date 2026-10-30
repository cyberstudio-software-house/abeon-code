import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import type { DiscordSetupStatus } from '../../types';
import { BUTTON_CLASS, FIELD_CLASS, SettingsRow, Switch } from '../settings/controls';

const DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications';

const BOT_STEPS: string[] = [
  'W Developer Portalu wybierz New Application.',
  'Otwórz zakładkę Bot.',
  'Włącz Message Content Intent.',
  'Kliknij Reset Token i skopiuj token.',
  'W OAuth2 → URL Generator zaznacz scope bot oraz uprawnienia View Channels, Send Messages, Read Message History i Add Reactions.',
  'Otwórz wygenerowany adres i dodaj bota do swojego serwera.',
];

function CheckRow({ testId, ok, children }: { testId: string; ok: boolean; children: ReactNode }) {
  return (
    <li data-testid={testId} className="flex items-start gap-2 text-[12.5px]">
      <span aria-hidden="true" className={`w-4 shrink-0 ${ok ? 'text-success' : 'text-danger'}`}>{ok ? '✓' : '✗'}</span>
      <span className="sr-only">{ok ? 'Gotowe:' : 'Do zrobienia:'}</span>
      <span className="text-fg-secondary break-words">{children}</span>
    </li>
  );
}

const reportFailure = (message: string) => (error: unknown) => {
  toast.error(`${message}: ${formatTauriError(error)}`);
};

function agentConnectionText(status: DiscordSetupStatus): string {
  if (!status.channelActive) return status.blocker ? `Agent połączony z Discordem — ${status.blocker}` : 'Agent połączony z Discordem';
  if (!status.chatLinked) return 'Agent połączony z Discordem — czeka na sparowanie';
  return 'Agent połączony z Discordem';
}

function SetupBlock() {
  const [status, setStatus] = useState<DiscordSetupStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  const [confirmingGlobal, setConfirmingGlobal] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await tauri.supervisorDiscordStatus();
      if (!mounted.current) return;
      setStatus(next);
      setStatusError(null);
    } catch (e) {
      if (!mounted.current) return;
      setStatusError(`Nie udało się pobrać stanu Discorda: ${formatTauriError(e)}`);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const runAction = async (action: () => Promise<void>, failureMessage: string, onSuccess?: () => void) => {
    setBusy(true);
    try {
      await action();
      if (mounted.current) onSuccess?.();
    } catch (e) {
      reportFailure(failureMessage)(e);
    }
    await refresh();
    if (mounted.current) setBusy(false);
  };

  const saveToken = () => runAction(
    () => tauri.supervisorDiscordSaveToken(token),
    'Nie udało się zapisać tokenu',
    () => setToken(''),
  );

  const pair = () => runAction(
    () => tauri.supervisorDiscordPair(code.trim()),
    'Nie udało się sparować',
    () => setCode(''),
  );

  const disableGlobal = () => runAction(
    () => tauri.supervisorDiscordDisableGlobalPlugin(),
    'Nie udało się wyłączyć wtyczki globalnie',
    () => setConfirmingGlobal(false),
  );

  return (
    <>
      <div className="space-y-4 px-[18px] py-4">
        <div className="flex items-center gap-3">
          <h4 className="text-[13px] font-medium text-fg-strong">Konfiguracja bota</h4>
          <button type="button" onClick={() => { void refresh(); }} className="text-[12px] text-muted underline transition-colors hover:text-fg">
            Odśwież
          </button>
        </div>

        {statusError && <p role="alert" className="text-[12px] text-danger">{statusError}</p>}

        {status && (
          <ul className="space-y-1.5">
            <CheckRow testId="check-bun" ok={status.bunPath !== null}>
              Bun zainstalowany{status.bunPath ? ` (${status.bunPath})` : ''}
            </CheckRow>
            <CheckRow testId="check-token" ok={status.tokenStored}>Token bota zapisany</CheckRow>
            <CheckRow testId="check-bot" ok={status.bot !== null}>
              {status.bot ? `Bot: ${status.bot.name}` : (status.botError ?? 'Bot: brak danych')}
            </CheckRow>
            <CheckRow testId="check-intent" ok={status.bot?.messageContentIntent === true}>
              Message Content Intent włączony
            </CheckRow>
            <CheckRow testId="check-guild" ok={(status.bot?.guildCount ?? 0) > 0}>Bot dodany do serwera</CheckRow>
            <CheckRow testId="check-paired" ok={status.pairedUsers > 0}>Sparowany użytkownik</CheckRow>
            <CheckRow testId="check-policy" ok={status.policy === 'allowlist'}>Tylko lista dozwolonych</CheckRow>
            <CheckRow testId="check-channel" ok={status.channelActive && status.chatLinked}>
              {agentConnectionText(status)}
            </CheckRow>
          </ul>
        )}

        {status?.globalPluginEnabled && (
          <div className="space-y-2 rounded-[9px] border border-warn/40 bg-warn/20 px-3 py-2.5">
            <p className="text-[12px] text-fg">
              Wtyczka Discord jest włączona globalnie — każda sesja Claude łączy się z botem.
            </p>
            {confirmingGlobal ? (
              <div className="space-y-2">
                <p className="break-all font-mono text-[11.5px] text-fg-secondary">
                  ~/.claude/settings.json: enabledPlugins → discord@claude-plugins-official: true → false
                </p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => { void disableGlobal(); }} disabled={busy} className={BUTTON_CLASS}>
                    Potwierdź
                  </button>
                  <button type="button" onClick={() => setConfirmingGlobal(false)} disabled={busy} className={BUTTON_CLASS}>
                    Anuluj
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmingGlobal(true)} className={BUTTON_CLASS}>
                Wyłącz globalnie
              </button>
            )}
          </div>
        )}

        <div>
          <h4 className="mb-1.5 text-[13px] font-medium text-fg-strong">Jak utworzyć bota</h4>
          <ol className="list-decimal space-y-0.5 pl-5 text-[12px] leading-[1.5] text-muted">
            {BOT_STEPS.map(step => <li key={step}>{step}</li>)}
          </ol>
          <button
            type="button"
            onClick={() => { void openUrl(DEVELOPER_PORTAL_URL); }}
            className={`${BUTTON_CLASS} mt-3`}
          >
            Otwórz Discord Developer Portal
          </button>
        </div>
      </div>

      <SettingsRow label="Token bota" htmlFor="supervisor-discord-token">
        <div className="flex min-w-0 flex-[0_1_380px] gap-1.5">
          <input
            id="supervisor-discord-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={e => setToken(e.target.value)}
            className={`${FIELD_CLASS} flex-1`}
          />
          <button
            type="button"
            onClick={() => { void saveToken(); }}
            disabled={busy || token.trim() === ''}
            className={BUTTON_CLASS}
          >
            Zapisz token
          </button>
        </div>
      </SettingsRow>

      {status?.tokenStored && (
        <SettingsRow
          label="Kod parowania"
          htmlFor="supervisor-discord-code"
          description="Napisz do bota na Discordzie dowolną wiadomość — odpowie kodem parowania."
        >
          <div className="flex min-w-0 flex-[0_1_280px] gap-1.5">
            <input
              id="supervisor-discord-code"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={e => setCode(e.target.value)}
              className={`${FIELD_CLASS} min-w-0 flex-1`}
            />
            <button
              type="button"
              onClick={() => { void pair(); }}
              disabled={busy || code.trim() === ''}
              className={BUTTON_CLASS}
            >
              Sparuj
            </button>
          </div>
        </SettingsRow>
      )}
    </>
  );
}

export function SupervisorDiscordSection() {
  const enabled = useStore(s => s.supervisorDiscordEnabled);
  const muteWhenPresent = useStore(s => s.supervisorDiscordMuteWhenPresent);
  const setEnabled = useStore(s => s.setSupervisorDiscordEnabled);
  const setMuteWhenPresent = useStore(s => s.setSupervisorDiscordMuteWhenPresent);

  return (
    <>
      <SettingsRow label="Rozmowa przez Discord" labelId="supervisor-discord-enabled-label">
        <Switch checked={enabled} onChange={setEnabled} labelledBy="supervisor-discord-enabled-label" />
      </SettingsRow>
      {enabled && (
        <SettingsRow label="Wyciszaj Discord, gdy jestem przy komputerze" labelId="supervisor-discord-mute-label">
          <Switch checked={muteWhenPresent} onChange={setMuteWhenPresent} labelledBy="supervisor-discord-mute-label" />
        </SettingsRow>
      )}
      {enabled && <SetupBlock />}
    </>
  );
}
