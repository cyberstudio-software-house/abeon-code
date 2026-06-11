import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SessionItem } from './SessionItem';
import type { SessionMeta } from '../../types';

function meta(activity: SessionMeta['activity'], provider: SessionMeta['provider'] = 'claude'): SessionMeta {
  return {
    id: 'abc12345',
    projectId: 1,
    title: 'Test session',
    messageCount: 1,
    lastModified: Date.now(),
    gitBranch: null,
    cwd: null,
    activity,
    provider,
  };
}

describe('SessionItem provider icon', () => {
  it('renders provider icon tinted by activity (waitingTool → text-warn)', () => {
    const session = meta('waitingTool', 'codex');
    const { container } = render(<SessionItem session={session} onClick={() => {}} />);
    const iconSpan = container.querySelector('span[title]');
    expect(iconSpan).toBeTruthy();
    const svg = iconSpan?.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('class') ?? '').toContain('text-warn');
  });

  it('renders text-success when running', () => {
    const { container } = render(<SessionItem session={meta('running')} onClick={() => {}} />);
    const svg = container.querySelector('span[title] svg');
    expect(svg?.getAttribute('class') ?? '').toContain('text-success');
  });

  it('renders text-accent when waitingUser', () => {
    const { container } = render(<SessionItem session={meta('waitingUser')} onClick={() => {}} />);
    const svg = container.querySelector('span[title] svg');
    expect(svg?.getAttribute('class') ?? '').toContain('text-accent');
  });

  it('renders text-muted when idle', () => {
    const { container } = render(<SessionItem session={meta('idle')} onClick={() => {}} />);
    const svg = container.querySelector('span[title] svg');
    expect(svg?.getAttribute('class') ?? '').toContain('text-muted');
  });

  it('claude and codex sessions render different svgs (different polygon vs path content)', () => {
    const { container: claudeContainer } = render(<SessionItem session={meta('idle', 'claude')} onClick={() => {}} />);
    const { container: codexContainer } = render(<SessionItem session={meta('idle', 'codex')} onClick={() => {}} />);
    const claudeSvgInner = claudeContainer.querySelector('span[title] svg')?.innerHTML;
    const codexSvgInner = codexContainer.querySelector('span[title] svg')?.innerHTML;
    expect(claudeSvgInner).not.toEqual(codexSvgInner);
  });
});
