import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import {
  DESKTOP_PROMPT_COMMANDS,
  DesktopSettlePromptMessageSchema,
  type DesktopShowPromptMessage,
} from '../shared/desktopPromptMessages.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

interface DesktopPromptInput {
  title: string;
  prompt: string;
  password?: boolean;
}

interface DesktopPromptRenderer {
  postToRenderer(message: unknown): boolean;
}

type PromptResolver = (value: string | undefined) => void;

interface DesktopPromptIpc extends DesktopMessageHandler {
  request(input: DesktopPromptInput): Effect.Effect<string | undefined>;
  dispose(): void;
}

/** Owns correlated desktop prompt requests and their exact settlement. */
export class DesktopPromptController implements DesktopPromptIpc {
  private readonly pending = new Map<string, PromptResolver>();

  constructor(private readonly renderer: DesktopPromptRenderer) {}

  /**
   * Ask the renderer, and settle with what it answers. The request is
   * registered when the program runs, and its entry leaves `pending` when the
   * answer arrives or when the asking fiber is interrupted, so an abandoned
   * prompt no longer waits for `dispose()` to clear it.
   */
  request(input: DesktopPromptInput): Effect.Effect<string | undefined> {
    return Effect.callback<string | undefined>((resume) => {
      const requestId = randomUUID();
      this.pending.set(requestId, (value) => resume(Effect.succeed(value)));
      const delivered = this.renderer.postToRenderer({
        command: DESKTOP_PROMPT_COMMANDS.SHOW,
        requestId,
        title: input.title,
        prompt: input.prompt,
        password: input.password ?? false,
      } satisfies DesktopShowPromptMessage);
      if (!delivered) this.settle(requestId, undefined);
      return Effect.sync(() => {
        this.pending.delete(requestId);
      });
    });
  }

  handleMessage(message: DesktopCommandMessage): boolean {
    const parsed = DesktopSettlePromptMessageSchema.safeParse(message);
    if (!parsed.success) return false;
    return this.settle(parsed.data.requestId, parsed.data.value ?? undefined);
  }

  dispose(): void {
    for (const requestId of this.pending.keys()) {
      this.settle(requestId, undefined);
    }
  }

  private settle(requestId: string, value: string | undefined): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending(value);
    return true;
  }
}
