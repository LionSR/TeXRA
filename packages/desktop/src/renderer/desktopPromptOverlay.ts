import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';

import {
  buildDesktopPromptResultMessage,
  type DesktopPromptResultMessage,
  type DesktopShowPromptMessage,
} from '../desktopPromptMessages';
import { createOverlayDialog } from './overlayDialog';

import type WaButton from '@awesome.me/webawesome/dist/components/button/button.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

export interface DesktopPromptOverlayController {
  open(payload: DesktopShowPromptMessage): void;
}

interface DesktopPromptOverlayOptions {
  appRoot: HTMLElement;
  submit(message: DesktopPromptResultMessage): void;
}

interface PromptSettlement {
  readonly requestId: string;
  readonly value: string | undefined;
}

/** Owns presentation and user interaction for desktop text/password prompts. */
export function createDesktopPromptOverlay(
  options: DesktopPromptOverlayOptions,
): DesktopPromptOverlayController {
  const form = document.createElement('form');
  form.classList.add('desktop-prompt-form');

  const input = document.createElement('wa-input') as WaInput;
  input.classList.add('desktop-prompt-input');
  input.autocomplete = 'off';
  input.spellcheck = false;

  const actions = document.createElement('div');
  actions.classList.add('desktop-prompt-actions');
  const cancel = document.createElement('wa-button') as WaButton;
  cancel.classList.add('desktop-prompt-cancel');
  cancel.setAttribute('type', 'button');
  cancel.textContent = 'Cancel';
  const submit = document.createElement('wa-button') as WaButton;
  submit.classList.add('desktop-prompt-submit');
  submit.setAttribute('type', 'submit');
  submit.setAttribute('appearance', 'filled');
  submit.setAttribute('variant', 'brand');
  submit.textContent = 'Save';
  actions.append(cancel, submit);
  form.append(input, actions);

  const shell = createOverlayDialog({
    appRoot: options.appRoot,
    prefix: 'desktop-prompt',
    ariaLabel: 'Enter a value',
    closeLabel: 'Cancel prompt',
    nativeHeader: true,
    content: form,
  });
  const dialog = shell.dialog;
  let activeRequestId: string | undefined;
  let settlement: PromptSettlement | undefined;

  function beginSettlement(value: string | undefined, close: boolean): void {
    if (activeRequestId == null || settlement != null) return;
    settlement = { requestId: activeRequestId, value };
    activeRequestId = undefined;
    if (close) dialog.open = false;
  }

  cancel.addEventListener('click', () => beginSettlement(undefined, true));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    beginSettlement(input.value ?? undefined, true);
  });
  dialog.addEventListener('wa-after-show', () => input.focus());
  dialog.addEventListener('wa-hide', () => beginSettlement(undefined, false));
  dialog.addEventListener('wa-after-hide', () => {
    if (!settlement) return;
    const completed = settlement;
    settlement = undefined;
    input.value = '';
    options.submit(
      buildDesktopPromptResultMessage(completed.requestId, completed.value),
    );
  });

  function open(payload: DesktopShowPromptMessage): void {
    if (activeRequestId != null || settlement != null) return;
    activeRequestId = payload.requestId;
    dialog.label = payload.title;
    input.type = payload.inputType;
    input.label = payload.prompt;
    input.placeholder = payload.placeHolder ?? '';
    input.value = payload.value ?? '';
    dialog.open = true;
    void input.updateComplete.then(() => {
      if (activeRequestId === payload.requestId) input.focus();
    });
  }

  return { open };
}
