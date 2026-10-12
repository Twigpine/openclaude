import React from 'react';
import { Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { Dialog } from './design-system/Dialog.js';

type Props = {
  sessionTitle: string;
  sessionId: string;
  onConfirm: () => void;
  onCancel: () => void;
};

// Plain React (not react-compiler output): dialogs render rarely, and the
// memo-slot bookkeeping isn't worth maintaining here (see Dialog.tsx).
export function DeleteSessionConfirm({
  sessionTitle,
  sessionId,
  onConfirm,
  onCancel,
}: Props): React.ReactNode {
  useKeybinding('confirm:yes', onConfirm, { context: 'Confirmation' });
  const shortId =
    sessionId.length > 14
      ? `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}`
      : sessionId;
  return (
    <Dialog title="Delete session?" color="error" onCancel={onCancel}>
      <Text>
        {sessionTitle} ({shortId})
      </Text>
      <Text color="error">This cannot be undone.</Text>
    </Dialog>
  );
}
