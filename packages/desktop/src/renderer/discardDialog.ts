import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';

import { createOverlayDialog, renderElement } from './overlayDialog';

/**
 * Returns a function that asks before closing a tab with unsaved changes.
 * The `wa-dialog` counts as a native-view overlay (`trackNativeViewOverlays`),
 * so the browser view hides while it is open. `discard` runs only when
 * Discard is chosen; closing the dialog any other way keeps the tab.
 */
export function createDiscardChangesDialog(appRoot: HTMLElement) {
  const message = document.createElement('p');
  message.classList.add('desktop-discard-message');
  const actions = document.createElement('div');
  actions.classList.add('desktop-discard-actions');
  const content = document.createElement('div');
  content.append(message, actions);

  const { dialog } = createOverlayDialog({
    appRoot,
    prefix: 'desktop-discard',
    ariaLabel: 'Discard unsaved changes?',
    closeLabel: 'Keep editing',
    title: 'Discard unsaved changes?',
    content,
  });
  let onDiscard: (() => void) | undefined;

  actions.append(
    renderElement(
      renderLabeledActionButton({
        text: 'Cancel',
        appearance: 'outlined',
        className: 'desktop-discard-cancel btn-secondary',
        onClick: () => {
          dialog.open = false;
        },
      }),
    ),
    renderElement(
      renderLabeledActionButton({
        text: 'Discard',
        kind: 'danger',
        className: 'desktop-discard-confirm',
        onClick: () => {
          const discard = onDiscard;
          onDiscard = undefined;
          dialog.open = false;
          discard?.();
        },
      }),
    ),
  );
  dialog.addEventListener('wa-hide', (event) => {
    if (event.target === dialog) onDiscard = undefined;
  });

  // A newer request replaces a pending one.
  return (title: string, discard: () => void): void => {
    message.textContent = `${title} has unsaved changes. Close it and discard them?`;
    onDiscard = discard;
    dialog.open = true;
  };
}
