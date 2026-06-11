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
