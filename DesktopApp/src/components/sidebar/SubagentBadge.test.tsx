import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SubagentBadge } from './SubagentBadge';

describe('SubagentBadge', () => {
  it('renders nothing when the session has no agents', () => {
    const { container } = render(
      <SubagentBadge running={0} total={0} expanded={false} onToggle={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the running agent count in the accent tone', () => {
    const { getByRole } = render(
      <SubagentBadge running={2} total={3} expanded={false} onToggle={() => {}} />,
    );
    const btn = getByRole('button');
    expect(btn.textContent).toContain('2');
    expect(btn.getAttribute('class') ?? '').toContain('text-accent');
  });

  it('shows the total agent count in the muted tone when nothing is running', () => {
    const { getByRole } = render(
      <SubagentBadge running={0} total={3} expanded={false} onToggle={() => {}} />,
    );
    const btn = getByRole('button');
    expect(btn.textContent).toContain('3');
    expect(btn.getAttribute('class') ?? '').toContain('text-muted');
  });

  it('calls onToggle without propagating the click to the parent', () => {
    const onToggle = vi.fn();
    const onParent = vi.fn();
    const { getByRole } = render(
      <li onClick={onParent}>
        <SubagentBadge running={1} total={1} expanded={false} onToggle={onToggle} />
      </li>,
    );
    fireEvent.click(getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onParent).not.toHaveBeenCalled();
  });
});
