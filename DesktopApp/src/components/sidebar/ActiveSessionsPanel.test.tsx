import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ActiveSessionsPanel } from './ActiveSessionsPanel';
import { useStore } from '../../store';
import type { ActiveSession, Project } from '../../types';

function active(id: string): ActiveSession {
  return { sessionId: id, projectId: 1, projectName: 'Proj', title: `T-${id}`, activity: 'running', lastModified: 1, provider: 'claude' };
}
function project(): Project {
  return { id: 1, name: 'Proj', path: '/p', claudeDir: 'd', color: null, sortOrder: 0, createdAt: 0 };
}

describe('ActiveSessionsPanel visibility', () => {
  beforeEach(() => {
    useStore.setState({
      showActiveSessions: true, activeSessions: [], attentionSessions: new Set(),
      sessionsByProject: {}, projects: [project()],
    });
  });

  it('renders nothing when there are no active sessions', () => {
    const { container } = render(<ActiveSessionsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when showActiveSessions is false', () => {
    useStore.setState({ showActiveSessions: false, activeSessions: [active('a')] });
    const { container } = render(<ActiveSessionsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the header with a count when there is an active session', () => {
    useStore.setState({ activeSessions: [active('a')] });
    const { getByText } = render(<ActiveSessionsPanel />);
    expect(getByText('Aktywne')).toBeTruthy();
    expect(getByText('1')).toBeTruthy();
  });
});
