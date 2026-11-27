import { Effect, Fiber, FiberSet, type Scope } from 'effect';
import { RpcClient } from 'effect/rpc';

import { withLogChannel } from '@texra-ai/worldline/plugins';
import type { InputField } from '@texra/hosts/uiHosts';
import { callOverMessages } from '@texra/shared/rpcOverMessages';
import {
  DESKTOP_PROMPT_COMMANDS,
  DesktopAnswerPromptMessageSchema,
  DesktopPromptRpcs,
} from '../shared/desktopPromptMessages.js';
import type { DesktopPush } from '../shared/desktopOutboundMessages.js';
import { parsedRoute, type DesktopCommandRoutes } from './desktopIpcTypes.js';

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
    readonly request: (field: InputField) => Effect.Effect<string | undefined>;
    readonly reset: Effect.Effect<void>;
  },
  never,
  Scope.Scope
> {
  const { protocol, receive } = yield* callOverMessages((message) =>
    Effect.sync(() => post({ command: DESKTOP_PROMPT_COMMANDS.SHOW, message })),
  );
  const client = yield* RpcClient.make(DesktopPromptRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  );
  const asking = yield* FiberSet.make<string | null, unknown>();
  return {
    routes: {
      [DESKTOP_PROMPT_COMMANDS.ANSWER]: parsedRoute(
        DesktopAnswerPromptMessageSchema,
        // A reply for no call in flight (one whose asker gave up) `rpc`
        // drops.
        ({ message }) => receive(message),
      ),
    },
    request: ({ prompt, secret }) =>
      Effect.acquireUseRelease(
        FiberSet.run(
          asking,
          client.prompt({ prompt, password: secret ?? false }),
        ),
        Fiber.join,
        Fiber.interrupt,
      ).pipe(
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
