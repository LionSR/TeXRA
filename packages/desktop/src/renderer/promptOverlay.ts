import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { Effect, type ManagedRuntime } from 'effect';
import { RpcServer, type RpcMessage } from 'effect/rpc';

import { serveOverMessages } from '@texra/shared/rpcOverMessages';
import { isCommitEnter } from '@ui/wa/keyActivation';
import {
  DESKTOP_PROMPT_COMMANDS,
  DesktopPromptRpcs,
} from '../shared/desktopPromptMessages';
import { createOverlayDialog, renderElement } from './overlayDialog';
import { postToMain } from './messageRoutes';

interface DesktopPromptOverlay {
  /** One message of main's prompt client. */
  receive(message: RpcMessage.FromClientEncoded): void;
}

/** One prompt as main asks it, and what answers it. */
interface Prompt {
  readonly title: string;
  readonly prompt: string;
  readonly password: boolean;
  readonly answer: (value: string | null) => void;
}

/**
 * Renders main's text and password prompts in the desktop renderer: it
 * serves `DesktopPromptRpcs` on `runtime`, for the page's life, one prompt
 * on screen at a time; a newer one answers the one it replaces with null.
 */
export function createDesktopPromptOverlay(
  appRoot: HTMLElement,
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
): DesktopPromptOverlay {
  const form = document.createElement('form');
  form.classList.add('desktop-prompt-form');

  const input = document.createElement('wa-input');
  input.classList.add('desktop-prompt-input');
  input.autocomplete = 'off';
  input.spellcheck = false;

  const actions = document.createElement('div');
  actions.classList.add('desktop-prompt-actions');

  const cancelButton = renderElement(
    renderLabeledActionButton({
      text: 'Cancel',
      appearance: 'outlined',
      className: 'desktop-prompt-cancel btn-secondary',
      onClick: () => answer(null),
    }),
  );

  const submitButton = renderElement(
    renderLabeledActionButton({
      text: 'Save',
      appearance: 'filled',
      variant: 'brand',
      className: 'desktop-prompt-submit btn-primary',
      // The shared button helper always renders type="button", so submit is
      // driven explicitly rather than relying on native type="submit".
      onClick: () => form.requestSubmit(),
    }),
  );

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
  let current: Prompt | undefined;

  function answer(value: string | null): void {
    const request = current;
    if (!request) return;
    current = undefined;
    request.answer(value);
    dialog.open = false;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    answer(input.value ?? '');
  });
  input.addEventListener('keydown', (event) => {
    if (!isCommitEnter(event)) return;
    event.preventDefault();
    form.requestSubmit();
  });
  dialog.addEventListener('wa-hide', () => answer(null));
  dialog.addEventListener('wa-after-show', () => input.focus());

  function open(message: Prompt): void {
    current?.answer(null);
    current = message;
    shell.titleEl.textContent = message.title;
    input.type = message.password ? 'password' : 'text';
    input.label = message.prompt;
    input.value = '';
    dialog.setAttribute('aria-label', message.title);
    dialog.open = true;
    void input.updateComplete.then(() => {
      if (current === message) input.focus();
    });
  }

  const served = runtime.runSync(
    serveOverMessages((_main, message) =>
      Effect.sync(() =>
        postToMain({
          command: DESKTOP_PROMPT_COMMANDS.ANSWER,
          // cast: `rpc`'s messages are plain objects.
          message: message as unknown as Record<string, unknown>,
        }),
      ),
    ),
  );
  runtime.runFork(
    RpcServer.make(DesktopPromptRpcs).pipe(
      Effect.provide(
        DesktopPromptRpcs.toLayer({
          // Main stops waiting (its asker gave up) without closing the
          // prompt: what the user answers then goes nowhere, as before.
          prompt: (request) =>
            Effect.callback<string | null>((resume) => {
              open({
                ...request,
                answer: (value) => resume(Effect.succeed(value)),
              });
            }),
        }),
      ),
      Effect.provideService(RpcServer.Protocol, served.protocol),
    ),
  );

  return {
    receive: (message) => runtime.runFork(served.receive('main', message)),
  };
}
