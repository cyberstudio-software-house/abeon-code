import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserBubble } from './UserBubble';

describe('UserBubble', () => {
  it('shows the time when the block has a timestamp', () => {
    render(<UserBubble text="Hej" timestamp={new Date(2026, 9, 29, 18, 42).getTime()} />);
    expect(screen.getByText('18:42')).toBeTruthy();
  });

  it('omits the time when the block has no timestamp', () => {
    render(<UserBubble text="Hej" timestamp={0} />);
    expect(screen.getByText('Ty')).toBeTruthy();
    expect(screen.queryByText(/^\d{2}:\d{2}$/)).toBeNull();
  });
});
