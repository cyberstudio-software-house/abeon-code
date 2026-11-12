import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useStore } from '../../store';
import { hasNotesToSettle } from '../../store/notesSlice';
import { dirtyFileTabIds } from '../../store/filesSlice';
import { isTabLiveProcess } from '../../lib/tabProcess';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';

type WindowCloseGuard = {
  confirmingClose: boolean;
  cancelClose: () => void;
  notesLossDialog: ReactNode;
};

export function useWindowCloseGuard(promptUnsavedFiles: (tabIds: string[]) => Promise<boolean>): WindowCloseGuard {
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingNotesLoss, setConfirmingNotesLoss] = useState(false);

  const continueClose = useCallback(() => {
    const state = useStore.getState();
    if (state.tabs.some(t => isTabLiveProcess(t, state.runningActions, state.drawers))) {
      setConfirmingClose(true);
    } else {
      void getCurrentWebviewWindow().destroy();
    }
  }, []);

  const settleNotesThenContinue = useCallback(() => {
    void useStore.getState().settleNoteDraftsForExit()
      .catch(() => false)
      .then(saved => (saved ? continueClose() : setConfirmingNotesLoss(true)));
  }, [continueClose]);

  const continueAfterFiles = useCallback(() => {
    if (hasNotesToSettle(useStore.getState())) settleNotesThenContinue();
    else continueClose();
  }, [continueClose, settleNotesThenContinue]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWebviewWindow().onCloseRequested((event) => {
      const state = useStore.getState();
      const dirtyFileIds = dirtyFileTabIds(state);
      if (dirtyFileIds.length > 0) {
        event.preventDefault();
        void promptUnsavedFiles(dirtyFileIds).then(proceed => { if (proceed) continueAfterFiles(); });
        return;
      }
      if (hasNotesToSettle(state)) {
        event.preventDefault();
        settleNotesThenContinue();
        return;
      }
      if (state.tabs.some(t => isTabLiveProcess(t, state.runningActions, state.drawers))) {
        event.preventDefault();
        setConfirmingClose(true);
      }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [continueAfterFiles, settleNotesThenContinue, promptUnsavedFiles]);

  const notesLossDialog = confirmingNotesLoss ? (
    <ConfirmDialog
      title="Nie udało się zapisać notatki"
      message="Zamknięcie okna spowoduje utratę niezapisanej treści notatki."
      confirmLabel="Zamknij mimo to"
      onCancel={() => setConfirmingNotesLoss(false)}
      onConfirm={() => {
        setConfirmingNotesLoss(false);
        continueClose();
      }}
    />
  ) : null;

  return { confirmingClose, cancelClose: () => setConfirmingClose(false), notesLossDialog };
}
