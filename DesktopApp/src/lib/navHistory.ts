export type NavState = { history: string[]; index: number };

export function pushNav(state: NavState, id: string): NavState {
  if (state.history[state.index] === id) return state;
  const history = state.history.slice(0, state.index + 1);
  history.push(id);
  return { history, index: history.length - 1 };
}

export function stepBack(state: NavState): { index: number; targetId: string } | null {
  if (state.index <= 0) return null;
  const index = state.index - 1;
  return { index, targetId: state.history[index] };
}

export function stepForward(state: NavState): { index: number; targetId: string } | null {
  if (state.index >= state.history.length - 1) return null;
  const index = state.index + 1;
  return { index, targetId: state.history[index] };
}

export function pruneNav(state: NavState, removedId: string): NavState {
  const removedAtOrBefore = state.history.slice(0, state.index + 1).filter(x => x === removedId).length;
  const history = state.history.filter(x => x !== removedId);
  const index = Math.max(0, Math.min(state.index - removedAtOrBefore, history.length - 1));
  return { history, index };
}
