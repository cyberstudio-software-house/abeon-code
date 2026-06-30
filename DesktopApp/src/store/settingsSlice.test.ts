import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';

describe('settingsSlice enabledProviders', () => {
  beforeEach(() => { useStore.setState({ enabledProviders: ['claude'] }); });

  it('toggleProvider adds and removes a provider', () => {
    useStore.getState().toggleProvider('codex');
    expect(useStore.getState().enabledProviders).toEqual(['claude', 'codex']);
    useStore.getState().toggleProvider('codex');
    expect(useStore.getState().enabledProviders).toEqual(['claude']);
  });

  it('never allows removing the last enabled provider', () => {
    useStore.getState().toggleProvider('claude');
    expect(useStore.getState().enabledProviders).toEqual(['claude']);
  });
});

describe('settingsSlice codex models', () => {
  beforeEach(() => {
    useStore.setState({ codexModelId: '', codexTitleGenModelId: '', codexCustomModels: [] });
  });

  it('addCodexCustomModel trims and dedupes', () => {
    useStore.getState().addCodexCustomModel('  gpt-5.5-codex  ');
    useStore.getState().addCodexCustomModel('gpt-5.5-codex');
    expect(useStore.getState().codexCustomModels).toEqual(['gpt-5.5-codex']);
  });

  it('addCodexCustomModel ignores empty input', () => {
    useStore.getState().addCodexCustomModel('   ');
    expect(useStore.getState().codexCustomModels).toEqual([]);
  });

  it('removeCodexCustomModel resets selections pointing at it', () => {
    useStore.getState().addCodexCustomModel('gpt-x');
    useStore.getState().setCodexModel('gpt-x');
    useStore.getState().setCodexTitleGenModel('gpt-x');
    useStore.getState().removeCodexCustomModel('gpt-x');
    expect(useStore.getState().codexCustomModels).toEqual([]);
    expect(useStore.getState().codexModelId).toBe('');
    expect(useStore.getState().codexTitleGenModelId).toBe('');
  });

  it('removeCodexCustomModel keeps selections of other models', () => {
    useStore.getState().addCodexCustomModel('gpt-a');
    useStore.getState().addCodexCustomModel('gpt-b');
    useStore.getState().setCodexModel('gpt-a');
    useStore.getState().removeCodexCustomModel('gpt-b');
    expect(useStore.getState().codexModelId).toBe('gpt-a');
  });
});

describe('settingsSlice showActiveSessions', () => {
  beforeEach(() => { useStore.setState({ showActiveSessions: true }); });

  it('defaults to true and toggles via setter', () => {
    expect(useStore.getState().showActiveSessions).toBe(true);
    useStore.getState().setShowActiveSessions(false);
    expect(useStore.getState().showActiveSessions).toBe(false);
  });
});
