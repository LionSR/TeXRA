import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';

// Local imports - prompt protocol
import {
  buildDesktopSettlePromptMessage,
  type DesktopSettlePromptMessage,
  type DesktopShowPromptMessage,
} from '../desktopPromptMessages';

// Local imports - shared overlay chrome
import { createOverlayDialog } from './overlayDialog';

// Third-party imports - component types
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

export interface DesktopPromptOverlay {
  open(message: DesktopShowPromptMessage): void;
  cancel(): void;
}

/** Renders correlated text and password prompts in the desktop renderer. */
export function createDesktopPromptOverlay(
  appRoot: HTMLElement,
  send: (message: DesktopSettlePromptMessage) => void,
): DesktopPromptOverlay {
  const form = document.createElement('form');
  form.classList.add('desktop-prompt-form');

  const input = document.createElement('wa-input') as WaInput;
  input.classList.add('desktop-prompt-input');
  input.autocomplete = 'off';
  input.spellcheck = false;

  const actions = document.createElement('div');
  actions.classList.add('desktop-prompt-actions');

  const cancelButton = document.createElement('wa-button');
  cancelButton.classList.add('desktop-prompt-cancel');
  cancelButton.setAttribute('appearance', 'outlined');
  cancelButton.setAttribute('type', 'button');
  cancelButton.textContent = 'Cancel';

  const submitButton = document.createElement('wa-button');
  submitButton.classList.add('desktop-prompt-submit');
  submitButton.setAttribute('appearance', 'filled');
  submitButton.setAttribute('variant', 'brand');
  submitButton.setAttribute('type', 'submit');
  submitButton.textContent = 'Save';

  actions.append(cancelButton, submitButton);
  form.append(input, actions);

  const shell = createOverlayDialog({
    appRoot,
    prefix: 'desktop-prompt',
    ariaLabel: 'Input requested',
    closeLabel: 'Cancel prompt',
    title: 'Input requested',
    content: form,
  });
  const dialog = shell.dialog;
  let current: DesktopShowPromptMessage | undefined;

  function sendSettlement(
    request: DesktopShowPromptMessage,
    value: string | null,
  ): void {
    send(buildDesktopSettlePromptMessage(request.requestId, value));
  }

  function settle(value: string | null): void {
    const request = current;
    if (!request) return;
    current = undefined;
    sendSettlement(request, value);
    dialog.open = false;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    settle(input.value ?? '');
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    settle(input.value ?? '');
  });
  cancelButton.addEventListener('click', () => settle(null));
  dialog.addEventListener('wa-hide', () => settle(null));
  dialog.addEventListener('wa-after-show', () => input.focus());

  function open(message: DesktopShowPromptMessage): void {
    if (current) sendSettlement(current, null);
    current = message;
    if (shell.titleEl) shell.titleEl.textContent = message.title;
    if (shell.subtitleEl) shell.subtitleEl.textContent = message.prompt;
    input.type = message.password ? 'password' : 'text';
    input.value = '';
    dialog.setAttribute('aria-label', message.title);
    dialog.open = true;
    void input.updateComplete.then(() => {
      if (current?.requestId === message.requestId) input.focus();
    });
  }

  function cancel(): void {
    settle(null);
  }

  return { open, cancel };
}
