import { Cause, Data, Effect, Exit, Option } from 'effect';

import {
  openWorkflowRealm,
  type BranchInput,
  type BranchStep,
  type SandboxHostBridge,
  type WorkflowOperation,
  type WorkflowRealm,
} from './sandbox';

/** The operation failures a script can observe; nothing else is catchable. */
type OpFailureName = 'AgentFailed' | 'TimedOut' | 'Skipped';
const OP_FAILURE_NAMES: ReadonlySet<string> = new Set<OpFailureName>([
  'AgentFailed',
  'TimedOut',
  'Skipped',
]);
const isOpFailureName = (name: string): name is OpFailureName =>
  OP_FAILURE_NAMES.has(name);

/**
 * A failure the script observes: `yield*` throws it into the script as an
 * Error whose `name` is the failure's name, so `try/catch` and `attempt()`
 * see it and `retry()` re-runs past it. A run-level fault never becomes one.
 */
export class OpFailure extends Data.TaggedError('OpFailure')<{
  readonly name: OpFailureName;
  readonly message: string;
}> {}

const isOpFailure = (error: Error): error is OpFailure =>
  error instanceof OpFailure;

/**
 * The call keys one `retry()` has issued, split by attempt. A re-attempt may
 * issue a key again that an earlier attempt issued (the duplicate-key check
 * admits it, and a completed call replays); a key issued twice within one
 * attempt is still a duplicate.
 */
export interface RetryFrame {
  readonly earlier: Set<string>;
  current: Set<string>;
}

interface WorkflowInterpreterHost<R> {
  readonly body: string;
  readonly bridge: SandboxHostBridge;
  readonly filename: string;
  /** The run's wall clock. At the deadline `onTimeout` records the run's
   *  fault; a step still running then is preempted after it records it. */
  readonly timeoutMs: number;
  readonly onTimeout: () => void;
  /** The session's child-run budget; also the cap on one all()'s items. */
  readonly concurrency: number;
  /** One journaled agent() call, under the retry() frames that enclose it. */
  readonly agent: (
    prompt: string,
    options: unknown,
    retries: readonly RetryFrame[],
  ) => Effect.Effect<unknown, Error, R>;
}

/**
 * Runs a workflow body to its result. The script never executes work: it
 * yields operations as data, and each one runs here as the Effect combinator
 * it names, so concurrency, retry, timeout, fail-fast and cancellation are
 * Effect's own semantics rather than the script's.
 */
export function interpretWorkflow<R>(
  host: WorkflowInterpreterHost<R>,
): Effect.Effect<unknown, Error, R> {
  /**
   * One branch: step its generator, run the operation it yields, and feed
   * back the value or the operation failure. A failed operation the branch
   * does not catch fails the branch with the same name; any other throw is a
   * script fault that ends the run, which attempt() and retry() never see.
   */
  const runBranch = (
    realm: WorkflowRealm,
    branch: number,
    retries: readonly RetryFrame[],
  ): Effect.Effect<unknown, Error, R> =>
    Effect.gen(function* () {
      const generator = yield* realm.start(branch);
      let input: BranchInput = { kind: 'next', value: undefined };
      for (;;) {
        const step: BranchStep = yield* realm.resume(generator, input);
        if (step.kind === 'done') return step.value;
        if (step.kind === 'threw') {
          if (isOpFailureName(step.name)) {
            return yield* new OpFailure({
              name: step.name,
              message: step.message,
            });
          }
          // Guest stack frames locate the failure inside the script, the only
          // context a caller has for a sandboxed error.
          const frames = (step.stack ?? '')
            .split('\n')
            .filter((line) => line.trim().startsWith('at '))
            .slice(0, 3);
          const fault = new Error([step.message, ...frames].join('\n'));
          fault.name = step.name;
          return yield* Effect.fail(fault);
        }
        const exit: Exit.Exit<unknown, Error> = yield* Effect.exit(
          runOperation(realm, step.op, retries),
        );
        if (Exit.isSuccess(exit)) {
          input = { kind: 'next', value: exit.value };
          continue;
        }
        const failure: Option.Option<Error> = Cause.findErrorOption(exit.cause);
        if (Option.isSome(failure) && isOpFailure(failure.value)) {
          input = {
            kind: 'throw',
            name: failure.value.name,
            message: failure.value.message,
          };
          continue;
        }
        return yield* Effect.failCause(exit.cause);
      }
    });

  const runOperation = (
    realm: WorkflowRealm,
    operation: WorkflowOperation,
    retries: readonly RetryFrame[],
  ): Effect.Effect<unknown, Error, R> => {
    switch (operation._tag) {
      case 'Branch':
        return runBranch(realm, operation.branch, retries);
      case 'Agent':
        return host.agent(operation.prompt, operation.options, retries);
      case 'All':
        // Fail-fast: the first failure interrupts the siblings still running.
        // The item cap is this all()'s own bound; the permits inside agent()
        // are the session's, shared by every branch.
        return Effect.forEach(
          operation.items,
          (item) => runOperation(realm, item, retries),
          {
            concurrency: Math.min(
              operation.concurrency ?? host.concurrency,
              host.concurrency,
            ),
          },
        );
      case 'Attempt':
        return runOperation(realm, operation.body, retries).pipe(
          Effect.map((value) => ({ _tag: 'Success', value })),
          Effect.catchIf(isOpFailure, (failure) =>
            Effect.succeed({
              _tag: 'Failure',
              error: { name: failure.name, message: failure.message },
            }),
          ),
        );
      case 'Retry': {
        const frame: RetryFrame = { earlier: new Set(), current: new Set() };
        return Effect.suspend(() => {
          for (const key of frame.current) frame.earlier.add(key);
          frame.current = new Set();
          return runOperation(realm, operation.body, [...retries, frame]);
        }).pipe(
          // A skip is the user's verdict on the call, not a transient failure,
          // so retry() does not re-run past it.
          Effect.retry({
            times: operation.times ?? 1,
            while: (error) => isOpFailure(error) && error.name !== 'Skipped',
          }),
        );
      }
      case 'Timeout':
        return runOperation(realm, operation.body, retries).pipe(
          Effect.timeoutOrElse({
            duration: operation.ms,
            orElse: () =>
              Effect.fail(
                new OpFailure({
                  name: 'TimedOut',
                  message: `Timed out after ${operation.ms}ms.`,
                }),
              ),
          }),
        );
    }
  };

  return Effect.gen(function* () {
    const deadline = performance.now() + host.timeoutMs;
    yield* Effect.sync(host.onTimeout).pipe(
      Effect.delay(host.timeoutMs),
      Effect.forkScoped,
    );
    const realm = yield* openWorkflowRealm(host.body, host.bridge, {
      filename: host.filename,
      shouldInterrupt: () => {
        if (performance.now() < deadline) return false;
        host.onTimeout();
        return true;
      },
    });
    return yield* runBranch(realm, realm.main, []);
  }).pipe(
    Effect.catchIf(isOpFailure, (failure) =>
      Effect.fail(
        new Error(
          `Uncaught ${failure.name} in the workflow script: ${failure.message} Wrap the operation in attempt() or try/catch to continue past it.`,
        ),
      ),
    ),
    Effect.scoped,
  );
}
