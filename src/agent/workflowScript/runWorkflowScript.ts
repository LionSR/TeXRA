import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import stableStringify from 'fast-json-stable-stringify';
import PQueue from 'p-queue';
import pTimeout from 'p-timeout';
import {
  WORKFLOW_CALL_STATUS,
  WORKFLOW_EXECUTION_LIFECYCLE,
  type StreamTabId,
  type WorkflowExecutionSnapshot,
} from '@shared/schemas';
import {
  WorkflowScriptFilesSchema,
  type WorkflowScriptFiles,
} from '@shared/schemas/workflowScriptFiles';
import { normalizeStructuredOutputSchema } from '@tools/structuredOutput';
import { isNonEmptyString, onAbort } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { parseWorkflowScript } from './parseScript';
import { runScriptInSandbox } from './sandbox';
import { WorkflowExecutionState } from './workflowExecutionState';
import {
  WORKFLOW_SKIPPED_RESULT,
  normalizeWorkflowScriptPhaseTitle,
  type WorkflowAgentCallOptions,
  type WorkflowJournalEntry,
  type WorkflowScriptControl,
  type WorkflowScriptEvent,
  type WorkflowScriptPhaseContext,
  type WorkflowScriptProgressId,
  type WorkflowScriptRunOptions,
  type WorkflowScriptRunResult,
  type WorkflowScriptTask,
} from './types';

/**
 * Stable execution identity for one agent() call. Current keys exclude
 * display-only labels and phases, so editing a declarative task plan does not
 * invalidate otherwise identical completed work. A prior entry at the same
 * call index with a matching key replays its cached result. sha256 (truncated)
 * makes a collision that replays the wrong result impractical.
 */
function journalKey(
  prompt: string,
  options: WorkflowAgentCallOptions,
  dependencyFingerprint?: string,
): string {
  const executionOptions: WorkflowAgentCallOptions = { ...options };
  delete executionOptions.label;
  delete executionOptions.phase;
  return createHash('sha256')
    .update(
      stableStringify({
        options: executionOptions,
        prompt,
        dependencyFingerprint,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_AGENT_CALLS = 200;
const MAX_FANOUT = 512;
const DRAIN_GRACE_MS = 5_000;
const LABEL_EXCERPT_LENGTH = 80;
const STRING_AGENT_OPTION_FIELDS = [
  'id',
  'label',
  'phase',
  'agentName',
  'model',
] as const;
const FILE_AGENT_OPTION_FIELDS = [
  'inputFiles',
  'contextFiles',
  'mediaFiles',
] as const;
const WORKFLOW_AGENT_OPTION_FIELDS = new Set<string>([
  ...STRING_AGENT_OPTION_FIELDS,
  'schema',
  ...FILE_AGENT_OPTION_FIELDS,
]);

type WorkflowScriptFailedEvent = Extract<
  WorkflowScriptEvent,
  { type: 'agent:end'; outcome: 'failed' }
>;
/** Progress-only attempt facts shared by every settled `agent:end` outcome. */
type WorkflowScriptAttemptMetadata = Pick<
  Extract<WorkflowScriptEvent, { type: 'agent:end'; outcome: 'completed' }>,
  'durationMs' | 'model' | 'childStreamId'
>;

/**
 * Control-plane state for one in-flight `agent()` attempt: the controller
 * `skip()`/`retry()` aborts, and the action that abort requested. One record so
 * the action can never outlive or precede the attempt it belongs to.
 */
interface InFlightAgentCall {
  readonly controller: AbortController;
  action?: 'skip' | 'retry';
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

class JournalCommitFence {
  readonly #pending = new Set<Promise<void>>();
  #sealed = false;

  async commit(write: () => Promise<void>): Promise<boolean> {
    if (this.#sealed) return false;
    const pending = write();
    this.#pending.add(pending);
    try {
      await pending;
      return true;
    } finally {
      this.#pending.delete(pending);
    }
  }

  async sealAndFlush(): Promise<void> {
    this.#sealed = true;
    await Promise.allSettled([...this.#pending]);
  }
}

class CoalescedSnapshotWriter {
  readonly #write: WorkflowScriptRunOptions['onSnapshot'];
  readonly #onFailure: (failure: WorkflowRunAbortError) => void;
  #pending: WorkflowExecutionSnapshot | undefined;
  #running: Promise<void> | undefined;
  #failure: WorkflowRunAbortError | undefined;
  #sealed = false;

  constructor(
    write: WorkflowScriptRunOptions['onSnapshot'],
    onFailure: (failure: WorkflowRunAbortError) => void,
  ) {
    this.#write = write;
    this.#onFailure = onFailure;
  }

  publish(snapshot: WorkflowExecutionSnapshot): void {
    if (!this.#write || this.#failure !== undefined || this.#sealed) return;
    this.#pending = snapshot;
    this.#running ??= this.#drain();
  }

  async flush(): Promise<void> {
    while (this.#running) await this.#running;
  }

  throwIfFailed(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  seal(): void {
    if (this.#running || this.#pending) {
      throw new Error('Cannot seal workflow snapshot writes before flush.');
    }
    this.#sealed = true;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending) {
        const snapshot = this.#pending;
        this.#pending = undefined;
        await this.#write?.(snapshot);
      }
    } catch (cause) {
      const failure = new WorkflowRunAbortError(
        `Failed to persist workflow execution snapshot: ${toErrorMessage(cause)}`,
        { kind: 'checkpoint', cause },
      );
      this.#failure = failure;
      this.#pending = undefined;
      this.#onFailure(failure);
    } finally {
      this.#running = undefined;
      if (this.#pending && this.#failure === undefined) {
        this.#running = this.#drain();
      }
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Runs a workflow script: deterministic JS orchestration over host-executed
 * agents. The script's control flow (loops, fan-out, joins, reduction) runs
 * as plain code with zero model round-trips between steps; every agent()
 * call is bounded by one shared p-queue concurrency limit and journaled for
 * resume (same call index + same prompt/execution options → cached result).
 *
 * On wall-clock timeout the sandbox preempts guest execution, fires the run's
 * AbortSignal (passed to every runAgent invocation), and refuses new calls.
 */
export async function runWorkflowScript(
  options: WorkflowScriptRunOptions,
): Promise<WorkflowScriptRunResult> {
  const {
    runAgent,
    fingerprintAgentDependencies,
    onEvent,
    onJournalEntry,
    onControl,
  } = options;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  // This is the one total physical attempt bound. Cached replays are free.
  const maxAgentCalls = options.maxAgentCalls ?? DEFAULT_MAX_AGENT_CALLS;

  const { meta, body } = parseWorkflowScript(options.script);
  const timeoutMs = options.timeoutMs ?? meta.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const priorEntries = new Map<number, WorkflowJournalEntry>(
    (options.journal ?? []).map((entry) => [entry.index, entry]),
  );
  const journal = new Map<number, WorkflowJournalEntry>();
  const queue = new PQueue({ concurrency });
  const runAbort = new AbortController();
  let firstFatalFault: WorkflowRunAbortError | undefined;
  const failRun = (fault: WorkflowRunAbortError): WorkflowRunAbortError => {
    if (isRunFatalAbort(fault)) firstFatalFault ??= fault;
    runAbort.abort(fault);
    return firstFatalFault ?? fault;
  };
  // One record per in-flight call, keyed by call index and linked to runAbort
  // (a run abort cascades to every entry; a per-call abort leaves the others
  // running). skip()/retry() target a single entry; the entry is removed as
  // soon as its call settles, and the attempt reads its own requested action
  // from the record it still holds. Control state is control-plane only —
  // never journaled, so resume identity is untouched.
  const inFlightCalls = new Map<number, InFlightAgentCall>();
  // Journal replays are free: only live runAgent executions count against
  // the runaway-loop cap, so a resume can replay past the cap and finish
  // the remaining work.
  let liveCallCounter = 0;
  // agent() invocations the script may have abandoned without awaiting
  // (e.g. `const p = agent('x'); return 'done'`). Drained on completion so
  // no runner keeps consuming quota or emitting events after the run ends.
  const pendingAgentCalls = new Set<Promise<unknown>>();
  let callCounter = 0;
  const issuedCallKeys = new Set<string>();
  const plannedPhases = meta.phases ?? [];
  const hasTaskPlan = meta.tasks !== undefined;
  const plannedTasks = meta.tasks ?? [];
  const plannedTasksById = new Map(plannedTasks.map((task) => [task.id, task]));
  const journalCommitFence = new JournalCommitFence();
  const snapshotWriter = new CoalescedSnapshotWriter(
    options.onSnapshot,
    (failure) => {
      failRun(failure);
    },
  );
  const executionState = new WorkflowExecutionState({
    phases: plannedPhases,
    tasks: plannedTasks,
    initialSnapshot: options.initialSnapshot,
    publish: (snapshot) => snapshotWriter.publish(snapshot),
  });
  await snapshotWriter.flush();
  snapshotWriter.throwIfFailed();

  const emit = (event: WorkflowScriptEvent) => onEvent?.(event);

  const phaseContextFor = (
    phase: string | undefined,
  ): WorkflowScriptPhaseContext => {
    const phaseIndex = plannedPhases.findIndex(
      (plannedPhase) => plannedPhase.title === phase,
    );
    return {
      phase,
      ...(phaseIndex >= 0 && {
        phaseIndex,
        phaseTotal: plannedPhases.length,
      }),
    };
  };

  const requestControl = (index: number, action: 'skip' | 'retry'): void => {
    const call = inFlightCalls.get(index);
    // No-op when the call is not in flight (never started, or already settled).
    if (!call) return;
    call.action = action;
    call.controller.abort(
      new Error(`Workflow agent() call ${index} ${action}.`),
    );
  };
  const control: WorkflowScriptControl = {
    skip: (index) => requestControl(index, 'skip'),
    retry: (index) => requestControl(index, 'retry'),
  };
  onControl?.(control);
  if (hasTaskPlan) {
    emit({ type: 'plan', tasks: plannedTasks });
  }

  // failRun records faults separately from cancellation. Cleanup, timeout, or
  // a parent abort may already own the controller reason when an abandoned
  // persistence callback rejects, but the first fatal rejection still wins.
  const persistJournalEntry = async (
    entry: WorkflowJournalEntry,
  ): Promise<void> => {
    try {
      await onJournalEntry?.(entry);
      journal.set(entry.index, entry);
    } catch (error) {
      const message = `Failed to persist workflow journal entry ${entry.index}: ${toErrorMessage(error)}`;
      throw failRun(
        new WorkflowRunAbortError(message, {
          kind: 'checkpoint',
          cause: error,
        }),
      );
    }
  };

  async function agentPrimitive(
    prompt: unknown,
    rawOptions?: unknown,
  ): Promise<string | undefined> {
    // No new call may start once the run has stopped; the reason that stopped
    // it is what this call reports.
    runAbort.signal.throwIfAborted();
    if (!isNonEmptyString(prompt)) {
      throw new Error(
        'agent(prompt, options?) requires a non-empty string prompt.',
      );
    }
    let callOptions: WorkflowAgentCallOptions;
    try {
      callOptions = normalizeAgentOptions(rawOptions);
    } catch (error) {
      throw failRun(
        new WorkflowRunAbortError(toErrorMessage(error), {
          kind: 'contract',
          cause: error,
        }),
      );
    }
    const index = callCounter;
    callCounter += 1;

    let plannedTask: WorkflowScriptTask | undefined;
    if (hasTaskPlan) {
      if (!callOptions.id) {
        throw failRun(
          new WorkflowRunAbortError(
            'Every agent() call must reference a task from meta.tasks with a non-empty "id" option.',
            { kind: 'contract' },
          ),
        );
      }
      plannedTask = plannedTasksById.get(callOptions.id);
      if (!plannedTask) {
        throw failRun(
          new WorkflowRunAbortError(
            `agent() references undeclared task id "${callOptions.id}".`,
            { kind: 'contract' },
          ),
        );
      }
      if (
        (callOptions.label !== undefined &&
          callOptions.label !== plannedTask.label) ||
        (callOptions.phase !== undefined &&
          callOptions.phase !== plannedTask.phase)
      ) {
        throw failRun(
          new WorkflowRunAbortError(
            `Task "${callOptions.id}" must use the label and phase declared in meta.tasks.`,
            { kind: 'contract' },
          ),
        );
      }
      callOptions.label = plannedTask.label;
      callOptions.phase = plannedTask.phase;
    } else {
      callOptions.phase ??= executionState.currentPhase;
    }

    const primaryFile =
      callOptions.inputFiles?.[0] ?? callOptions.contextFiles?.[0];
    const role = callOptions.agentName ?? 'Agent';
    const label =
      plannedTask?.label ??
      callOptions.label ??
      prompt.slice(0, LABEL_EXCERPT_LENGTH).replaceAll(/\s+/g, ' ').trim();
    const snapshotLabel =
      plannedTask?.label ??
      callOptions.label ??
      (primaryFile ? `${basename(primaryFile)}: ${role}` : undefined) ??
      `${role} ${index + 1}`;
    const hasFileDependencies =
      (callOptions.inputFiles?.length ?? 0) > 0 ||
      (callOptions.contextFiles?.length ?? 0) > 0 ||
      (callOptions.mediaFiles?.length ?? 0) > 0;
    if (hasFileDependencies && fingerprintAgentDependencies === undefined) {
      throw failRun(
        new WorkflowRunAbortError(
          'The workflow host must fingerprint agent() file dependencies before they can be resumed safely.',
          { kind: 'runner' },
        ),
      );
    }
    const readDependencyFingerprint = async (): Promise<string> => {
      try {
        const fingerprint = await fingerprintAgentDependencies?.(callOptions);
        if (!isNonEmptyString(fingerprint)) {
          throw new WorkflowRunAbortError(
            'The workflow host returned no fingerprint for agent() file dependencies.',
            { kind: 'runner' },
          );
        }
        return fingerprint;
      } catch (error) {
        throw failRun(
          error instanceof WorkflowRunAbortError
            ? error
            : new WorkflowRunAbortError(
                `Workflow agent() file dependencies could not be fingerprinted: ${toErrorMessage(error)}`,
                { kind: 'runner', cause: error },
              ),
        );
      }
    };
    let dependencyFingerprint = hasFileDependencies
      ? await readDependencyFingerprint()
      : undefined;
    let key = journalKey(prompt, callOptions, dependencyFingerprint);
    const progressId = plannedTask?.id ?? callOptions.id ?? `call-${index}`;
    const eventBase = {
      progressId,
      index,
      label,
      ...phaseContextFor(callOptions.phase),
    };
    if (
      callOptions.phase !== undefined &&
      executionState.currentPhaseIndex === -1
    ) {
      try {
        executionState.enterStage(callOptions.phase);
      } catch (error) {
        throw failRun(
          new WorkflowRunAbortError(toErrorMessage(error), {
            kind: 'contract',
            cause: error,
          }),
        );
      }
    }
    try {
      executionState.issueCall({
        id: progressId,
        label: snapshotLabel,
        phase: callOptions.phase,
        agent: callOptions.agentName,
        files: {
          input: (callOptions.inputFiles ?? []).map((file) => basename(file)),
          context: (callOptions.contextFiles ?? []).map((file) =>
            basename(file),
          ),
          media: (callOptions.mediaFiles ?? []).map((file) => basename(file)),
        },
      });
    } catch (error) {
      throw failRun(
        new WorkflowRunAbortError(toErrorMessage(error), {
          kind: 'contract',
          cause: error,
        }),
      );
    }
    if (issuedCallKeys.has(key)) {
      throw failRun(
        new WorkflowRunAbortError(
          'Repeated agent() calls with the same prompt and execution options require distinct non-empty "id" options for restart-safe identity.',
          { kind: 'contract' },
        ),
      );
    }
    issuedCallKeys.add(key);

    const refreshDependencyIdentity = async (): Promise<void> => {
      if (!hasFileDependencies) return;
      const refreshedFingerprint = await readDependencyFingerprint();
      if (refreshedFingerprint === dependencyFingerprint) return;

      const refreshedKey = journalKey(
        prompt,
        callOptions,
        refreshedFingerprint,
      );
      if (issuedCallKeys.has(refreshedKey)) {
        throw failRun(
          new WorkflowRunAbortError(
            'A changed agent() file dependency now conflicts with another call identity; rerun the workflow from its saved script.',
            { kind: 'contract' },
          ),
        );
      }
      issuedCallKeys.delete(key);
      issuedCallKeys.add(refreshedKey);
      dependencyFingerprint = refreshedFingerprint;
      key = refreshedKey;
    };

    const emitFailedEnd = (
      error: unknown,
      metadata: Partial<WorkflowScriptAttemptMetadata> = {},
    ): void => {
      const event: WorkflowScriptFailedEvent = {
        type: 'agent:end',
        ...eventBase,
        outcome: 'failed',
        error: toErrorMessage(error),
        ...metadata,
      };
      emit(event);
    };

    // Serialize (and round-trip deserialize) a result value for the journal,
    // emitting the matching `agent:end` failure event if it isn't
    // bridge-safe. Shared by the cached-replay and live-call paths below,
    // which differ only in the source value.
    const journalValue = (
      value: unknown,
      valueLabel: string,
      metadata?: Partial<WorkflowScriptAttemptMetadata>,
    ): { payload: string | undefined; normalizedResult: unknown } => {
      try {
        const payload = serializeBridgeValue(value, valueLabel);
        return {
          payload,
          normalizedResult:
            payload === undefined ? undefined : JSON.parse(payload),
        };
      } catch (error) {
        const fault = failRun(
          error instanceof WorkflowRunAbortError
            ? error
            : new WorkflowRunAbortError(toErrorMessage(error), {
                kind: 'runner',
                cause: error,
              }),
        );
        emitFailedEnd(fault, metadata);
        throw fault;
      }
    };

    // `key` still holds journalKey(prompt, callOptions, dependencyFingerprint)
    // here: refreshDependencyIdentity only runs at launch time, below.
    const prior = priorEntries.get(index);
    if (prior && prior.key === key) {
      const { payload, normalizedResult } = journalValue(
        prior.result,
        'Cached agent() result',
      );
      journal.set(index, {
        ...prior,
        key,
        result: normalizedResult,
      });
      executionState.updateCall(progressId, {
        status: WORKFLOW_CALL_STATUS.CACHED,
        timestamps: {
          ...executionState.call(progressId).timestamps,
          updatedAt: now(),
          completedAt: now(),
        },
      });
      emit({ type: 'agent:end', ...eventBase, outcome: 'cached' });
      return payload;
    }

    // Host-side wall clock (the sandbox's Date.now ban is guest-only): timing
    // and the reported model are progress-only, never journaled, so they can't
    // affect resume identity or determinism. Declared once outside the attempt
    // loop: durationMs spans the whole call (across any retry), and the latest
    // attempt's reportModel wins.
    const startedAt = Date.now();
    let resolvedModel: string | undefined;
    let childStreamId: StreamTabId | undefined;
    let startEmitted = false;
    const attemptMetadata = (): WorkflowScriptAttemptMetadata => ({
      ...(resolvedModel !== undefined && { model: resolvedModel }),
      ...(childStreamId !== undefined && { childStreamId }),
      durationMs: Date.now() - startedAt,
    });
    executionState.queueCall(progressId);
    emit({ type: 'agent:queued', ...eventBase });

    // Attempt loop: retry() re-enters with a fresh AbortController and a fresh
    // runAgent call for this same index/key; skip() and normal settlement exit.
    // Every physical model attempt is charged against liveCallCounter; the
    // logical call key and eventual journal entry remain index-scoped.
    for (;;) {
      const callController = new AbortController();
      const call: InFlightAgentCall = { controller: callController };
      // Link this call to the run: any run-level abort cascades to it, so a
      // runner watching invocation.signal still stops on timeout/cap.
      const cascade = () => callController.abort(runAbort.signal.reason);
      const detachCascade = onAbort(runAbort.signal, cascade);
      inFlightCalls.set(index, call);
      let result: unknown;
      let attemptError: { readonly error: unknown } | undefined;
      try {
        result = await (queue.add(() => {
          // Re-check after waiting for a slot: an abort while this call was
          // queued must not launch fresh model work. The reason that stopped
          // the run is what this attempt reports, so a cleanup abort stays a
          // soft per-call failure while a fault still stops the run.
          runAbort.signal.throwIfAborted();
          callController.signal.throwIfAborted();
          // Charge physical work only after p-queue admits this attempt. Calls
          // cancelled while queued never consume the live-attempt budget.
          liveCallCounter += 1;
          if (liveCallCounter > maxAgentCalls) {
            throw failRun(
              new WorkflowRunAbortError(
                `Workflow exceeded the ${maxAgentCalls} live agent-call cap (runaway-loop backstop; journal replays are free).`,
                { kind: 'cap' },
              ),
            );
          }
          resolvedModel = undefined;
          childStreamId = undefined;
          executionState.beginAttempt(progressId);
          if (!startEmitted) {
            startEmitted = true;
            emit({ type: 'agent:start', ...eventBase });
          }
          executionState.updateCall(progressId, {
            status: WORKFLOW_CALL_STATUS.RUNNING,
          });
          const launch = () => {
            callController.signal.throwIfAborted();
            return runAgent({
              index,
              progressId,
              key,
              ...(dependencyFingerprint !== undefined && {
                dependencyFingerprint,
              }),
              prompt,
              options: callOptions,
              signal: callController.signal,
              reportModel: (model) => {
                resolvedModel = model;
                executionState.reportModel(progressId, model);
              },
              reportAgent: (agent) =>
                executionState.updateCall(progressId, { agent }),
              reportChildExecution: (executionId) =>
                executionState.reportChildExecution(progressId, executionId),
              reportCostUsd: (costUsd) =>
                executionState.reportCostUsd(progressId, costUsd),
              reportChildStream: (streamId) => {
                executionState.reportChildStream(progressId, streamId);
                childStreamId = streamId;
                emit({
                  type: 'agent:stream',
                  ...eventBase,
                  childStreamId: streamId,
                });
              },
            });
          };
          // File contents can change while this call waits for a concurrency
          // slot or between interactive attempts. Refresh the identity before
          // every physical launch so the journal and stable child id describe
          // the bytes this attempt is about to consume. Keep no-file launches
          // synchronous here: orchestration timing is part of abort semantics.
          return hasFileDependencies
            ? refreshDependencyIdentity().then(launch)
            : launch();
          // p-queue types add() as Promise<T | void>; runAgent's result is
          // always present here (the task never returns void), so the cast
          // keeps the value flowing through unchanged.
        }) as Promise<unknown>);
      } catch (error) {
        attemptError = { error };
      } finally {
        detachCascade();
        if (inFlightCalls.get(index) === call) {
          inFlightCalls.delete(index);
        }
      }

      // The terminal drain may have timed out while this runner ignored its
      // abort signal. Do not let that late settlement mutate sealed state or
      // append a journal entry after the terminal snapshot was persisted.
      if (!executionState.settleAttempt(progressId)) return undefined;

      // Control action wins over whatever the (possibly signal-ignoring) runner
      // did: a deliberate skip/retry discards this attempt's outcome.
      const action = call.action;
      if (action === 'retry') {
        executionState.queueCall(progressId);
        emit({ type: 'agent:queued', ...eventBase });
        continue;
      }
      if (action === 'skip') {
        executionState.updateCall(progressId, {
          status: WORKFLOW_CALL_STATUS.SKIPPED,
          timestamps: {
            ...executionState.call(progressId).timestamps,
            updatedAt: now(),
            completedAt: now(),
          },
        });
        emit({
          type: 'agent:end',
          ...eventBase,
          outcome: 'skipped',
          reason: 'user',
          ...attemptMetadata(),
        });
        // First-class SKIPPED value, not journaled — a resume re-runs it.
        return JSON.stringify(WORKFLOW_SKIPPED_RESULT);
      }

      if (attemptError) {
        // A runner may surface the run abort (its signal cascades from
        // runAbort) or mint its own; that must stop the workflow, not degrade
        // into a null. The error may be a realm-local copy, so it is
        // classified by name; only the run's own reason carries a kind, and a
        // cleanup reason means the script already settled with an outcome this
        // rejection must not replace.
        const { reason } = runAbort.signal;
        const cancelledByCleanup =
          reason instanceof WorkflowRunAbortError &&
          reason.kind === 'settlement-cleanup';
        if (isWorkflowAbort(attemptError.error) && !cancelledByCleanup) {
          const fatal = failRun(
            attemptError.error instanceof WorkflowRunAbortError
              ? attemptError.error
              : new WorkflowRunAbortError(toErrorMessage(attemptError.error), {
                  kind: 'runner',
                  cause: attemptError.error,
                }),
          );
          emitFailedEnd(fatal, attemptMetadata());
          throw fatal;
        }
        // A failed agent resolves to null and is deliberately NOT journaled, so
        // a resume retries it. Callers also exclude the truthy skip sentinel.
        executionState.updateCall(progressId, {
          status: options.signal?.aborted
            ? WORKFLOW_CALL_STATUS.CANCELLED
            : WORKFLOW_CALL_STATUS.FAILED,
          error: toErrorMessage(attemptError.error),
          timestamps: {
            ...executionState.call(progressId).timestamps,
            updatedAt: now(),
            completedAt: now(),
          },
        });
        emitFailedEnd(attemptError.error, attemptMetadata());
        return 'null';
      }

      // Validate before journaling. Resume storage must never contain a value
      // that the sandbox boundary cannot reproduce.
      const { payload, normalizedResult } = journalValue(
        result,
        'agent() result',
        attemptMetadata(),
      );
      try {
        const committed = await journalCommitFence.commit(async () => {
          await persistJournalEntry({
            index,
            key,
            result: normalizedResult,
          });
          executionState.updateCall(progressId, {
            status: WORKFLOW_CALL_STATUS.COMPLETED,
            timestamps: {
              ...executionState.call(progressId).timestamps,
              updatedAt: now(),
              completedAt: now(),
            },
          });
          emit({
            type: 'agent:end',
            ...eventBase,
            outcome: 'completed',
            ...attemptMetadata(),
          });
        });
        if (!committed) return undefined;
      } catch (error) {
        emitFailedEnd(error, attemptMetadata());
        throw error;
      }
      return payload;
    }
  }

  const argsJson = serializeBridgeValue(options.args, 'Workflow args');
  const files = WorkflowScriptFilesSchema.parse(options.files ?? {});
  const filesJson = stableStringify(files);
  const abortFromParent = () => runAbort.abort(options.signal?.reason);
  const detachAbortFromParent = onAbort(options.signal, abortFromParent);

  let result: unknown;
  let scriptFailure: { readonly error: unknown } | undefined;
  try {
    result = await runScriptInSandbox(
      body,
      {
        asyncFns: {
          agent: async (args) => {
            const invocation = agentPrimitive(args[0], args[1]);
            pendingAgentCalls.add(invocation);
            try {
              return await invocation;
            } finally {
              pendingAgentCalls.delete(invocation);
            }
          },
        },
        syncFns: {
          log: (args) => {
            emit({ type: 'log', message: String(args[0]) });
            return undefined;
          },
          phase: (args) => {
            const nextPhase = normalizeWorkflowScriptPhaseTitle(
              String(args[0]),
            );
            try {
              executionState.enterStage(nextPhase);
            } catch (error) {
              throw failRun(
                new WorkflowRunAbortError(toErrorMessage(error), {
                  kind: 'contract',
                  cause: error,
                }),
              );
            }
            const { phaseIndex, phaseTotal } = phaseContextFor(nextPhase);
            emit({
              type: 'phase',
              title: nextPhase,
              ...(phaseIndex !== undefined && {
                index: phaseIndex,
                total: phaseTotal,
              }),
            });
            return undefined;
          },
        },
        argsJson,
        filesJson,
        realmPreludes: [ORCHESTRATION_PRELUDE],
      },
      {
        timeoutMs,
        filename: `${meta.name}.workflow.js`,
        signal: options.signal,
        // The sandbox reports the timeout to the caller with the precise
        // error; this reason only tells in-flight calls why they stopped.
        onTimeout: () =>
          runAbort.abort(
            new WorkflowRunAbortError(
              `Workflow run aborted: the script exceeded its ${timeoutMs}ms wall clock.`,
              { kind: 'timeout' },
            ),
          ),
      },
    );
  } catch (error) {
    scriptFailure = { error };
  } finally {
    detachAbortFromParent();
    // Abort unconditionally once the sandbox returns. This stops in-flight
    // work the script abandoned and makes agentPrimitive reject any late call.
    // A fault that already aborted the run keeps its reason: the controller
    // holds the first one.
    runAbort.abort(
      new WorkflowRunAbortError(
        'Workflow script settled; agent() calls it left in flight were cancelled.',
        { kind: 'settlement-cleanup' },
      ),
    );
    if (pendingAgentCalls.size > 0) {
      // The script finished (or threw) with agent() calls still in flight
      // that it never awaited: wait for settlement so the returned journal
      // is final and nothing runs on after the workflow. The drain is
      // bounded — a runner that ignores the abort must not extend the run
      // past its timeout by more than the grace period; stragglers beyond
      // it are orphaned (their journal entries may be lost, which resume
      // treats as a retry).
      await pTimeout(Promise.allSettled([...pendingAgentCalls]), {
        milliseconds: DRAIN_GRACE_MS,
        fallback: () => [],
      });
    }
  }

  // Stop admitting journal commits before writing the terminal snapshot. An
  // admitted persistence callback is opaque and cannot be cancelled safely, so
  // it must settle even after the runner drain grace expires. If it never
  // settles, the run deliberately remains unsealed rather than persisting a
  // terminal snapshot that the callback could later invalidate.
  await journalCommitFence.sealAndFlush();

  const succeeded =
    scriptFailure === undefined && firstFatalFault === undefined;
  let terminalLifecycle: 'completed' | 'failed' | 'cancelled' =
    WORKFLOW_EXECUTION_LIFECYCLE.FAILED;
  if (succeeded) {
    terminalLifecycle = WORKFLOW_EXECUTION_LIFECYCLE.COMPLETED;
  } else if (firstFatalFault === undefined && options.signal?.aborted) {
    terminalLifecycle = WORKFLOW_EXECUTION_LIFECYCLE.CANCELLED;
  }
  const terminalError = firstFatalFault ?? scriptFailure?.error;
  executionState.finish(
    terminalLifecycle,
    terminalError === undefined ? undefined : toErrorMessage(terminalError),
  );
  await snapshotWriter.flush();
  snapshotWriter.throwIfFailed();
  snapshotWriter.seal();

  // Guest code may catch an agent() rejection, and an abandoned call can
  // reject while the final drain is running. Checkpoint failure is a run-level
  // invariant, so a fault outranks the script outcome, and the earliest fault
  // outranks the ones that cascade from it.
  if (firstFatalFault) throw firstFatalFault;
  if (scriptFailure) throw scriptFailure.error;

  return {
    meta,
    result,
    journal: [...journal.values()].toSorted((a, b) => a.index - b.index),
    agentCalls: callCounter,
    snapshot: executionState.snapshot(),
  };
}

function serializeBridgeValue(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  let payload: string | undefined;
  try {
    payload = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `${label} must be JSON-serializable: ${toErrorMessage(error)}`,
    );
  }
  if (payload === undefined) {
    throw new Error(
      `${label} must be JSON-serializable; functions and symbols are not supported.`,
    );
  }
  return payload;
}

function normalizeAgentOptions(raw: unknown): WorkflowAgentCallOptions {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('agent() options must be a plain object.');
  }
  // Arguments crossed the bridge as JSON text (see sandbox.ts marshalArgs),
  // so `raw` is already plain, accessor-free host data; the clone here is a
  // cheap defensive copy that also keeps this function safe if it is ever
  // called with a value that did not come through the bridge.
  const source = structuredClone(raw ?? {}) as Record<string, unknown>;
  const unknownField = Object.keys(source).find(
    (field) => !WORKFLOW_AGENT_OPTION_FIELDS.has(field),
  );
  if (unknownField !== undefined) {
    throw new Error(
      `agent() option "${unknownField}" is not recognized. Allowed options: ${[...WORKFLOW_AGENT_OPTION_FIELDS].join(', ')}.`,
    );
  }
  const common: {
    id?: string;
    label?: string;
    phase?: string;
    agentName?: string;
    model?: string;
  } = {};
  for (const field of STRING_AGENT_OPTION_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    const requiresContent =
      field === 'id' || field === 'model' || field === 'phase';
    if (typeof value !== 'string' || (requiresContent && !value.trim())) {
      const requirement = requiresContent ? 'a non-empty string' : 'a string';
      throw new Error(`agent() option "${field}" must be ${requirement}.`);
    }
    const normalized =
      requiresContent || field === 'label' ? value.trim() : value;
    common[field] =
      field === 'phase'
        ? normalizeWorkflowScriptPhaseTitle(normalized)
        : normalized;
  }
  let schema: Record<string, unknown> | undefined;
  if (Object.hasOwn(source, 'schema')) {
    const rawSchema = source.schema;
    if (
      rawSchema === null ||
      typeof rawSchema !== 'object' ||
      Array.isArray(rawSchema)
    ) {
      throw new Error(
        'agent() option "schema" must be a plain JSON Schema object.',
      );
    }
    try {
      schema = normalizeStructuredOutputSchema(
        rawSchema as Record<string, unknown>,
      ).jsonSchema;
    } catch (error) {
      throw new Error(
        `agent() option "schema" is not a supported object-root JSON Schema: ${toErrorMessage(error)}`,
      );
    }
  }

  // Only the fields the call actually supplied travel onward: the schema
  // prefaults the other lists to [], and a spurious empty list would change
  // the journal key of an otherwise identical call.
  const presentFileFields = FILE_AGENT_OPTION_FIELDS.filter(
    (field) => source[field] !== undefined,
  );
  const requestedFiles: Record<string, unknown> = {};
  for (const field of presentFileFields) requestedFiles[field] = source[field];
  let files: WorkflowScriptFiles;
  try {
    files = WorkflowScriptFilesSchema.parse(requestedFiles);
  } catch (error) {
    throw new Error(
      `agent() options "inputFiles", "contextFiles", and "mediaFiles" must be arrays of non-empty strings: ${toErrorMessage(error)}`,
    );
  }

  if (schema !== undefined) {
    if (presentFileFields.length > 0) {
      throw new Error(
        'agent() structured-output calls cannot use file options; inputFiles, contextFiles, and mediaFiles belong to workflow-agent calls.',
      );
    }
    if (common.agentName === undefined) {
      throw new Error(
        'agent() structured-output calls must name a tool-use agent with "agentName".',
      );
    }
    return {
      ...common,
      agentName: common.agentName,
      schema,
    };
  }
  const fileOptions: {
    [K in (typeof FILE_AGENT_OPTION_FIELDS)[number]]?: WorkflowScriptFiles[K];
  } = {};
  for (const field of presentFileFields) fileOptions[field] = files[field];
  return { ...common, ...fileOptions };
}
