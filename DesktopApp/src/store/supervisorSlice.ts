import type { StateCreator } from 'zustand';
import type { SupervisorSnapshot } from '../types';

export type SupervisorSlice = {
  supervisor: SupervisorSnapshot | null;
  supervisorPanelOpen: boolean;
  setSupervisorSnapshot: (snapshot: SupervisorSnapshot) => void;
  openSupervisorPanel: () => void;
  closeSupervisorPanel: () => void;
};

export const createSupervisorSlice: StateCreator<SupervisorSlice> = (set) => ({
  supervisor: null,
  supervisorPanelOpen: false,
  setSupervisorSnapshot: (supervisor) => set({ supervisor }),
  openSupervisorPanel: () => set({ supervisorPanelOpen: true }),
  closeSupervisorPanel: () => set({ supervisorPanelOpen: false }),
});
