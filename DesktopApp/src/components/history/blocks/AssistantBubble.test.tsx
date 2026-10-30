import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssistantBubble } from './AssistantBubble';

describe('AssistantBubble', () => {
  it('labels the message with the provider and time', () => {
    render(
      <AssistantBubble
        text="Gotowe."
        timestamp={new Date(2026, 9, 29, 18, 42).getTime()}
        providerLabel="Codex"
      />,
    );
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('18:42')).toBeTruthy();
    expect(screen.getByText('Gotowe.')).toBeTruthy();
  });

  it('omits the time when the block has no timestamp', () => {
    render(<AssistantBubble text="Gotowe." timestamp={0} providerLabel="Codex" />);
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.queryByText(/^\d{2}:\d{2}$/)).toBeNull();
  });
});
