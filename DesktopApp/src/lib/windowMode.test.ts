import { describe, it, expect } from 'vitest';
import { parseWindowMode, buildSessionWindowUrl, buildGroupWindowUrl, sessionWindowLabel, groupWindowLabel, type DetachedTab } from './windowMode';

describe('parseWindowMode', () => {
  it('returns null when no view param', () => {
    expect(parseWindowMode('')).toBeNull();
    expect(parseWindowMode('?foo=bar')).toBeNull();
  });

  it('returns null when required params missing', () => {
    expect(parseWindowMode('?view=session')).toBeNull();
    expect(parseWindowMode('?view=session&projectId=3')).toBeNull();
    expect(parseWindowMode('?view=session&sessionId=abc')).toBeNull();
  });

  it('returns null when projectId is not numeric', () => {
    expect(parseWindowMode('?view=session&projectId=x&sessionId=abc')).toBeNull();
  });

  it('returns null when projectId is not an integer', () => {
    expect(parseWindowMode('?view=session&projectId=1.5&sessionId=abc')).toBeNull();
  });

  it('parses a minimal session mode', () => {
    expect(parseWindowMode('?view=session&projectId=3&sessionId=abc&title=Hi&fresh=false')).toEqual({
      view: 'session', projectId: 3, sessionId: 'abc', title: 'Hi', fresh: false,
    });
  });

  it('parses linkedSessionId and fresh=true', () => {
    expect(parseWindowMode('?view=session&projectId=3&sessionId=new-1&linkedSessionId=real-9&title=Hi&fresh=true')).toEqual({
      view: 'session', projectId: 3, sessionId: 'new-1', linkedSessionId: 'real-9', title: 'Hi', fresh: true,
    });
  });

  it('round-trips through buildSessionWindowUrl', () => {
    const url = buildSessionWindowUrl({ projectId: 7, sessionId: 's1', linkedSessionId: 's2', title: 'My session', fresh: false });
    const search = url.slice(url.indexOf('?'));
    expect(parseWindowMode(search)).toEqual({
      view: 'session', projectId: 7, sessionId: 's1', linkedSessionId: 's2', title: 'My session', fresh: false,
    });
  });
});

describe('sessionWindowLabel', () => {
  it('prefixes and sanitizes to a valid Tauri label', () => {
    expect(sessionWindowLabel('abc-123')).toBe('session-abc-123');
    expect(sessionWindowLabel('a/b c.d')).toBe('session-a_b_c_d');
  });
});

describe('group window mode', () => {
  const tabs: DetachedTab[] = [
    { kind: 'session', id: 'session:s1', sessionId: 's1', title: 'Sesja — żółć', mode: 'history' },
    { kind: 'session', id: 'session:s2', sessionId: 's2', linkedSessionId: 's2r', title: 'Live', mode: 'terminal', fresh: true, provider: 'codex' },
    { kind: 'action', id: 'action:4', actionId: 4, title: 'dev', status: 'running', ptyId: 'pty-9' },
    { kind: 'terminal', id: 'terminal:t1', title: 'Terminal' },
    { kind: 'providerPicker', id: 'picker:p1', title: 'New session' },
  ];

  it('round-trips the payload, including non-ASCII titles', () => {
    const url = buildGroupWindowUrl({ projectId: 7, tabs, activeTabId: 'action:4' });
    const search = url.slice(url.indexOf('?'));
    expect(parseWindowMode(search)).toEqual({ view: 'group', projectId: 7, tabs, activeTabId: 'action:4' });
  });

  it('accepts a null activeTabId', () => {
    const url = buildGroupWindowUrl({ projectId: 1, tabs: [tabs[0]], activeTabId: null });
    const search = url.slice(url.indexOf('?'));
    expect(parseWindowMode(search)).toEqual({ view: 'group', projectId: 1, tabs: [tabs[0]], activeTabId: null });
  });

  it('returns null on a malformed payload', () => {
    expect(parseWindowMode('?view=group&projectId=1&tabs=not-base64!!')).toBeNull();
    expect(parseWindowMode('?view=group&projectId=1')).toBeNull();
    expect(parseWindowMode(`?view=group&projectId=1&tabs=${btoa('[]')}`)).toBeNull();
    expect(parseWindowMode(`?view=group&projectId=x&tabs=${btoa('[{"kind":"terminal","id":"t","title":"T"}]')}`)).toBeNull();
  });
});

describe('groupWindowLabel', () => {
  it('prefixes with project', () => {
    expect(groupWindowLabel(12)).toBe('project-12');
  });
});
