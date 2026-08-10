import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import {
  DESKTOP_PROMPT_COMMANDS,
  type DesktopSettlePromptMessage,
  type DesktopShowPromptMessage,
} from '../shared/desktopPromptMessages';
import { createOverlayDialog } from './overlayDialog';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

export interface DesktopPromptOverlay {
  open(message: DesktopShowPromptMessage): void;
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
  cancelButton.classList.add('desktop-prompt-cancel', 'btn-secondary');
  cancelButton.setAttribute('appearance', 'outlined');
  cancelButton.setAttribute('type', 'button');
  cancelButton.textContent = 'Cancel';

  const submitButton = document.createElement('wa-button');
  submitButton.classList.add('desktop-prompt-submit', 'btn-primary');
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
  // The prompt text lives in the field's own label, not the shell subtitle. As
  // a subtitle it named nothing — wa-input puts its control inside a shadow
  // root, so only WebAwesome's `label` produces a real <label for>. Kept in one
  // place rather than two so the text is not read out twice. Hide the empty
  // subtitle so its always-on top margin does not leave a gap between the
  // title and the input.
  shell.subtitleEl.hidden = true;
  let current: DesktopShowPromptMessage | undefined;

  function sendSettlement(
    request: DesktopShowPromptMessage,
    value: string | null,
  ): void {
    send({
      command: DESKTOP_PROMPT_COMMANDS.SETTLE,
      requestId: request.requestId,
      value,
    });
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
    form.requestSubmit();
  });
  cancelButton.addEventListener('click', () => settle(null));
  dialog.addEventListener('wa-hide', () => settle(null));
  dialog.addEventListener('wa-after-show', () => input.focus());

  function open(message: DesktopShowPromptMessage): void {
    if (current) sendSettlement(current, null);
    current = message;
    shell.titleEl.textContent = message.title;
    input.type = message.password ? 'password' : 'text';
    input.label = message.prompt;
    input.value = '';
    dialog.setAttribute('aria-label', message.title);
    dialog.open = true;
    void input.updateComplete.then(() => {
      if (current?.requestId === message.requestId) input.focus();
    });
  }

  return { open };
}
