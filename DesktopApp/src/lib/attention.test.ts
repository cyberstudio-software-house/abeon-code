import { describe, it, expect } from 'vitest';
import { triggerMatches, shouldNotify } from './attention';

describe('triggerMatches', () => {
  it('turnEnd matches heuristic only', () => {
    expect(triggerMatches('turnEnd', 'heuristic')).toBe(true);
    expect(triggerMatches('turnEnd', 'hook')).toBe(false);
  });
  it('questionsOnly matches hook only', () => {
    expect(triggerMatches('questionsOnly', 'hook')).toBe(true);
    expect(triggerMatches('questionsOnly', 'heuristic')).toBe(false);
  });
  it('both matches either', () => {
    expect(triggerMatches('both', 'hook')).toBe(true);
    expect(triggerMatches('both', 'heuristic')).toBe(true);
  });
});

describe('shouldNotify', () => {
  it('suppressed when notifications disabled', () => {
    expect(shouldNotify({ enabled: false, trigger: 'both', reason: 'hook', isActiveFocused: false })).toBe(false);
  });
  it('suppressed when looking at the session', () => {
    expect(shouldNotify({ enabled: true, trigger: 'both', reason: 'hook', isActiveFocused: true })).toBe(false);
  });
  it('suppressed when trigger does not match reason', () => {
    expect(shouldNotify({ enabled: true, trigger: 'questionsOnly', reason: 'heuristic', isActiveFocused: false })).toBe(false);
  });
  it('fires when enabled, not looking, trigger matches', () => {
    expect(shouldNotify({ enabled: true, trigger: 'both', reason: 'heuristic', isActiveFocused: false })).toBe(true);
  });
});
