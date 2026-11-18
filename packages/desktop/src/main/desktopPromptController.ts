import { Effect, Fiber, FiberSet, type Scope } from 'effect';
import { RpcClient, type RpcMessage } from 'effect/rpc';

import { withLogChannel } from '@texra-ai/harness/plugins';
import { callOverMessages } from '@texra/shared/rpcOverMessages';
import {
  DESKTOP_PROMPT_COMMANDS,
  DesktopAnswerPromptMessageSchema,
  DesktopPromptRpcs,
} from '../shared/desktopPromptMessages.js';
import type { DesktopPush } from '../shared/desktopOutboundMessages.js';
import { parsedRoute, type DesktopCommandRoutes } from './desktopIpcTypes.js';

interface DesktopPromptInput {
  title: string;
  prompt: string;
  password?: boolean;
}

/**
 * The window's prompts: main's client of the renderer's `DesktopPromptRpcs`,
 * for the window's scope. Every prompt finishes: with the renderer's answer,
 * or with no answer when the window closes or its document reloads
 * (`reset`) first, since nothing else would answer it.
 */
export const makeDesktopPrompts = Effect.fnUntraced(function* (
  post: (message: DesktopPush) => void,
): Effect.fn.Return<
  {
    readonly routes: DesktopCommandRoutes;
    readonly request: (
      input: DesktopPromptInput,
    ) => Effect.Effect<string | undefined>;
    readonly reset: Effect.Effect<void>;
  },
  never,
  Scope.Scope
> {
  const { protocol, receive } = yield* callOverMessages((message) =>
    Effect.sync(() =>
      post({
        command: DESKTOP_PROMPT_COMMANDS.SHOW,
        // cast: `rpc`'s messages are plain objects.
        message: message as unknown as Record<string, unknown>,
      }),
    ),
  );
  const client = yield* RpcClient.make(DesktopPromptRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  );
  const asking = yield* FiberSet.make<string | null, unknown>();
  return {
    routes: {
      [DESKTOP_PROMPT_COMMANDS.ANSWER]: parsedRoute(
        DesktopAnswerPromptMessageSchema,
        ({ message }) =>
          // cast: `rpc` reads its own message, and a reply for no call in
          // flight (one whose asker gave up) it drops.
          receive(message as unknown as RpcMessage.FromServerEncoded),
      ),
    },
    request: ({ title, prompt, password }) =>
      FiberSet.run(
        asking,
        client.prompt({ title, prompt, password: password ?? false }),
      ).pipe(
        // An asker that gives up takes its call with it.
        Effect.flatMap((call) =>
          Fiber.join(call).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(call)),
          ),
        ),
        Effect.map((value) => value ?? undefined),
        // Ended by a reset or the window's close (or a renderer that could
        // not answer): no answer.
        Effect.catchCause((cause) =>
          Effect.logDebug('A prompt ended with no answer').pipe(
            Effect.annotateLogs({ data: cause }),
            withLogChannel('desktop'),
            Effect.as(undefined),
          ),
        ),
      ),
    reset: FiberSet.clear(asking),
  };
});
