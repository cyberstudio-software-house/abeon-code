import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolUseBlock } from './ToolUseBlock';

function setup(status: 'pending' | 'done' | 'error') {
  return render(<ToolUseBlock name="Bash" inputSummary="ls" rawInput={{}} status={status} />);
}

describe('ToolUseBlock status', () => {
  it('shows a success mark with hidden text when done', () => {
    const { container } = setup('done');
    expect(screen.getByText('zakończone').className).toContain('sr-only');
    expect(container.querySelector('.text-success')).not.toBeNull();
  });

  it('shows a danger mark with hidden text on error', () => {
    const { container } = setup('error');
    expect(screen.getByText('błąd').className).toContain('sr-only');
    expect(container.querySelector('.text-danger')).not.toBeNull();
    expect(container.querySelector('.text-success')).toBeNull();
  });

  it('shows no mark while pending', () => {
    const { container } = setup('pending');
    expect(screen.queryByText('zakończone')).toBeNull();
    expect(screen.queryByText('błąd')).toBeNull();
    expect(container.querySelector('.text-success')).toBeNull();
    expect(container.querySelector('.text-danger')).toBeNull();
  });
});
