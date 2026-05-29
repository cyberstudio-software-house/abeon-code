import { describe, it, expect } from 'vitest';
import { formatTauriError } from './errors';

describe('formatTauriError', () => {
  it('returns string errors unchanged', () => {
    expect(formatTauriError('boom')).toBe('boom');
  });

  it('extracts message from a Tauri AppError object', () => {
    expect(formatTauriError({ code: 'not_found', message: 'not found: session.jsonl' }))
      .toBe('not found: session.jsonl');
  });

  it('uses Error.message for Error instances', () => {
    expect(formatTauriError(new Error('kaboom'))).toBe('kaboom');
  });

  it('never returns "[object Object]" for plain objects', () => {
    expect(formatTauriError({ foo: 1 })).not.toBe('[object Object]');
  });
});
