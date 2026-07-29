import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { sessionTabId } from '../store/tabsSlice';
import type { Provider, SubagentInfo } from '../types';

type Args = {
  projectId: number;
  sessionId: string;
  title: string;
  provider?: Provider;
};

type SubagentRow = {
  expanded: boolean;
  agents: SubagentInfo[];
  toggleAgents: () => void;
  pickAgent: (agentId: string) => void;
};

export function useSubagentRow({ projectId, sessionId, title, provider }: Args): SubagentRow {
  const [expanded, setExpanded] = useState(false);
  const agents = useStore(useShallow(s => s.subagentsBySession[sessionId]));
  const loadSubagents = useStore(s => s.loadSubagents);
  const openTab = useStore(s => s.openSessionTab);
  const viewSubagent = useStore(s => s.viewSubagent);

  const toggleAgents = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) loadSubagents(projectId, sessionId).catch(() => {});
  };

  const pickAgent = (agentId: string) => {
    openTab(projectId, sessionId, title, provider);
    viewSubagent(sessionTabId(sessionId), agentId);
  };

  return { expanded, agents: agents ?? [], toggleAgents, pickAgent };
}
