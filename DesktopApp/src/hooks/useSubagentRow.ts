import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { sessionTabId } from '../store/tabsSlice';
import type { Provider, SubagentInfo } from '../types';

type Args = {
  projectId: number;
  sessionId: string;
  title: string;
  provider?: Provider;
  runningAgents: number;
  totalAgents: number;
};

type SubagentRow = {
  expanded: boolean;
  agents: SubagentInfo[];
  toggleAgents: () => void;
  pickAgent: (agentId: string) => void;
};

export function useSubagentRow(
  { projectId, sessionId, title, provider, runningAgents, totalAgents }: Args,
): SubagentRow {
  const [expanded, setExpanded] = useState(false);
  const agents = useStore(useShallow(s => s.subagentsBySession[sessionId]));
  const loadSubagents = useStore(s => s.loadSubagents);
  const openTab = useStore(s => s.openSessionTab);
  const viewSubagent = useStore(s => s.viewSubagent);

  useEffect(() => {
    if (!expanded) return;
    loadSubagents(projectId, sessionId).catch(() => {});
  }, [expanded, runningAgents, totalAgents, projectId, sessionId, loadSubagents]);

  const toggleAgents = () => setExpanded(value => !value);

  const pickAgent = (agentId: string) => {
    openTab(projectId, sessionId, title, provider);
    viewSubagent(sessionTabId(sessionId), agentId);
  };

  return { expanded, agents: agents ?? [], toggleAgents, pickAgent };
}
