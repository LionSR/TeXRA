import { basename } from 'node:path';

import stableStringify from 'safe-stable-stringify';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Queue,
  Result,
  Scope,
  Semaphore,
} from 'effect';
import type {
  RunId,
  RunOutcome,
  WorkflowCallIdentity,
  WorkflowControlAction,
  WorkflowRunSnapshot,
} from '@shared/schemas';
import {
  RUN_OUTCOME,
  WORKFLOW_CALL_KIND,
  WORKFLOW_CALL_STATUS,
  WorkflowScriptFilesSchema,
} from '@shared/schemas';
import { isNonEmptyString, onAbort } from '@utils/core';
import { truncatedHexId } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

/** The two snapshot statuses a failed attempt can terminalize a call with. */
type WorkflowFailedCallStatus =
  typeof WORKFLOW_CALL_STATUS.FAILED | typeof WORKFLOW_CALL_STATUS.CANCELLED;

/**
 * Control-plane state for one in-flight `agent()` attempt: the controller
 * `skip()`/`retry()` aborts, and the action that abort requested. One record so
 * the action can never outlive or precede the attempt it belongs to.
 */
interface InFlightAgentCall {
  readonly index: number;
  fiber?: Fiber.Fiber<unknown, Error>;
  action?: WorkflowControlAction;
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
 * What stopped the run. `settlement-cleanup` is the abort the engine raises
 * itself once the sandbox has settled, and `timeout` mirrors a wall clock the
 * sandbox already reports with a more precise error; both leave the script
 * outcome authoritative. Every other kind is a fault the run must report.
 */
type WorkflowAbortKind =
  | 'cap'
  | 'checkpoint'
  | 'contract'
  | 'runner'
  | 'settlement-cleanup'
  | 'timeout';

/**
 * Thrown when the whole run must stop, and the reason every run-level abort
 * carries. The realm-side agent() primitive recognizes it by name and rethrows
 * instead of converting it to null; parallel() then propagates that rejected
 * call through Promise.all.
 *
 * `kind` is host-only. The error crosses the sandbox realm boundary as a
 * realm-local copy carrying just name and message, so anything classifying an
 * error that may have crossed uses the name (isWorkflowAbort) and only reads
 * `kind` off a reason this host minted. Errors a host runner mints to surface
 * its own fatal condition take the default `runner` kind.
 */
export class WorkflowRunAbortError extends Error {
  readonly kind: WorkflowAbortKind;

  constructor(
    message: string,
    options?: ErrorOptions & { readonly kind?: WorkflowAbortKind },
  ) {
    super(message, options);
    this.name = 'WorkflowRunAbortError';
    this.kind = options?.kind ?? 'runner';
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
 * Whether an abort reason is the run's own outcome. A parent abort keeps the
 * caller's reason and the sandbox rethrows it, a timeout reaches the caller as
 * the sandbox's timeout error, and a settlement cleanup follows a script that
 * already settled, so those three leave the sandbox outcome in place.
 */
function isRunFatalAbort(reason: unknown): reason is WorkflowRunAbortError {
  return (
    reason instanceof WorkflowRunAbortError &&
    reason.kind !== 'timeout' &&
    reason.kind !== 'settlement-cleanup'
  );
}

/**
 * The one outcome of an attempt that is not the call's value: the host asked
 * for another attempt, so the loop runs again under a fresh scope.
 */
const RETRY_ATTEMPT = Symbol('workflowScript.retryAttempt');

class JournalCommitFence {
  #sealed = false;

  commit<E, R>(write: Effect.Effect<void, E, R>): Effect.Effect<boolean, E, R> {
    return Effect.suspend(() =>
      this.#sealed
        ? Effect.succeed(false)
        : Effect.as(Effect.uninterruptible(write), true),
    );
  }

  seal(): void {
    this.#sealed = true;
  }
}

interface SnapshotPublication {
  readonly version: number;
  readonly snapshot: WorkflowRunSnapshot;
  readonly acknowledged: Deferred.Deferred<void, WorkflowRunAbortError>;
}

interface CoalescedSnapshotWriter {
  readonly publish: (snapshot: WorkflowRunSnapshot) => void;
  readonly flush: Effect.Effect<void, WorkflowRunAbortError>;
}

function makeSnapshotWriter<R>(
  write: WorkflowScriptRunOptions<R>['onSnapshot'],
  onFailure: (failure: WorkflowRunAbortError) => void,
): Effect.Effect<CoalescedSnapshotWriter, never, Scope.Scope | R> {
  if (write === undefined) {
    return Effect.succeed({ publish: () => {}, flush: Effect.void });
  }
  return Effect.gen(function* () {
    const publications = yield* Queue.sliding<SnapshotPublication>(1);
    const acknowledgements = new Map<
      number,
      Deferred.Deferred<void, WorkflowRunAbortError>
    >();
    let version = 0;
    let latest: SnapshotPublication | undefined;
    let failure: WorkflowRunAbortError | undefined;

    const completeThrough = (completedVersion: number): void => {
      for (const [candidate, acknowledged] of acknowledgements) {
        if (candidate > completedVersion) continue;
        Deferred.doneUnsafe(acknowledged, Effect.void);
        acknowledgements.delete(candidate);
      }
    };
    const failAll = (cause: unknown): void => {
      failure ??= new WorkflowRunAbortError(
        `Failed to persist workflow run snapshot: ${toErrorMessage(cause)}`,
        { kind: 'checkpoint', cause },
      );
      for (const acknowledged of acknowledgements.values()) {
        Deferred.doneUnsafe(acknowledged, Effect.fail(failure));
      }
      acknowledgements.clear();
      onFailure(failure);
    };

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(publications).pipe(
          Effect.flatMap((publication) =>
            Effect.try({
              try: () => structuredClone(publication.snapshot),
              catch: (cause) => cause,
            }).pipe(
              Effect.flatMap(write),
              Effect.tap(() =>
                Effect.sync(() => completeThrough(publication.version)),
              ),
            ),
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.sync(() => failAll(Cause.squash(cause)));
        }),
      ),
      { startImmediately: true },
    );

    const flush: Effect.Effect<void, WorkflowRunAbortError> = Effect.suspend(
      () => {
        if (failure !== undefined) return Effect.fail(failure);
        const target = latest;
        if (target === undefined) return Effect.void;
        return Deferred.await(target.acknowledged).pipe(
          Effect.andThen(
            Effect.suspend(() => (latest === target ? Effect.void : flush)),
          ),
        );
      },
    );

    return {
      publish(snapshot) {
        if (failure !== undefined) return;
        const acknowledged = Deferred.makeUnsafe<void, WorkflowRunAbortError>();
        latest = { version: ++version, snapshot, acknowledged };
        acknowledgements.set(version, acknowledged);
        Queue.offerUnsafe(publications, latest);
      },
      flush,
    };
  });
}

/**
 * Runs a workflow script: deterministic JS orchestration over host-executed
 * agents. The script's control flow (loops, fan-out, joins, reduction) runs
 * as plain code with zero model round-trips between steps; every agent()
 * call is bounded by one shared Effect semaphore and journaled for
 * resume (same prompt/run options → cached result, at any position).
 *
 * On wall-clock timeout the sandbox preempts guest run, fires the run's
 * AbortSignal (passed to every runAgent invocation), and refuses new calls.
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
      const priorKeysByIndex = new Map<number, Set<string>>();
      for (const entry of options.journal ?? []) {
        const keys = priorKeysByIndex.get(entry.index) ?? new Set<string>();
        keys.add(entry.key);
        priorKeysByIndex.set(entry.index, keys);
      }

      const journal = new Map<number, WorkflowJournalEntry>();
      const fatalFault = yield* Deferred.make<never, WorkflowRunAbortError>();
      let firstFatalFault: WorkflowRunAbortError | undefined;
      const failRun = (fault: WorkflowRunAbortError): WorkflowRunAbortError => {
        if (isRunFatalAbort(fault)) firstFatalFault ??= fault;
        Deferred.doneUnsafe(fatalFault, Effect.fail(firstFatalFault ?? fault));
        return firstFatalFault ?? fault;
      };
      const contractFault = (error: unknown): WorkflowRunAbortError =>
        failRun(
          new WorkflowRunAbortError(toErrorMessage(error), {
            kind: 'contract',
            cause: error,
          }),
        );

      const agentFibers = yield* FiberSet.make<string | undefined, Error>();
      const runGuestAgent = yield* FiberSet.runtimePromise(agentFibers)<R>();
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
      const journalCommitFence = new JournalCommitFence();
      const snapshotWriter = yield* makeSnapshotWriter(
        options.onSnapshot,
        failRun,
      );
      const workflowRunState = yield* Effect.try({
        try: () =>
          new WorkflowRunState({
            phases: plannedPhases,
            tasks: plannedTasks,
            initialSnapshot: options.initialSnapshot,
            publish: (snapshot) => {
              options.onTransition?.(snapshot);
              snapshotWriter.publish(snapshot);
            },
          }),
        catch: (cause) => new Error(toErrorMessage(cause), { cause }),
      });
      let scriptFailure: unknown;
      let finalized = false;
      const finalize = (
        exit: Exit.Exit<unknown, unknown>,
      ): Effect.Effect<void, WorkflowRunAbortError> =>
        Effect.suspend(() => {
          if (finalized) return Effect.void;
          finalized = true;
          return Effect.uninterruptible(
            Effect.gen(function* () {
              // Ordinary agent work stops immediately. An admitted journal
              // commit is uninterruptible, so clear still waits for its
              // durability point before the terminal snapshot is written.
              yield* FiberSet.clear(agentFibers);
              journalCommitFence.seal();

              const interrupted =
                Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
              let terminalOutcome: RunOutcome = RUN_OUTCOME.FAILED;
              if (firstFatalFault !== undefined) {
                terminalOutcome = RUN_OUTCOME.FAILED;
              } else if (Exit.isSuccess(exit)) {
                terminalOutcome = RUN_OUTCOME.COMPLETED;
              } else if (interrupted || options.signal?.aborted) {
                terminalOutcome = RUN_OUTCOME.CANCELLED;
              }
              const terminalError =
                firstFatalFault ??
                (Exit.isFailure(exit) && !interrupted
                  ? Cause.squash(exit.cause)
                  : scriptFailure);
              workflowRunState.finish(
                terminalOutcome,
                terminalError === undefined
                  ? undefined
                  : toErrorMessage(terminalError),
              );
              yield* snapshotWriter.flush;
              // A durable callback can discover the first run-level fault
              // while clear waits for its uninterruptible commit. Persist the
              // failed terminal snapshot first, then surface that fault even
              // when this path is running as the scope finalizer.
              if (firstFatalFault !== undefined) {
                return yield* Effect.fail(firstFatalFault);
              }
            }),
          );
        });
      yield* Effect.addFinalizer((exit) => finalize(exit).pipe(Effect.orDie));
      yield* snapshotWriter.flush;

      const control: WorkflowScriptControl = (childRunId, action) => {
        const call = inFlightCalls.get(childRunId);
        if (!call?.fiber) return false;
        call.action = action;
        call.fiber.interruptUnsafe();
        return true;
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
                { kind: 'checkpoint', cause: error },
              ),
            );
          }),
        );

      const agentPrimitive = (
        prompt: unknown,
        rawOptions?: unknown,
      ): Effect.Effect<string | undefined, Error, R> =>
        Effect.gen(function* () {
          if (firstFatalFault !== undefined) {
            return yield* Effect.fail(firstFatalFault);
          }
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
            return yield* Effect.fail(
              contractFault(new Error(parsedOptions.error.issues[0].message)),
            );
          }
          const callOptions: WorkflowAgentCallOptions = parsedOptions.data;
          const index = callCounter++;

          let plannedTask: WorkflowCallIdentity | undefined;
          if (hasTaskPlan) {
            if (!callOptions.id) {
              return yield* Effect.fail(
                failRun(
                  new WorkflowRunAbortError(
                    'Every agent() call must reference a task from meta.tasks with a non-empty "id" option.',
                    { kind: 'contract' },
                  ),
                ),
              );
            }
            plannedTask = plannedTasksById.get(callOptions.id);
            if (!plannedTask) {
              return yield* Effect.fail(
                failRun(
                  new WorkflowRunAbortError(
                    `agent() references undeclared task id "${callOptions.id}".`,
                    { kind: 'contract' },
                  ),
                ),
              );
            }
            if (
              (callOptions.label !== undefined &&
                callOptions.label !== plannedTask.label) ||
              (callOptions.phase !== undefined &&
                callOptions.phase !== plannedTask.phase)
            ) {
              return yield* Effect.fail(
                failRun(
                  new WorkflowRunAbortError(
                    `Task "${callOptions.id}" must use the label and phase declared in meta.tasks.`,
                    { kind: 'contract' },
                  ),
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
            return yield* Effect.fail(
              failRun(
                new WorkflowRunAbortError(
                  'The workflow host must fingerprint agent() file dependencies before they can be resumed safely.',
                  { kind: 'runner' },
                ),
              ),
            );
          }

          const readDependencyFingerprint = (): Effect.Effect<
            string,
            WorkflowRunAbortError,
            R
          > =>
            Effect.suspend(
              () =>
                fingerprintAgentDependencies?.(callOptions) ??
                Effect.fail(
                  new WorkflowRunAbortError(
                    'The workflow host returned no fingerprint for agent() file dependencies.',
                    { kind: 'runner' },
                  ),
                ),
            ).pipe(
              Effect.flatMap((fingerprint) =>
                isNonEmptyString(fingerprint)
                  ? Effect.succeed(fingerprint)
                  : Effect.fail(
                      new WorkflowRunAbortError(
                        'The workflow host returned no fingerprint for agent() file dependencies.',
                        { kind: 'runner' },
                      ),
                    ),
              ),
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) {
                  return Effect.failCause(cause as Cause.Cause<never>);
                }
                const error = Cause.squash(cause);
                return Effect.fail(
                  failRun(
                    error instanceof WorkflowRunAbortError
                      ? error
                      : new WorkflowRunAbortError(
                          `Workflow agent() file dependencies could not be fingerprinted: ${toErrorMessage(error)}`,
                          { kind: 'runner', cause: error },
                        ),
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
          let recoverySource:
            | { readonly id: string; readonly journalProven: boolean }
            | {
                readonly implicitIndex: number;
                readonly journalProven: true;
              }
            | undefined;
          if (plannedTask !== undefined || callOptions.id !== undefined) {
            recoverySource = {
              id: progressId,
              journalProven: prior !== undefined,
            };
          } else if (
            prior !== undefined &&
            priorKeysByIndex.get(prior.index)?.size === 1
          ) {
            recoverySource = {
              implicitIndex: prior.index,
              journalProven: true,
            };
          }

          yield* Effect.try({
            try: () => {
              if (
                callOptions.phase !== undefined &&
                workflowRunState.currentPhaseIndex === -1
              ) {
                workflowRunState.enterStage(callOptions.phase);
              }
              workflowRunState.issueCall(
                {
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
                },
                recoverySource,
              );
            },
            catch: contractFault,
          });

          if (issuedCallKeys.has(key)) {
            return yield* Effect.fail(
              failRun(
                new WorkflowRunAbortError(
                  'Repeated agent() calls with the same prompt and run options require distinct non-empty "id" options for restart-safe identity.',
                  { kind: 'contract' },
                ),
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
                    return yield* Effect.fail(
                      failRun(
                        new WorkflowRunAbortError(
                          'A changed agent() file dependency now conflicts with another call identity; rerun the workflow from its saved script.',
                          { kind: 'contract' },
                        ),
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

          const journalValue = (
            value: unknown,
            valueLabel: string,
          ): {
            payload: string | undefined;
            normalizedResult: unknown;
          } =>
            Result.match(
              Result.try({
                try: () => {
                  const journalPayload = serializeBridgeValue(
                    value,
                    valueLabel,
                  );
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
                catch: (error) => error,
              }),
              {
                onFailure: (error) => {
                  const fault =
                    error instanceof WorkflowRunAbortError
                      ? error
                      : new WorkflowRunAbortError(toErrorMessage(error), {
                          kind: 'runner',
                          cause: error,
                        });
                  // Persist the call's real bridge failure before waking the
                  // run-level fatal race, which interrupts this guest fiber.
                  failCall(fault);
                  throw failRun(fault);
                },
                onSuccess: (value) => value,
              },
            );

          if (prior) {
            const { payload, normalizedResult } = journalValue(
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

          workflowRunState.queueCall(progressId, {
            model: callOptions.model,
          });

          for (;;) {
            const call: InFlightAgentCall = { index };
            // The attempt's scope is opened here and closed only after the
            // journal write below: the runner fences the child it recovered or
            // superseded into it, and a fence that ended at the runner's
            // return would leave that child free to be resumed — appending
            // `run.activate` and working on — while this loop is still
            // persisting the value read from it. The engine owns the scope
            // because the engine owns the commit.
            const attempt = yield* Effect.scopedWith((attemptScope) =>
              Effect.gen(function* () {
                const launch = permits.withPermit(
                  Effect.gen(function* () {
                    if (firstFatalFault !== undefined) {
                      return yield* Effect.fail(firstFatalFault);
                    }
                    liveCallCounter += 1;
                    if (liveCallCounter > maxAgentCalls) {
                      const fault = new WorkflowRunAbortError(
                        `Workflow exceeded the ${maxAgentCalls} live agent-call cap (runaway-loop backstop; journal replays are free).`,
                        { kind: 'cap' },
                      );
                      // Record the refused call before waking the run-level fatal
                      // race, which immediately interrupts the guest-call fiber.
                      failCall(fault);
                      return yield* Effect.fail(failRun(fault));
                    }
                    workflowRunState.beginAttempt(progressId);
                    yield* refreshDependencyIdentity();
                    const signal = yield* Effect.abortSignal;
                    const runnerFiber = yield* Effect.forkChild(
                      Effect.suspend(() =>
                        runAgent({
                          index,
                          progressId,
                          key,
                          prompt,
                          options: callOptions,
                          signal,
                          report: ({ agent, recovered, ...attemptFacts }) => {
                            if (
                              attemptFacts.childRunId !== undefined &&
                              recovered !== true
                            ) {
                              inFlightCalls.set(attemptFacts.childRunId, call);
                            }
                            if (
                              Object.values(attemptFacts).some(
                                (fact) => fact !== undefined,
                              )
                            ) {
                              workflowRunState.reportAttempt(
                                progressId,
                                attemptFacts,
                              );
                            }
                            if (agent !== undefined) {
                              workflowRunState.updateCall(progressId, {
                                agent,
                              });
                            }
                          },
                        }).pipe(Scope.provide(attemptScope)),
                      ),
                      { startImmediately: true },
                    );
                    // The runner has started and owns its scoped AbortSignal;
                    // give the durable writer a turn while the call remains in
                    // its running state, even if the runner already completed.
                    yield* Effect.yieldNow;
                    return yield* Fiber.join(runnerFiber);
                  }).pipe(Effect.scoped),
                );
                const attemptFiber = yield* Effect.forkChild(launch);
                call.fiber = attemptFiber;
                const attemptExit = yield* Fiber.await(attemptFiber);

                for (const [childRunId, inFlight] of inFlightCalls) {
                  if (inFlight === call) {
                    inFlightCalls.delete(childRunId);
                  }
                }

                if (!workflowRunState.settleAttempt(progressId)) {
                  return undefined;
                }

                if (call.action === 'retry') {
                  workflowRunState.queueCall(progressId, {
                    model: callOptions.model,
                  });
                  return RETRY_ATTEMPT;
                }
                if (call.action === 'skip') {
                  workflowRunState.settleCall(progressId, {
                    status: WORKFLOW_CALL_STATUS.SKIPPED,
                  });
                  return JSON.stringify(WORKFLOW_SKIPPED_RESULT);
                }

                if (Exit.isFailure(attemptExit)) {
                  const error = Cause.squash(attemptExit.cause);
                  if (isWorkflowAbort(error)) {
                    const fatal = failRun(
                      error instanceof WorkflowRunAbortError
                        ? error
                        : new WorkflowRunAbortError(toErrorMessage(error), {
                            kind: 'runner',
                            cause: error,
                          }),
                    );
                    failCall(fatal);
                    return yield* Effect.fail(fatal);
                  }
                  failCall(error, WORKFLOW_CALL_STATUS.FAILED);
                  // Let the writer observe this failed call while its stage is
                  // still active before guest code can launch the next call.
                  yield* Effect.yieldNow;
                  return 'null';
                }

                const { payload, normalizedResult } = journalValue(
                  attemptExit.value,
                  'agent() result',
                );
                let callSettled = false;
                const entry = { index, key, result: normalizedResult };
                const committed = yield* journalCommitFence.commit(
                  persistJournalEntry(entry).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        callSettled = true;
                        workflowRunState.settleCall(progressId, {
                          status: WORKFLOW_CALL_STATUS.COMPLETED,
                        });
                        onJournalEntryConsumed?.(entry);
                      }),
                    ),
                    Effect.catch((error) => {
                      if (!callSettled) failCall(error);
                      return Effect.fail(failRun(error));
                    }),
                  ),
                );
                if (!committed) return undefined;
                return payload;
              }),
            );
            if (attempt === RETRY_ATTEMPT) continue;
            return attempt;
          }
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

      const sandbox = Effect.tryPromise({
        try: (signal) =>
          runScriptInSandbox(
            body,
            {
              asyncFns: {
                agent: (args) =>
                  runGuestAgent(agentPrimitive(args[0], args[1])),
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
                      catch: contractFault,
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
              signal,
            },
          ),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error(toErrorMessage(cause), { cause }),
      });
      const externalSignal = options.signal;
      const parentAbort =
        externalSignal === undefined
          ? Effect.never
          : Effect.callback<never, Error>((resume) => {
              const detach = onAbort(externalSignal, () => {
                resume(
                  Effect.fail(
                    externalSignal.reason instanceof Error
                      ? externalSignal.reason
                      : new Error(toErrorMessage(externalSignal.reason)),
                  ),
                );
              });
              return Effect.sync(detach);
            });

      const sandboxExit = yield* Effect.exit(
        Effect.raceFirst(
          Effect.raceFirst(sandbox, parentAbort),
          Deferred.await(fatalFault),
        ),
      );
      let result: unknown;
      if (Exit.isSuccess(sandboxExit)) {
        result = sandboxExit.value;
      } else {
        scriptFailure = Cause.squash(sandboxExit.cause);
      }

      if (scriptFailure !== undefined) {
        const failure =
          scriptFailure instanceof Error
            ? scriptFailure
            : new Error(toErrorMessage(scriptFailure), {
                cause: scriptFailure,
              });
        yield* finalize(Exit.fail(firstFatalFault ?? failure));
        return yield* Effect.fail(firstFatalFault ?? failure);
      }

      yield* finalize(Exit.succeed(undefined));
      if (firstFatalFault !== undefined) {
        return yield* Effect.fail(firstFatalFault);
      }

      return {
        result,
        journal: [...journal.values()].toSorted((a, b) => a.index - b.index),
        snapshot: workflowRunState.snapshot(),
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
