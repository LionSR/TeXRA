import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';

import { createOverlayDialog, renderElement } from './overlayDialog';

/**
 * Returns a function that asks before closing a tab with unsaved changes.
 * The `wa-dialog` counts as a native-view overlay (`trackNativeViewOverlays`),
 * so the browser view hides while it is open. `discard` runs only when
 * Discard is chosen; closing the dialog any other way keeps the tab.
 * Requests wait their turn: closing a group with several unsaved tabs
 * asks about each one in order.
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
  // The head is the request on screen. `showing` stays true until the
  // dialog has finished closing; `answered` stops a second answer (a
  // double click, or the wa-hide a Discard click causes) from taking the
  // next request.
  const queue: { title: string; discard: () => void }[] = [];
  let showing = false;
  let answered = false;
  const showHead = () => {
    const head = queue[0];
    if (!head) return;
    showing = true;
    answered = false;
    message.textContent = `${head.title} has unsaved changes. Close it and discard them?`;
    dialog.open = true;
  };

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
          if (answered) return;
          answered = true;
          const head = queue.shift();
          dialog.open = false;
          head?.discard();
        },
      }),
    ),
  );
  // Cancel, the close button and Escape all close through wa-hide.
  dialog.addEventListener('wa-hide', (event) => {
    if (event.target !== dialog || answered) return;
    answered = true;
    queue.shift();
  });
  dialog.addEventListener('wa-after-hide', (event) => {
    if (event.target !== dialog) return;
    showing = false;
    showHead();
  });

  return (title: string, discard: () => void): void => {
    queue.push({ title, discard });
    if (!showing) showHead();
  };
}
