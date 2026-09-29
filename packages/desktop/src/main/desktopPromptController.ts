import { randomUUID } from 'node:crypto';

import { Effect } from 'effect';

import {
  DESKTOP_PROMPT_COMMANDS,
  DesktopSettlePromptMessageSchema,
  type DesktopShowPromptMessage,
} from '../shared/desktopPromptMessages.js';
import { parsedRoute, type DesktopCommandRoutes } from './desktopIpcTypes.js';

interface DesktopPromptInput {
  title: string;
  prompt: string;
  password?: boolean;
}

interface DesktopPromptRenderer {
  postToRenderer(message: unknown): boolean;
}

type PromptResolver = (value: string | undefined) => void;

/** Owns correlated desktop prompt requests and their exact settlement. */
export class DesktopPromptController {
  private readonly pending = new Map<string, PromptResolver>();

  /** A settlement for no pending request (a duplicate, or one whose asker
   *  was interrupted) settles nothing. */
  readonly routes: DesktopCommandRoutes = {
    [DESKTOP_PROMPT_COMMANDS.SETTLE]: parsedRoute(
      DesktopSettlePromptMessageSchema,
      ({ requestId, value }) =>
        Effect.sync(() => {
          this.settle(requestId, value ?? undefined);
        }),
    ),
  };

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

  dispose(): void {
    for (const requestId of this.pending.keys()) {
      this.settle(requestId, undefined);
    }
  }

  private settle(requestId: string, value: string | undefined): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending(value);
  }
}
