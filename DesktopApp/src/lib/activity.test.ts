import { describe, it, expect } from 'vitest';
import { ACTIVITY_DOT, ACTIVITY_LABEL, ACTIVITY_ICON, ACTIVITY_TEXT, ACTIVITY_SHORT_LABEL, activityPulses } from './activity';
import type { SessionActivity } from '../types';

const ALL_STATES: SessionActivity[] = ['running', 'waitingUser', 'waitingTool', 'idle'];

describe('activity maps', () => {
  it('ACTIVITY_DOT covers every state', () => {
    for (const s of ALL_STATES) {
      expect(ACTIVITY_DOT[s]).toMatch(/^bg-/);
    }
  });

  it('ACTIVITY_LABEL covers every state with a non-empty Polish label', () => {
    for (const s of ALL_STATES) {
      expect(ACTIVITY_LABEL[s].length).toBeGreaterThan(0);
    }
  });

  it('ACTIVITY_ICON covers every state', () => {
    for (const s of ALL_STATES) {
      expect(ACTIVITY_ICON[s]).toBeDefined();
    }
  });

  it('ACTIVITY_TEXT covers every state with a text- class', () => {
    for (const s of ALL_STATES) {
      expect(ACTIVITY_TEXT[s]).toMatch(/^text-/);
    }
  });

  it('maps activity to the Grafit colors', () => {
    expect(ACTIVITY_DOT).toEqual({ running: 'bg-accent', waitingUser: 'bg-info', waitingTool: 'bg-pink', idle: 'bg-muted' });
    expect(ACTIVITY_TEXT).toEqual({ running: 'text-accent', waitingUser: 'text-info', waitingTool: 'text-pink', idle: 'text-muted' });
  });

  it('exposes short labels', () => {
    expect(ACTIVITY_SHORT_LABEL).toEqual({ running: 'Pracuje', waitingUser: 'Czeka na Ciebie', waitingTool: 'Czeka na zgodę', idle: 'Bezczynna' });
  });

  it('pulses only while running', () => {
    expect(activityPulses('running')).toBe(true);
    expect(activityPulses('waitingUser')).toBe(false);
    expect(activityPulses('waitingTool')).toBe(false);
    expect(activityPulses('idle')).toBe(false);
  });
});
