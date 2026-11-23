import { useEffect, useId, useState, type ReactNode } from 'react';
import { tauri } from '../../lib/tauri';
import { useStore } from '../../store';
import type { BuildProvider, DeployFlow, Delivery, RepoFlow } from '../../types';
import { Segmented, SelectField, Switch } from '../settings/controls';

const BUILD_OPTIONS: { value: BuildProvider; label: string }[] = [
  { value: 'bitbucket', label: 'Bitbucket Pipelines' },
  { value: 'github', label: 'GitHub Actions' },
  { value: 'none', label: 'brak' },
];

const DELIVERY_OPTIONS: { value: Delivery; label: string }[] = [
  { value: 'image', label: 'Obraz + Bandzior/Argo' },
  { value: 'kubemeter', label: 'Webhook Kubemeter' },
  { value: 'none', label: 'brak' },
];

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return 'Nie udało się wykonać operacji';
}

function blankFlow(repo: RepoFlow): DeployFlow {
  return {
    repoPath: repo.repoPath,
    enabled: true,
    remote: repo.remotes.includes('origin') ? 'origin' : repo.remotes[0] ?? 'origin',
    build: 'none',
    buildRepo: '',
    productionBranch: 'main',
    delivery: 'none',
    namespace: '',
    workloads: [],
    kubeContext: null,
    updatedAt: 0,
  };
}

function parseWorkloads(text: string): string[] {
  return text.split(',').map(item => item.trim()).filter(Boolean);
}

function Row({ label, labelId, children }: { label: string; labelId: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span id={labelId} className="w-[140px] shrink-0 text-[12px] text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}

function TextRow({ label, value, onChange, placeholder, mono }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-3">
      <label htmlFor={id} className="w-[140px] shrink-0 text-[12px] text-muted">{label}</label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        className={`field min-w-0 flex-1 ${mono ? 'font-mono text-[12px]' : ''}`}
      />
    </div>
  );
}

function FlowForm({ projectId, repo }: { projectId: number; repo: RepoFlow }) {
  const saveFlow = useStore(state => state.saveFlow);
  const deleteFlow = useStore(state => state.deleteFlow);
  const [draft, setDraft] = useState<DeployFlow>(() => repo.flow ?? blankFlow(repo));
  const [workloadsText, setWorkloadsText] = useState(() => (repo.flow?.workloads ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const enabledId = useId();
  const remoteId = useId();
  const buildId = useId();
  const deliveryId = useId();

  const patch = (changes: Partial<DeployFlow>) => {
    setDraft(current => ({ ...current, ...changes }));
    setSaved(false);
  };

  const remoteOptions = Array.from(new Set([...repo.remotes, draft.remote].filter(Boolean)));

  const detect = async () => {
    setBusy(true);
    setError(null);
    try {
      const detected = await tauri.deployDetectFlow(repo.repoPath);
      setDraft({ ...detected, repoPath: repo.repoPath });
      setWorkloadsText(detected.workloads.join(', '));
      setSaved(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const payload: DeployFlow = {
      ...draft,
      repoPath: repo.repoPath,
      remote: draft.remote.trim(),
      buildRepo: draft.buildRepo.trim(),
      productionBranch: draft.productionBranch.trim(),
      namespace: draft.namespace.trim(),
      workloads: parseWorkloads(workloadsText),
      kubeContext: draft.kubeContext?.trim() ? draft.kubeContext.trim() : null,
    };
    setBusy(true);
    setError(null);
    try {
      await saveFlow(projectId, payload);
      setDraft(payload);
      setWorkloadsText(payload.workloads.join(', '));
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
      setSaved(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteFlow(projectId, repo.repoPath);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <button type="button" onClick={detect} disabled={busy} className="btn-secondary self-start">
        Wykryj z repozytorium
      </button>
      <Row label="Śledź wdrożenia" labelId={enabledId}>
        <Switch checked={draft.enabled} onChange={enabled => patch({ enabled })} labelledBy={enabledId} />
      </Row>
      <Row label="Zdalne repozytorium" labelId={remoteId}>
        <SelectField
          aria-labelledby={remoteId}
          wrapperClassName="flex-1"
          value={draft.remote}
          onChange={event => patch({ remote: event.target.value })}
        >
          {remoteOptions.length === 0 && <option value="">brak</option>}
          {remoteOptions.map(name => <option key={name} value={name}>{name}</option>)}
        </SelectField>
      </Row>
      <Row label="Budowanie" labelId={buildId}>
        <Segmented value={draft.build} options={BUILD_OPTIONS} onChange={build => patch({ build })} labelledBy={buildId} />
      </Row>
      {draft.build !== 'none' && (
        <TextRow
          label="Repozytorium (CI)"
          value={draft.buildRepo}
          onChange={buildRepo => patch({ buildRepo })}
          placeholder="właściciel/nazwa"
          mono
        />
      )}
      <TextRow
        label="Gałąź produkcyjna"
        value={draft.productionBranch}
        onChange={productionBranch => patch({ productionBranch })}
        mono
      />
      <Row label="Dostarczenie" labelId={deliveryId}>
        <Segmented value={draft.delivery} options={DELIVERY_OPTIONS} onChange={delivery => patch({ delivery })} labelledBy={deliveryId} />
      </Row>
      {draft.delivery !== 'none' && (
        <>
          <TextRow label="Namespace" value={draft.namespace} onChange={namespace => patch({ namespace })} mono />
          <TextRow
            label="Zasoby"
            value={workloadsText}
            onChange={text => { setWorkloadsText(text); setSaved(false); }}
            placeholder="app, worker (puste = wszystkie Deployments)"
            mono
          />
          <TextRow
            label="Kontekst kubectl"
            value={draft.kubeContext ?? ''}
            onChange={kubeContext => patch({ kubeContext })}
            placeholder="puste = bieżący kontekst"
            mono
          />
        </>
      )}
      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        {saved && <span className="mr-auto text-[11px] text-success">Zapisano</span>}
        {repo.flow && (
          <button type="button" onClick={remove} disabled={busy} className="btn-secondary">Usuń przepływ</button>
        )}
        <button type="button" onClick={save} disabled={busy} className="btn-primary">Zapisz przepływ</button>
      </div>
    </div>
  );
}

export function DeployFlowSection({ projectId }: { projectId: number }) {
  const loadRepoFlows = useStore(state => state.loadRepoFlows);
  const repos = useStore(state => state.repoFlowsByProject[projectId]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const pickerId = useId();

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadError(null);
    loadRepoFlows(projectId)
      .catch(e => { if (active) setLoadError(errorMessage(e)); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [projectId, loadRepoFlows]);

  let body: ReactNode;
  if (loadError) {
    body = <p role="alert" className="text-[11px] text-danger">{loadError}</p>;
  } else if (!loaded || !repos) {
    body = <p className="text-[12px] text-muted">Wczytywanie…</p>;
  } else if (repos.length === 0) {
    body = <p className="text-[12px] text-muted">Ten projekt nie zawiera repozytorium Git.</p>;
  } else {
    const current = repos.find(repo => repo.repoPath === selectedPath) ?? repos[0];
    body = (
      <div className="flex flex-col gap-3">
        {repos.length > 1 && (
          <div className="flex items-center gap-3">
            <label htmlFor={pickerId} className="w-[140px] shrink-0 text-[12px] text-muted">Repozytorium</label>
            <SelectField
              id={pickerId}
              wrapperClassName="flex-1"
              value={current.repoPath}
              onChange={event => setSelectedPath(event.target.value)}
            >
              {repos.map(repo => <option key={repo.repoPath} value={repo.repoPath}>{repo.label}</option>)}
            </SelectField>
          </div>
        )}
        <FlowForm key={current.repoPath} projectId={projectId} repo={current} />
      </div>
    );
  }

  return (
    <section aria-label="Przepływ wdrożenia" className="mb-4 border-t border-border pt-4">
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.06em] text-label">Przepływ wdrożenia</h3>
      {body}
    </section>
  );
}
