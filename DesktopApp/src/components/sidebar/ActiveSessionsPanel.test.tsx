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
// Minimal session tab — the panel only reads kind/sessionId/linkedSessionId.
function sessionTab(sessionId: string) {
  return { kind: 'session', id: `session:${sessionId}`, sessionId, projectId: 1, title: `T-${sessionId}` } as never;
}

describe('ActiveSessionsPanel visibility', () => {
  beforeEach(() => {
    useStore.setState({
      showActiveSessions: true, activeSessions: [], attentionSessions: new Set(),
      sessionsByProject: {}, projects: [project()], tabs: [],
    });
  });

  it('renders nothing when there are no active sessions', () => {
    const { container } = render(<ActiveSessionsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the active session has no open tab', () => {
    useStore.setState({ activeSessions: [active('a')], tabs: [] });
    const { container } = render(<ActiveSessionsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when showActiveSessions is false', () => {
    useStore.setState({ showActiveSessions: false, activeSessions: [active('a')], tabs: [sessionTab('a')] });
    const { container } = render(<ActiveSessionsPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the header with a count for an active session that has an open tab', () => {
    useStore.setState({ activeSessions: [active('a')], tabs: [sessionTab('a')] });
    const { getByText } = render(<ActiveSessionsPanel />);
    expect(getByText('Aktywne')).toBeTruthy();
    expect(getByText('1')).toBeTruthy();
  });
});
