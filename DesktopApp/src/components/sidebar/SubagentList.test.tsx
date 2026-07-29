import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SubagentList } from './SubagentList';
import type { SubagentInfo } from '../../types';

function agent(over: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    agentId: 'a1', agentType: 'Explore', description: 'Znajdź skróty',
    status: 'running', startedAt: 1000, endedAt: null, ...over,
  };
}

describe('SubagentList', () => {
  it('calls onPick with the agent id without propagating the click', () => {
    const onPick = vi.fn();
    const onParent = vi.fn();
    const { getByTitle } = render(
      <ul onClick={onParent}>
        <SubagentList agents={[agent()]} onPick={onPick} />
      </ul>,
    );
    fireEvent.click(getByTitle(/Pracuje/));
    expect(onPick).toHaveBeenCalledWith('a1');
    expect(onParent).not.toHaveBeenCalled();
  });

  it('marks the status with a glyph and a tone', () => {
    const { container } = render(
      <ul>
        <SubagentList
          agents={[agent({ agentId: 'a1' }), agent({ agentId: 'a2', status: 'stale', endedAt: 2000 })]}
          onPick={() => {}}
        />
      </ul>,
    );
    expect(container.textContent).toContain('●');
    expect(container.textContent).toContain('⚠');
  });

  it('reports when the session has no agents', () => {
    const { container } = render(<ul><SubagentList agents={[]} onPick={() => {}} /></ul>);
    expect(container.textContent).toContain('Brak agentów');
  });

  it('reports loading while the list has not arrived yet', () => {
    const { container } = render(<ul><SubagentList agents={undefined} onPick={() => {}} /></ul>);
    expect(container.textContent).toContain('Wczytywanie');
    expect(container.textContent).not.toContain('Brak agentów');
  });

  it('reports the failure instead of an empty list when the call failed', () => {
    const { container } = render(
      <ul><SubagentList agents={undefined} error="brak katalogu" onPick={() => {}} /></ul>,
    );
    expect(container.textContent).toContain('brak katalogu');
    expect(container.textContent).not.toContain('Brak agentów');
    expect(container.textContent).not.toContain('Wczytywanie');
  });
});
