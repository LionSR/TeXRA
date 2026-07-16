import { nanoid } from 'nanoid';

import type { PromptInputOptions } from '@hosts/uiHosts';

import {
  buildDesktopClosePromptMessage,
  buildDesktopShowPromptMessage,
  DESKTOP_PROMPT_COMMANDS,
  DesktopPromptResultMessageSchema,
} from '../desktopPromptMessages.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

interface DesktopPromptRendererPort {
  postToRenderer(message: unknown): boolean;
}

interface PendingPrompt {
  readonly requestId: string;
  readonly options: PromptInputOptions;
  readonly resolve: (value: string | undefined) => void;
}

export interface DesktopPromptIpc extends DesktopMessageHandler {
  input(options: PromptInputOptions): Promise<string | undefined>;
  cancelPending(): void;
  dispose(): void;
}

/** Serializes desktop input requests and owns their promise lifecycle. */
export function createDesktopPromptIpc(
  renderer: DesktopPromptRendererPort,
): DesktopPromptIpc {
  const queue: PendingPrompt[] = [];
  let active: PendingPrompt | undefined;
  let disposed = false;

  function showNext(): void {
    while (!disposed && active == null && queue.length > 0) {
      active = queue.shift();
      if (!active) return;
      const { requestId, options } = active;
      const posted = renderer.postToRenderer(
        buildDesktopShowPromptMessage({
          requestId,
          title: options.title ?? options.prompt ?? 'Enter a value',
          prompt: options.prompt ?? options.title ?? 'Enter a value',
          inputType: options.password ? 'password' : 'text',
          placeHolder: options.placeHolder,
          value: options.value,
        }),
      );
      if (posted) return;

      const failed = active;
      active = undefined;
      failed.resolve(undefined);
    }
  }

  function input(options: PromptInputOptions): Promise<string | undefined> {
    if (disposed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      queue.push({
        requestId: `desktop-prompt-${nanoid()}`,
        options,
        resolve,
      });
      showNext();
    });
  }

  function handleMessage(message: DesktopCommandMessage): boolean {
    if (message.command !== DESKTOP_PROMPT_COMMANDS.RESULT) return false;
    const parsed = DesktopPromptResultMessageSchema.safeParse(message);
    if (!parsed.success || parsed.data.requestId !== active?.requestId) {
      return true;
    }

    const completed = active;
    active = undefined;
    completed.resolve(parsed.data.value);
    showNext();
    return true;
  }

  function cancelPending(): void {
    if (active) {
      renderer.postToRenderer(buildDesktopClosePromptMessage());
    }
    active?.resolve(undefined);
    active = undefined;
    for (const pending of queue.splice(0)) pending.resolve(undefined);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelPending();
  }

  return { input, handleMessage, cancelPending, dispose };
}
