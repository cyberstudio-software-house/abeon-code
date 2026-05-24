import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SessionItem } from './SessionItem';
import type { SessionMeta } from '../../types';

function meta(activity: SessionMeta['activity']): SessionMeta {
  return {
    id: 'abc12345',
    projectId: 1,
    title: 'Test session',
    messageCount: 1,
    lastModified: Date.now(),
    gitBranch: null,
    cwd: null,
    activity,
  };
}

describe('SessionItem dot', () => {
  it('uses bg-success class when running', () => {
    const { container } = render(<SessionItem session={meta('running')} onClick={() => {}} />);
    const dot = container.querySelector('span.rounded-full');
    expect(dot?.className).toMatch(/bg-success/);
  });

  it('uses bg-accent class when waitingUser', () => {
    const { container } = render(<SessionItem session={meta('waitingUser')} onClick={() => {}} />);
    const dot = container.querySelector('span.rounded-full');
    expect(dot?.className).toMatch(/bg-accent/);
  });

  it('uses bg-warn class when waitingTool', () => {
    const { container } = render(<SessionItem session={meta('waitingTool')} onClick={() => {}} />);
    const dot = container.querySelector('span.rounded-full');
    expect(dot?.className).toMatch(/bg-warn/);
  });

  it('uses bg-muted class when idle', () => {
    const { container } = render(<SessionItem session={meta('idle')} onClick={() => {}} />);
    const dot = container.querySelector('span.rounded-full');
    expect(dot?.className).toMatch(/bg-muted/);
  });
});
