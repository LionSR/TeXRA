/**
 * The host interpreter. Each wire operation is one Effect combinator; each
 * branch is a loop that steps its generator, runs what it yields, and feeds
 * the result (or the failure) back. Concurrency, retry, timeout, fail-fast
 * and cancellation are therefore Effect's own semantics, not the script's.
 */
import { Cause, Data, Effect, Exit, Option, Semaphore } from 'effect';

import type { StepReply, WireNode } from './ops';
import { openRealm, type Realm, ScriptFault } from './realm';

/**
 * A failure the script can observe: it surfaces inside the realm as an Error
 * whose `name` is this tag, so `try/catch` and `attempt()` both see it.
 */
export class OpFailure extends Data.TaggedError('OpFailure')<{
  readonly name: 'AgentFailed' | 'TimedOut' | 'Skipped' | (string & {});
  readonly message: string;
}> {}

export interface AgentCall {
  readonly prompt: string;
  readonly options: Record<string, unknown>;
}

export interface WorkflowHost<R> {
  /** Runs one agent() call. Its typed failure becomes `AgentFailed`. */
  readonly runAgent: (
    call: AgentCall,
  ) => Effect.Effect<unknown, { readonly message: string }, R>;
  /** The session's child-run budget: the cap across every branch. */
  readonly concurrency: number;
  /** CPU budget for guest code between two yields. */
  readonly stepBudgetMs?: number;
}

export type ScriptOutcome = OpFailure | ScriptFault;

export const runWorkflow = <R>(
  body: string,
  host: WorkflowHost<R>,
): Effect.Effect<unknown, ScriptOutcome, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const realm = yield* openRealm(body, {
        stepBudgetMs: host.stepBudgetMs ?? 1_000,
      });
      const permits = yield* Semaphore.make(host.concurrency);
      const interpreter = makeInterpreter(realm, host, permits);
      return yield* interpreter.runBranch(realm.main);
    }),
  );

const makeInterpreter = <R>(
  realm: Realm,
  host: WorkflowHost<R>,
  permits: Semaphore.Semaphore,
) => {
  const runBranch = (fn: number): Effect.Effect<unknown, ScriptOutcome, R> =>
    Effect.gen(function* () {
      const id = yield* realm.start(fn);
      let input: Parameters<Realm['resume']>[1] = { kind: 'next', value: null };
      for (;;) {
        const reply: Exclude<StepReply, { kind: 'started' }> =
          yield* realm.resume(id, input);
        switch (reply.kind) {
          case 'done':
            return reply.value;
          case 'threw':
            // An uncaught throw fails this branch the way a failed operation
            // would; the parent's yield* sees the same name.
            return yield* new OpFailure({
              name: reply.name,
              message: reply.message,
            });
          case 'op': {
            const exit: Exit.Exit<unknown, ScriptOutcome> = yield* Effect.exit(
              runNode(reply.op),
            );
            if (Exit.isSuccess(exit)) {
              input = { kind: 'next', value: exit.value };
              continue;
            }
            // Only a script-observable failure goes back into the realm.
            // Interruption and run-level faults end the run from here.
            const failure: Option.Option<ScriptOutcome> = Cause.findErrorOption(
              exit.cause,
            );
            if (Option.isSome(failure) && failure.value._tag === 'OpFailure') {
              input = {
                kind: 'throw',
                name: failure.value.name,
                message: failure.value.message,
              };
              continue;
            }
            return yield* Effect.failCause(exit.cause);
          }
        }
      }
    });

  const runNode = (
    node: WireNode,
  ): Effect.Effect<unknown, ScriptOutcome, R> => {
    switch (node._tag) {
      case 'Branch':
        return runBranch(node.fn);
      case 'Agent':
        return permits
          .withPermit(
            Effect.suspend(() =>
              host.runAgent({ prompt: node.prompt, options: node.options }),
            ),
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new OpFailure({ name: 'AgentFailed', message: error.message }),
            ),
          );
      case 'All':
        // Fail-fast: the first failure interrupts the siblings still running.
        return Effect.forEach(node.items, runNode, {
          concurrency: Math.min(
            node.concurrency ?? host.concurrency,
            host.concurrency,
          ),
        });
      case 'Attempt':
        return runNode(node.body).pipe(
          Effect.map((value) => ({ _tag: 'Success', value })),
          Effect.catchTag('OpFailure', (failure) =>
            Effect.succeed({
              _tag: 'Failure',
              error: { name: failure.name, message: failure.message },
            }),
          ),
        );
      case 'Retry':
        return runNode(node.body).pipe(
          Effect.retry({
            times: node.times ?? 1,
            while: (error) => error._tag === 'OpFailure',
          }),
        );
      case 'Timeout':
        return runNode(node.body).pipe(
          Effect.timeoutOrElse({
            duration: node.ms,
            orElse: () =>
              Effect.fail(
                new OpFailure({
                  name: 'TimedOut',
                  message: `Timed out after ${node.ms}ms`,
                }),
              ),
          }),
        );
    }
  };

  return { runBranch };
};
