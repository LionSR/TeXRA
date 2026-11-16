import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import {
  DESKTOP_PROMPT_COMMANDS,
  DesktopAnswerPromptMessageSchema,
} from '../shared/desktopPromptMessages.js';
import type { DesktopPush } from '../shared/desktopOutboundMessages.js';
import { parsedRoute, type DesktopCommandRoutes } from './desktopIpcTypes.js';

interface DesktopPromptInput {
  title: string;
  prompt: string;
  password?: boolean;
}

type PromptResolver = (value: string | undefined) => void;

/** Owns correlated desktop prompt requests and answers each exactly once. */
export class DesktopPromptController {
  private readonly pending = new Map<string, PromptResolver>();

  /** An answer for no pending request (a duplicate, or one whose asker
   *  was interrupted) does nothing. */
  readonly routes: DesktopCommandRoutes = {
    [DESKTOP_PROMPT_COMMANDS.ANSWER]: parsedRoute(
      DesktopAnswerPromptMessageSchema,
      ({ requestId, value }) =>
        Effect.sync(() => {
          this.answer(requestId, value ?? undefined);
        }),
    ),
  };

  private readonly post: (message: DesktopPush) => void;
  constructor(post: (message: DesktopPush) => void) {
    this.post = post;
  }

  /**
   * Ask the renderer, and finish with what it answers. The request is
   * registered when the program runs, and its entry leaves `pending` when the
   * answer arrives or when the asking fiber is interrupted, so an abandoned
   * prompt no longer waits for `dispose()` to clear it. A window that closes
   * first disposes this controller, which answers every prompt still open.
   */
  request(input: DesktopPromptInput): Effect.Effect<string | undefined> {
    return Effect.callback<string | undefined>((resume) => {
      const requestId = randomUUID();
      this.pending.set(requestId, (value) => resume(Effect.succeed(value)));
      this.post({
        command: DESKTOP_PROMPT_COMMANDS.SHOW,
        requestId,
        title: input.title,
        prompt: input.prompt,
        password: input.password ?? false,
      });
      return Effect.sync(() => {
        this.pending.delete(requestId);
      });
    });
  }

  dispose(): void {
    for (const requestId of this.pending.keys()) {
      this.answer(requestId, undefined);
    }
  }

  private answer(requestId: string, value: string | undefined): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending(value);
  }
}
