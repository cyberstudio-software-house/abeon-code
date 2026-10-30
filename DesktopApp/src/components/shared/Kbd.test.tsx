import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Kbd } from './Kbd';

describe('Kbd', () => {
  it('renders the hint in mono', () => {
    render(<Kbd>Ctrl+1</Kbd>);
    const el = screen.getByText('Ctrl+1');
    expect(el).toHaveClass('font-mono');
    expect(el).not.toHaveClass('font-sans');
  });
});
