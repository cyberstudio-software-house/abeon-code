import { describe, it, expect } from 'vitest';
import { sanitizeRestoredTabs } from './index';

describe('sanitizeRestoredTabs', () => {
  it('drops unlinked new- placeholder tabs (orphaned, point at nothing on disk)', () => {
    const out = sanitizeRestoredTabs([
      { kind: 'session', id: 'session:new-1', projectId: 1, sessionId: 'new-1', title: 'New session' },
      { kind: 'session', id: 'session:abc', projectId: 1, sessionId: 'abc', title: 'Real' },
      { kind: 'session', id: 'session:new-2', projectId: 1, sessionId: 'new-2', linkedSessionId: 'real-2', title: 'Linked' },
    ]);
    expect(out.map(t => t.sessionId)).toEqual(['abc', 'new-2']);
  });

  it('keeps deterministic real-id session tabs', () => {
    const out = sanitizeRestoredTabs([
      { kind: 'session', id: 'session:11111111-2222-3333-4444-555555555555', projectId: 2, sessionId: '11111111-2222-3333-4444-555555555555', title: 'Fix bug' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('rejects malformed entries', () => {
    const out = sanitizeRestoredTabs([
      // @ts-expect-error intentionally malformed
      { kind: 'session', id: 5, sessionId: 'x', projectId: 1, title: 't' },
      // @ts-expect-error intentionally malformed
      { kind: 'terminal', id: 'terminal:1', projectId: 1, title: 't' },
    ]);
    expect(out).toHaveLength(0);
  });
});
