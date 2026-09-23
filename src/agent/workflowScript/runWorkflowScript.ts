import { basename } from 'node:path';

import stableStringify from 'safe-stable-stringify';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Result,
  Scope,
  Semaphore,
} from 'effect';
import type {
  RunId,
  RunOutcome,
  WorkflowCallIdentity,
  WorkflowControlAction,
} from '@shared/schemas';
import {
  RUN_OUTCOME,
  WORKFLOW_CALL_KIND,
  WORKFLOW_CALL_STATUS,
  WorkflowScriptFilesSchema,
} from '@shared/schemas';
import { isNonEmptyString } from '@utils/text/stringUtils';
import { truncatedHexId } from '@utils/core/idHash';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { parseWorkflowScript } from './parseScript';
import { runScriptInSandbox } from './sandbox';
import { WorkflowRunState } from './workflowRunState';
import {
  WORKFLOW_SKIPPED_RESULT,
  WorkflowAgentCallOptionsSchema,
  WorkflowScriptPhaseTitleSchema,
  type WorkflowAgentCallOptions,
  type WorkflowJournalEntry,
  type WorkflowScriptControl,
  type WorkflowScriptRunOptions,
  type WorkflowScriptRunResult,
} from './types';

/**
 * Stable run identity for one agent() call. Current keys exclude
 * display-only labels and phases, so editing a declarative task plan does not
 * invalidate otherwise identical completed work. A prior entry with a
 * matching key replays its cached result wherever the call now sits in the
 * script. sha256 (truncated) makes a collision that replays the wrong result
 * impractical.
 */
function journalKey(
  prompt: string,
  options: WorkflowAgentCallOptions,
  dependencyFingerprint?: string,
): string {
  const runOptions: WorkflowAgentCallOptions = { ...options };
  delete runOptions.label;
  delete runOptions.phase;
  // Typed binding so safe-stable-stringify resolves to its string-returning
  // overload; an object input never yields undefined.
  const source: object = {
    options: runOptions,
    prompt,
    dependencyFingerprint,
  };
  return truncatedHexId(stableStringify(source), 16);
}

// Library fallback only: the TeXRA host passes the session's child-run budget
// (`resolveChildRunConcurrencyBudget`) as `concurrency`, so this value
// governs no product run.
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_AGENT_CALLS = 200;
const MAX_FANOUT = 512;
const LABEL_EXCERPT_LENGTH = 80;

/** The two statuses a failed attempt can terminalize a call with. */
type WorkflowFailedCallStatus =
  typeof WORKFLOW_CALL_STATUS.FAILED | typeof WORKFLOW_CALL_STATUS.CANCELLED;

/**
 * A host gesture on one in-flight attempt, as the attempt's decision reads
 * it: the action, and the live child it named (what a retry supersedes).
 */
interface WorkflowControlGesture {
  readonly action: WorkflowControlAction;
  readonly target: RunId;
}

/**
 * Control-plane state for one in-flight `agent()` attempt. `decision` is
 * completed exactly once: by the host's gesture, or with `undefined` when the
 * runner settles first. Whichever lands first is what the attempt does, and a
 * gesture arriving after the runner settled finds it closed.
 */
interface InFlightAgentCall {
  /** The call's journal key: what a supersession of this attempt is filed
   *  under. Mutable because a queued file-backed call can change identity
   *  while it waits for a permit. */
  key: string;
  readonly decision: Deferred.Deferred<WorkflowControlGesture | undefined>;
}

/**
 * The fan-out primitive, defined INSIDE the sandbox realm (trusted prelude,
 * compiled by the host, run before the script body). They must not live
 * host-side: parallel consumes script-created arrays and thunks, and any host
 * code that calls a method on a
 * sandbox array (`thunks.map(hostCb)`) or awaits a sandbox thenable hands
 * the script a host-realm function whose .constructor is the host's
 * ungated Function constructor. Realm-side, every callback and resolve
 * function a script can capture is realm-local and codegen-gated.
 *
 * agent() and log() are the bridged globals installed before this prelude
 * runs; concurrency, journaling, and the call cap all stay host-side in
 * agentPrimitive.
 */
const ORCHESTRATION_PRELUDE = `
'use strict';
(() => {
  const MAX_FANOUT = ${MAX_FANOUT};
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, {
      value,
      writable: false,
      configurable: false,
    });
  define('parallel', async function parallel(thunks) {
    if (!Array.isArray(thunks)) {
      throw new Error(
        'parallel(thunks) requires an array of zero-arg functions.',
      );
    }
    if (thunks.length > MAX_FANOUT) {
      throw new Error('parallel() accepts at most ' + MAX_FANOUT + ' items.');
    }
    return Promise.all(
      thunks.map((thunk, i) => {
        if (typeof thunk !== 'function') {
          throw new Error('parallel(): item ' + i + ' is not a function.');
        }
        return thunk();
      }),
    );
  });
})();
`;

/**
 * Thrown when the whole run must stop, and the reason every run-level abort
 * carries. The realm-side agent() primitive recognizes it by name and rethrows
 * instead of converting it to null; parallel() then propagates that rejected
 * call through Promise.all.
 *
 * The first fault a run records is the run's outcome; every later abort is a
 * consequence of it and keeps the first. The error crosses the sandbox realm
 * boundary as a realm-local copy carrying just name and message, so anything
 * classifying an error that may have crossed uses the name (isWorkflowAbort).
 */
export class WorkflowRunAbortError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkflowRunAbortError';
  }
}

function isWorkflowAbort(error: unknown): boolean {
  // Name check, not instanceof: abort errors re-enter host code as
  // realm-local Error copies whose prototype chain is the sandbox's.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'WorkflowRunAbortError'
  );
}

/**
 * The one outcome of an attempt that is not the call's value: the host asked
 * for another attempt, so the call runs again under a fresh scope.
 */
const RETRY_ATTEMPT = Symbol('workflowScript.retryAttempt');

function asWorkflowAbort(error: unknown): WorkflowRunAbortError {
  return error instanceof WorkflowRunAbortError
    ? error
    : new WorkflowRunAbortError(toErrorMessage(error), { cause: error });
}

/**
 * Runs a workflow script: deterministic JS orchestration over host-executed
 * agents. The script's control flow (loops, fan-out, joins, reduction) runs
 * as plain code with zero model round-trips between steps; every agent()
 * call is bounded by one shared Effect semaphore and journaled for
 * resume (same prompt/run options → cached result, at any position).
 *
 * Cancellation is interruption. Every agent() call is a fiber the sandbox
 * owns, so when the sandbox ends (result, timeout, or interrupted by the
 * first run-level fault or by the caller) its in-flight calls are interrupted
 * and awaited, an admitted journal commit reaching its durability point
 * first, before the terminal sweep settles the cards.
 */
export function runWorkflowScript<R = never>(
  options: WorkflowScriptRunOptions<R>,
): Effect.Effect<WorkflowScriptRunResult, Error, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const {
        runAgent,
        toScriptValue,
        fingerprintAgentDependencies,
        onEvent,
        onJournalEntry,
        onSupersededAttempt,
        onJournalEntryConsumed,
        onControl,
      } = options;
      const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
      const maxAgentCalls = options.maxAgentCalls ?? DEFAULT_MAX_AGENT_CALLS;
      const { meta, body } = yield* Effect.try({
        try: () => parseWorkflowScript(options.script),
        catch: (cause) => new Error(toErrorMessage(cause), { cause }),
      });
      const timeoutMs =
        options.timeoutMs ?? meta.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const priorEntries = new Map<string, WorkflowJournalEntry>(
        (options.journal ?? []).map((entry) => [entry.key, entry]),
      );

      const journal = new Map<number, WorkflowJournalEntry>();
      // The run's first fault is its outcome; every later one is a
      // consequence of it. The Deferred keeps the first and drops the rest.
      const fatalFault = yield* Deferred.make<never, WorkflowRunAbortError>();
      const recordFault = (
        fault: WorkflowRunAbortError,
      ): WorkflowRunAbortError => {
        Deferred.doneUnsafe(fatalFault, Effect.fail(fault));
        return fault;
      };
      /** Record `fault` unless the run already has one, and fail with the
       *  run's first. */
      const failRun = (
        fault: WorkflowRunAbortError,
      ): Effect.Effect<never, WorkflowRunAbortError> =>
        Effect.suspend(() => {
          recordFault(fault);
          return Deferred.await(fatalFault);
        });
      /** Fail with the run's first fault once one is recorded. */
      const checkRun: Effect.Effect<void, WorkflowRunAbortError> =
        Effect.suspend(() =>
          Deferred.isDoneUnsafe(fatalFault)
            ? Deferred.await(fatalFault)
            : Effect.void,
        );
      const contractFault = (
        error: unknown,
      ): Effect.Effect<never, WorkflowRunAbortError> =>
        failRun(asWorkflowAbort(error));

      const permits = yield* Semaphore.make(concurrency);
      const inFlightCalls = new Map<RunId, InFlightAgentCall>();
      let liveCallCounter = 0;
      let callCounter = 0;
      const issuedCallKeys = new Set<string>();
      const plannedPhases = meta.phases ?? [];
      const hasTaskPlan = meta.tasks !== undefined;
      const plannedTasks = meta.tasks ?? [];
      const plannedTasksById = new Map(
        plannedTasks.map((task) => [task.id, task]),
      );
      const workflowRunState = yield* Effect.try({
        try: () =>
          new WorkflowRunState({
            phases: plannedPhases,
            tasks: plannedTasks,
            emit: (event) => onEvent?.(event),
          }),
        catch: (cause) => new Error(toErrorMessage(cause), { cause }),
      });
      // The terminal sweep. It runs as the scope closes, after the sandbox
      // has ended and with it every agent() fiber, so no call can still
      // transition beneath it.
      yield* Effect.addFinalizer((exit) =>
        Effect.sync(() => {
          const interrupted =
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
          let terminalOutcome: RunOutcome = RUN_OUTCOME.FAILED;
          if (Exit.isSuccess(exit)) {
            terminalOutcome = RUN_OUTCOME.COMPLETED;
          } else if (interrupted) {
            terminalOutcome = RUN_OUTCOME.CANCELLED;
          }
          workflowRunState.finish(
            terminalOutcome,
            Exit.isFailure(exit) && !interrupted
              ? toErrorMessage(Cause.squash(exit.cause))
              : undefined,
          );
        }),
      );

      const control: WorkflowScriptControl = (childRunId, action) => {
        const call = inFlightCalls.get(childRunId);
        return (
          call !== undefined &&
          Deferred.doneUnsafe(
            call.decision,
            Effect.succeed({ action, target: childRunId }),
          )
        );
      };
      onControl?.(control);

      const persistJournalEntry = (
        entry: WorkflowJournalEntry,
      ): Effect.Effect<void, WorkflowRunAbortError, R> =>
        Effect.suspend(() => onJournalEntry?.(entry) ?? Effect.void).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              journal.set(entry.index, entry);
            }),
          ),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            return Effect.fail(
              new WorkflowRunAbortError(
                `Failed to persist workflow journal entry ${entry.index}: ${toErrorMessage(error)}`,
                { cause: error },
              ),
            );
          }),
        );

      const agentPrimitive = (
        prompt: unknown,
        rawOptions?: unknown,
      ): Effect.Effect<string | undefined, Error, R> =>
        Effect.gen(function* () {
          yield* checkRun;
          if (!isNonEmptyString(prompt)) {
            return yield* Effect.fail(
              new Error(
                'agent(prompt, options?) requires a non-empty string prompt.',
              ),
            );
          }

          const parsedOptions = WorkflowAgentCallOptionsSchema.safeParse(
            rawOptions ?? {},
          );
          if (!parsedOptions.success) {
            return yield* contractFault(
              new Error(parsedOptions.error.issues[0].message),
            );
          }
          const callOptions: WorkflowAgentCallOptions = parsedOptions.data;
          const index = callCounter++;

          let plannedTask: WorkflowCallIdentity | undefined;
          if (hasTaskPlan) {
            if (!callOptions.id) {
              return yield* failRun(
                new WorkflowRunAbortError(
                  'Every agent() call must reference a task from meta.tasks with a non-empty "id" option.',
                ),
              );
            }
            plannedTask = plannedTasksById.get(callOptions.id);
            if (!plannedTask) {
              return yield* failRun(
                new WorkflowRunAbortError(
                  `agent() references undeclared task id "${callOptions.id}".`,
                ),
              );
            }
            if (
              (callOptions.label !== undefined &&
                callOptions.label !== plannedTask.label) ||
              (callOptions.phase !== undefined &&
                callOptions.phase !== plannedTask.phase)
            ) {
              return yield* failRun(
                new WorkflowRunAbortError(
                  `Task "${callOptions.id}" must use the label and phase declared in meta.tasks.`,
                ),
              );
            }
            callOptions.label = plannedTask.label;
            callOptions.phase = plannedTask.phase;
          } else {
            callOptions.phase ??= workflowRunState.currentPhase;
          }

          const primaryFile =
            callOptions.inputFiles?.[0] ?? callOptions.contextFiles?.[0];
          const role = callOptions.agentName ?? 'Agent';
          const promptExcerpt = prompt
            .slice(0, LABEL_EXCERPT_LENGTH)
            .replaceAll(/\s+/g, ' ')
            .trim();
          const label =
            plannedTask?.label ??
            callOptions.label ??
            (primaryFile ? `${basename(primaryFile)}: ${role}` : undefined) ??
            (promptExcerpt === '' ? undefined : promptExcerpt) ??
            `${role} ${index + 1}`;
          const hasFileDependencies =
            (callOptions.inputFiles?.length ?? 0) > 0 ||
            (callOptions.contextFiles?.length ?? 0) > 0 ||
            (callOptions.mediaFiles?.length ?? 0) > 0;
          if (
            hasFileDependencies &&
            fingerprintAgentDependencies === undefined
          ) {
            return yield* failRun(
              new WorkflowRunAbortError(
                'The workflow host must fingerprint agent() file dependencies before they can be resumed safely.',
              ),
            );
          }

          const missingFingerprint = (): WorkflowRunAbortError =>
            new WorkflowRunAbortError(
              'The workflow host returned no fingerprint for agent() file dependencies.',
            );
          const readDependencyFingerprint = (): Effect.Effect<
            string,
            WorkflowRunAbortError,
            R
          > =>
            Effect.suspend(
              () =>
                fingerprintAgentDependencies?.(callOptions) ??
                Effect.fail(missingFingerprint()),
            ).pipe(
              Effect.flatMap((fingerprint) =>
                isNonEmptyString(fingerprint)
                  ? Effect.succeed(fingerprint)
                  : Effect.fail(missingFingerprint()),
              ),
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) {
                  return Effect.failCause(cause as Cause.Cause<never>);
                }
                const error = Cause.squash(cause);
                return failRun(
                  error instanceof WorkflowRunAbortError
                    ? error
                    : new WorkflowRunAbortError(
                        `Workflow agent() file dependencies could not be fingerprinted: ${toErrorMessage(error)}`,
                        { cause: error },
                      ),
                );
              }),
            );

          let dependencyFingerprint = hasFileDependencies
            ? yield* readDependencyFingerprint()
            : undefined;
          let key = journalKey(prompt, callOptions, dependencyFingerprint);
          const progressId =
            plannedTask?.id ?? callOptions.id ?? `call-${index}`;
          const prior = priorEntries.get(key);

          yield* Effect.try({
            try: () => {
              if (
                callOptions.phase !== undefined &&
                workflowRunState.currentPhaseIndex === -1
              ) {
                workflowRunState.enterStage(callOptions.phase);
              }
              workflowRunState.issueCall({
                id: progressId,
                label,
                phase: callOptions.phase,
                kind:
                  callOptions.schema === undefined
                    ? WORKFLOW_CALL_KIND.DOCUMENT
                    : WORKFLOW_CALL_KIND.STRUCTURED,
                agent: callOptions.agentName,
                model: callOptions.model,
                files: {
                  input: (callOptions.inputFiles ?? []).map((file) =>
                    basename(file),
                  ),
                  context: (callOptions.contextFiles ?? []).map((file) =>
                    basename(file),
                  ),
                  media: (callOptions.mediaFiles ?? []).map((file) =>
                    basename(file),
                  ),
                },
              });
            },
            catch: (error) => error,
          }).pipe(Effect.catch(contractFault));

          if (issuedCallKeys.has(key)) {
            return yield* failRun(
              new WorkflowRunAbortError(
                'Repeated agent() calls with the same prompt and run options require distinct non-empty "id" options for restart-safe identity.',
              ),
            );
          }
          issuedCallKeys.add(key);

          const refreshDependencyIdentity = (): Effect.Effect<
            void,
            WorkflowRunAbortError,
            R
          > =>
            !hasFileDependencies
              ? Effect.void
              : Effect.gen(function* () {
                  const refreshedFingerprint =
                    yield* readDependencyFingerprint();
                  if (refreshedFingerprint === dependencyFingerprint) {
                    return;
                  }
                  const refreshedKey = journalKey(
                    prompt,
                    callOptions,
                    refreshedFingerprint,
                  );
                  if (issuedCallKeys.has(refreshedKey)) {
                    return yield* failRun(
                      new WorkflowRunAbortError(
                        'A changed agent() file dependency now conflicts with another call identity; rerun the workflow from its saved script.',
                      ),
                    );
                  }
                  issuedCallKeys.delete(key);
                  issuedCallKeys.add(refreshedKey);
                  dependencyFingerprint = refreshedFingerprint;
                  key = refreshedKey;
                });

          const failCall = (
            error: unknown,
            status: WorkflowFailedCallStatus = WORKFLOW_CALL_STATUS.FAILED,
          ): void => {
            workflowRunState.settleCall(
              progressId,
              status === WORKFLOW_CALL_STATUS.CANCELLED
                ? { status }
                : { status, error: toErrorMessage(error) },
            );
          };

          /** The journaled form of a runner result and what the script sees
           *  of it. A result that cannot cross the bridge fails the call with
           *  its real cause, then the run. */
          const journalValue = (
            value: unknown,
            valueLabel: string,
          ): Effect.Effect<
            { payload: string | undefined; normalizedResult: unknown },
            WorkflowRunAbortError
          > =>
            Effect.try({
              try: () => {
                const journalPayload = serializeBridgeValue(value, valueLabel);
                const normalizedResult =
                  journalPayload === undefined
                    ? undefined
                    : JSON.parse(journalPayload);
                const payload =
                  toScriptValue === undefined
                    ? journalPayload
                    : serializeBridgeValue(
                        toScriptValue(normalizedResult),
                        valueLabel,
                      );
                return { payload, normalizedResult };
              },
              catch: asWorkflowAbort,
            }).pipe(
              // Settle the call with its real bridge failure before waking
              // the run-level fatal race, which interrupts this fiber.
              Effect.tapError((fault) => Effect.sync(() => failCall(fault))),
              Effect.catch(failRun),
            );

          if (prior) {
            const { payload, normalizedResult } = yield* journalValue(
              prior.result,
              'Cached agent() result',
            );
            const entry = {
              index,
              key,
              result: normalizedResult,
            };
            journal.set(index, entry);
            workflowRunState.settleCall(progressId, {
              status: WORKFLOW_CALL_STATUS.CACHED,
            });
            onJournalEntryConsumed?.(entry);
            return payload;
          }

          // One attempt. Its scope is closed only after the journal write
          // below: the runner fences the child it recovered or superseded
          // into it, and a fence that ended at the runner's return would
          // leave that child free to be resumed — appending `run.activate`
          // and working on — while this call is still persisting the value
          // read from it. The engine owns the scope because the engine owns
          // the commit.
          const attempt = Effect.scopedWith((attemptScope) =>
            Effect.gen(function* () {
              const call: InFlightAgentCall = {
                key,
                decision: yield* Deferred.make<
                  WorkflowControlGesture | undefined
                >(),
              };
              const runner = permits.withPermit(
                Effect.gen(function* () {
                  yield* checkRun;
                  liveCallCounter += 1;
                  if (liveCallCounter > maxAgentCalls) {
                    const fault = new WorkflowRunAbortError(
                      `Workflow exceeded the ${maxAgentCalls} live agent-call cap (runaway-loop backstop; journal replays are free).`,
                    );
                    // Record the refused call before waking the run-level
                    // fatal race, which immediately interrupts this fiber.
                    failCall(fault);
                    return yield* failRun(fault);
                  }
                  workflowRunState.beginAttempt(progressId);
                  yield* refreshDependencyIdentity();
                  // A queued file-backed call may have changed identity
                  // while waiting for this permit. Retry authorization is
                  // filed through the live call record, so update it before
                  // the child can report an id and become controllable.
                  call.key = key;
                  const value = yield* runAgent({
                    index,
                    progressId,
                    key,
                    prompt,
                    options: callOptions,
                    report: ({ recovered, ...attemptFacts }) => {
                      if (
                        attemptFacts.childRunId !== undefined &&
                        recovered !== true
                      ) {
                        inFlightCalls.set(attemptFacts.childRunId, call);
                      }
                      workflowRunState.reportAttempt(progressId, attemptFacts);
                    },
                  }).pipe(Scope.provide(attemptScope));
                  // Give the durable writer a turn while the call is still
                  // in its running state, even when the runner completed at
                  // once.
                  yield* Effect.yieldNow;
                  return value;
                }),
              );
              // Scheduled, not started: the runner launches on a later
              // scheduler turn, so a run that settles in the turn that issued
              // this call launches nothing.
              const runnerFiber = yield* Effect.forkChild(runner);
              // Interrupting the attempt, at any point, stops the runner
              // before the attempt's scope releases the fences it holds.
              return yield* Effect.gen(function* () {
                // The runner settling and the host's gesture race for the
                // decision; closing it afterwards keeps whichever landed first
                // and refuses a later gesture.
                yield* Effect.raceFirst(
                  Effect.asVoid(Fiber.await(runnerFiber)),
                  Effect.asVoid(Deferred.await(call.decision)),
                );
                yield* Deferred.succeed(call.decision, undefined);
                const gesture = yield* Deferred.await(call.decision);
                for (const [childRunId, inFlight] of inFlightCalls) {
                  if (inFlight === call) inFlightCalls.delete(childRunId);
                }

                if (gesture?.action === 'retry') {
                  // A retry is an authorized supersession, and the child it
                  // interrupts may already have accepted a turn — the shape
                  // every recovery rule refuses to repeat. The authorization is
                  // journaled before the interrupt, so the runner's probe
                  // advances past the superseded child instead of aborting the
                  // workflow over it, and a host that dies between the two
                  // resumes on the same fact. A failed write still interrupts,
                  // and fails the workflow here, where the replacement would be
                  // asked for.
                  const authorized = yield* Effect.exit(
                    Effect.uninterruptible(
                      Effect.suspend(
                        () =>
                          onSupersededAttempt?.({
                            key: call.key,
                            childRunId: gesture.target,
                          }) ?? Effect.void,
                      ),
                    ),
                  );
                  yield* Fiber.interrupt(runnerFiber);
                  if (Exit.isFailure(authorized)) {
                    const failure = ensureError(Cause.squash(authorized.cause));
                    const fault = new WorkflowRunAbortError(
                      `Failed to journal the retry of workflow child ${gesture.target}: ${toErrorMessage(failure)}`,
                      { cause: failure },
                    );
                    failCall(fault);
                    return yield* failRun(fault);
                  }
                  workflowRunState.queueCall(progressId, {
                    model: callOptions.model,
                  });
                  return RETRY_ATTEMPT;
                }
                if (gesture?.action === 'skip') {
                  yield* Fiber.interrupt(runnerFiber);
                  workflowRunState.settleCall(progressId, {
                    status: WORKFLOW_CALL_STATUS.SKIPPED,
                  });
                  return JSON.stringify(WORKFLOW_SKIPPED_RESULT);
                }

                const attemptExit = yield* Fiber.await(runnerFiber);
                if (Exit.isFailure(attemptExit)) {
                  const error = Cause.squash(attemptExit.cause);
                  if (isWorkflowAbort(error)) {
                    const fault = asWorkflowAbort(error);
                    failCall(fault);
                    return yield* failRun(fault);
                  }
                  failCall(error, WORKFLOW_CALL_STATUS.FAILED);
                  // Let the writer observe this failed call while its stage is
                  // still active before guest code can launch the next call.
                  yield* Effect.yieldNow;
                  return 'null';
                }

                const { payload, normalizedResult } = yield* journalValue(
                  attemptExit.value,
                  'agent() result',
                );
                const entry = { index, key, result: normalizedResult };
                yield* Effect.uninterruptible(
                  persistJournalEntry(entry).pipe(
                    Effect.tapError((error) =>
                      Effect.sync(() => failCall(error)),
                    ),
                    Effect.catch(failRun),
                    Effect.andThen(
                      Effect.sync(() => {
                        workflowRunState.settleCall(progressId, {
                          status: WORKFLOW_CALL_STATUS.COMPLETED,
                        });
                        onJournalEntryConsumed?.(entry);
                      }),
                    ),
                  ),
                );
                return payload;
              }).pipe(Effect.onInterrupt(() => Fiber.interrupt(runnerFiber)));
            }),
          );
          const runCall: Effect.Effect<string | undefined, Error, R> =
            Effect.suspend(() =>
              attempt.pipe(
                Effect.flatMap((outcome) =>
                  outcome === RETRY_ATTEMPT ? runCall : Effect.succeed(outcome),
                ),
              ),
            );
          return yield* runCall;
        });

      const argsJson = yield* Effect.try({
        try: () => serializeBridgeValue(options.args, 'Workflow args'),
        catch: (cause) => new Error(toErrorMessage(cause), { cause }),
      });
      const files = yield* Effect.try({
        try: () => WorkflowScriptFilesSchema.parse(options.files ?? {}),
        catch: (cause) => new Error(toErrorMessage(cause), { cause }),
      });
      const filesJson = stableStringify(files);

      const sandbox = runScriptInSandbox(
        body,
        {
          asyncFns: {
            agent: (args) => agentPrimitive(args[0], args[1]),
          },
          syncFns: {
            log: (args) => {
              onEvent?.({
                type: 'log',
                message: String(args[0]),
              });
              return undefined;
            },
            phase: (args) => {
              const nextPhase = WorkflowScriptPhaseTitleSchema.parse(
                String(args[0]),
              );
              Result.getOrThrow(
                Result.try({
                  try: () => workflowRunState.enterStage(nextPhase),
                  catch: (error) => recordFault(asWorkflowAbort(error)),
                }),
              );
              return undefined;
            },
          },
          argsJson,
          filesJson,
          realmPrelude: ORCHESTRATION_PRELUDE,
        },
        {
          timeoutMs,
          filename: `${meta.name}.workflow.js`,
        },
      );

      // The race awaits the loser's interruption, and the sandbox awaits its
      // agent() fibers as it closes, so past this point no call is running
      // and the first fault, if any, is final.
      const sandboxExit = yield* Effect.exit(
        Effect.raceFirst(sandbox, Deferred.await(fatalFault)),
      );
      yield* checkRun;
      if (Exit.isFailure(sandboxExit)) {
        const failure = Cause.squash(sandboxExit.cause);
        return yield* Effect.fail(
          failure instanceof Error
            ? failure
            : new Error(toErrorMessage(failure), { cause: failure }),
        );
      }

      return {
        result: sandboxExit.value,
        journal: [...journal.values()].toSorted((a, b) => a.index - b.index),
      };
    }),
  );
}

function serializeBridgeValue(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const payload = Result.getOrThrow(
    Result.try({
      try: () => JSON.stringify(value),
      catch: (error) =>
        new Error(
          `${label} must be JSON-serializable: ${toErrorMessage(error)}`,
        ),
    }),
  );
  if (payload === undefined) {
    throw new Error(
      `${label} must be JSON-serializable; functions and symbols are not supported.`,
    );
  }
  return payload;
}
