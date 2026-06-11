import { describe, it, expect } from 'vitest';
import { ACTIVITY_DOT, ACTIVITY_LABEL, ACTIVITY_ICON, ACTIVITY_TEXT } from './activity';
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
});
