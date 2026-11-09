import { Context, Deferred, Effect, Layer, Scope } from 'effect';

import { PluginHold } from '@texra-ai/harness/plugins';

/**
 * Claim an agent-CLI thread (a Codex thread, a Claude Code session) for one
 * turn in this session: answers the claim's scope, which the turn closes
 * as it ends, or undefined when a turn here already holds the thread. The
 * provider's SDK holds one turn per thread at a time, so a second call on
 * a claimed thread is refused by the provider's tool; the thread id itself
 * lives with the provider. A standing claim holds its plugin's session
 * services (`PluginHold`): a plugin switched off mid-turn keeps its claims,
 * so a call after it is switched on again still meets them.
 */
export type ClaimThread = (
  threadId: string,
) => Effect.Effect<Scope.Closeable | undefined>;

/**
 * The codex and claude-agent plugins' session services (their plugins'
 * `sessionLayer`): each session's claims on the threads that agent CLI has
 * a turn running on, so the claims die with their session instead of
 * living as a process singleton.
 */
export class CodexThreads extends Context.Service<CodexThreads, ClaimThread>()(
  '@texra-ai/texra/tools/CodexThreads',
) {}

export class ClaudeAgentSessions extends Context.Service<
  ClaudeAgentSessions,
  ClaimThread
>()('@texra-ai/texra/tools/ClaudeAgentSessions') {}

const claimThread = Effect.gen(function* () {
  const hold = yield* PluginHold;
  const busy = new Set<string>();
  return (threadId: string) =>
    Effect.gen(function* () {
      // Reserve before any yield: interruption is masked by the caller,
      // but another fiber can still run while the scope is being built.
      if (busy.has(threadId)) return undefined;
      busy.add(threadId);
      const claim = yield* Scope.make();
      const ended = yield* Deferred.make<void>();
      yield* Scope.addFinalizer(
        claim,
        Effect.sync(() => busy.delete(threadId)).pipe(
          Effect.andThen(Deferred.succeed(ended, undefined)),
        ),
      );
      yield* hold(Deferred.await(ended));
      return claim;
    });
});

export const codexThreadsLayer = Layer.effect(CodexThreads, claimThread);

export const claudeAgentSessionsLayer = Layer.effect(
  ClaudeAgentSessions,
  claimThread,
);
