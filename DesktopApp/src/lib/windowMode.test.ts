import { describe, it, expect } from 'vitest';
import { parseWindowMode, buildSessionWindowUrl, sessionWindowLabel } from './windowMode';

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
