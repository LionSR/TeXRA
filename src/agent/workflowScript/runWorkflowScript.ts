import { basename } from 'node:path';

import stableStringify from 'fast-json-stable-stringify';
import PQueue from 'p-queue';
import pTimeout from 'p-timeout';
import {
  WORKFLOW_CALL_STATUS,
  WORKFLOW_EXECUTION_LIFECYCLE,
  type ExecutionId,
  type StreamTabId,
  type WorkflowCallIdentity,
  type WorkflowControlAction,
  type WorkflowExecutionSnapshot,
} from '@shared/schemas';
import { WorkflowScriptFilesSchema } from '@shared/schemas/workflowScriptFiles';
import { isNonEmptyString, onAbort } from '@utils/core';
import { truncatedHexId } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { parseWorkflowScript } from './parseScript';
import { runScriptInSandbox } from './sandbox';
import { WorkflowExecutionState } from './workflowExecutionState';
import {
  WORKFLOW_SKIPPED_RESULT,
  WorkflowAgentCallOptionsSchema,
  normalizeWorkflowScriptPhaseTitle,
  type WorkflowAgentCallOptions,
  type WorkflowJournalEntry,
  type WorkflowScriptControl,
  type WorkflowScriptEvent,
  type WorkflowScriptPhaseContext,
  type WorkflowScriptProgressId,
  type WorkflowScriptRunOptions,
  type WorkflowScriptRunResult,
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
  return truncatedHexId(
    stableStringify({
      options: executionOptions,
      prompt,
      dependencyFingerprint,
    }),
    16,
  );
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_AGENT_CALLS = 200;
const MAX_FANOUT = 512;
const DRAIN_GRACE_MS = 5_000;
const LABEL_EXCERPT_LENGTH = 80;

/** Progress-only attempt facts shared by every settled `agent:end` outcome. */
type WorkflowScriptAttemptMetadata = Pick<
  Extract<WorkflowScriptEvent, { type: 'agent:end'; outcome: 'completed' }>,
  'durationMs' | 'model' | 'childStreamId' | 'costUsd'
>;

/** The two snapshot statuses an `agent:end` failure can terminalize a call with. */
type WorkflowFailedCallStatus =
  typeof WORKFLOW_CALL_STATUS.FAILED | typeof WORKFLOW_CALL_STATUS.CANCELLED;

/**
 * Control-plane state for one in-flight `agent()` attempt: the controller
 * `skip()`/`retry()` aborts, and the action that abort requested. One record so
 * the action can never outlive or precede the attempt it belongs to.
 */
interface InFlightAgentCall {
  readonly controller: AbortController;
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
        // The publisher hands over a live reference; snapshot it here, at
        // drain time, so publications coalesced away never pay the clone and
        // each onSnapshot consumer still gets its own isolated copy.
        const snapshot = structuredClone(this.#pending);
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
  // Every guest-contract violation (bad agent() options, an undeclared or
  // out-of-order phase, a duplicate call id) stops the run with one fault
  // shape; the caller throws the returned fault.
  const contractFault = (error: unknown): WorkflowRunAbortError =>
    failRun(
      new WorkflowRunAbortError(toErrorMessage(error), {
        kind: 'contract',
        cause: error,
      }),
    );
  // One record per in-flight call, keyed by call index and linked to runAbort
  // (a run abort cascades to every entry; a per-call abort leaves the others
  // running). skip()/retry() target a single entry; the entry is removed as
  // soon as its call settles, and the attempt reads its own requested action
  // from the record it still holds. Control state is control-plane only —
  // never journaled, so resume identity is untouched.
  const inFlightCalls = new Map<number, InFlightAgentCall>();
  // Live child execution id → the call index that attempt belongs to. The
  // runner reports the id it actually launched (attempt-specific after a
  // durable retry), so a host targets exactly the child it can see; entries die
  // with the attempt that stamped them, so a stale id can never reach the fresh
  // attempt a retry starts.
  const callIndexByChildExecution = new Map<ExecutionId, number>();
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

  const control: WorkflowScriptControl = (childExecutionId, action) => {
    const index = callIndexByChildExecution.get(childExecutionId);
    // No-op when the id belongs to no live attempt of this run, or when the
    // call it named is no longer in flight (already settled).
    if (index === undefined) return;
    const call = inFlightCalls.get(index);
    if (!call) return;
    call.action = action;
    call.controller.abort(
      new Error(`Workflow agent() call ${index} ${action}.`),
    );
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
    // Arguments crossed the bridge as JSON text (see sandbox.ts marshalArgs),
    // so `rawOptions` is already plain, accessor-free host data, and the parse
    // below builds the fresh object the call carries onward. Only the fields
    // the call actually supplied travel with it: an option the guest omitted
    // stays absent, so a spurious empty list can never change the journal key
    // of an otherwise identical call.
    const parsedOptions = WorkflowAgentCallOptionsSchema.safeParse(
      rawOptions ?? {},
    );
    if (!parsedOptions.success) {
      throw contractFault(new Error(parsedOptions.error.issues[0].message));
    }
    const callOptions: WorkflowAgentCallOptions = parsedOptions.data;
    const index = callCounter;
    callCounter += 1;

    let plannedTask: WorkflowCallIdentity | undefined;
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
    // One derivation for every surface (progress events and the execution
    // snapshot), so the label a host shows live is the label the durable
    // record keeps: declared > explicit > file-derived > prompt excerpt >
    // role + position.
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
        throw contractFault(error);
      }
    }
    try {
      executionState.issueCall({
        id: progressId,
        label,
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
      throw contractFault(error);
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

    /**
     * Terminalize one call as failed on both channels at once. `finish()`
     * reclassifies only the calls that never settled — a still-PLANNED call
     * becomes skipped/not-reached, a live one takes the generic unfinished
     * note — so settling here is what stops the snapshot from contradicting
     * the `agent:end` failure the event stream just reported, and what keeps
     * the real error on the call.
     */
    const failCall = (
      error: unknown,
      metadata: Partial<WorkflowScriptAttemptMetadata> = {},
      status: WorkflowFailedCallStatus = WORKFLOW_CALL_STATUS.FAILED,
    ): void => {
      const message = toErrorMessage(error);
      executionState.settleCall(progressId, { status, error: message });
      emit({
        type: 'agent:end',
        ...eventBase,
        outcome: 'failed',
        error: message,
        ...metadata,
      });
    };

    // Serialize (and round-trip deserialize) a result value for the journal,
    // failing the call on both channels if it isn't bridge-safe. Shared by the
    // cached-replay and live-call paths below, which differ only in the source
    // value — a cached replay's call is still PLANNED here, which is exactly
    // the case `failCall` keeps `finish()` from reclassifying as not-reached.
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
        failCall(fault, metadata);
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
      journal.set(index, { index, key, result: normalizedResult });
      executionState.settleCall(progressId, {
        status: WORKFLOW_CALL_STATUS.CACHED,
      });
      emit({ type: 'agent:end', ...eventBase, outcome: 'cached' });
      return payload;
    }

    // Host-side wall clock (the sandbox's Date.now ban is guest-only): timing
    // and the reported model are progress-only, never journaled, so they can't
    // affect resume identity or determinism. Declared once outside the attempt
    // loop: durationMs spans the whole call (across any retry), and the latest
    // attempt's reported model wins.
    const startedAt = Date.now();
    let resolvedModel: string | undefined;
    let childStreamId: StreamTabId | undefined;
    let startEmitted = false;
    const attemptMetadata = (): WorkflowScriptAttemptMetadata => {
      // Cost is read from the snapshot rather than re-accumulated here: the
      // runner reports it through `report()`, which the execution state already
      // folds into one per-call total across attempts.
      const costUsd = executionState.callCostUsd(progressId);
      return {
        ...(resolvedModel !== undefined && { model: resolvedModel }),
        ...(childStreamId !== undefined && { childStreamId }),
        ...(costUsd !== undefined && { costUsd }),
        durationMs: Date.now() - startedAt,
      };
    };
    // The execution snapshot solely owns the queued fact (QUEUED status); no
    // event duplicates it.
    executionState.queueCall(progressId);

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
              prompt,
              options: callOptions,
              signal: callController.signal,
              report: ({ agent, recovered, ...attemptFacts }) => {
                if (
                  attemptFacts.childExecutionId !== undefined &&
                  recovered !== true
                ) {
                  // The identity a host targets skip/retry by, stamped where
                  // the call index is already in scope. Recovered ids stay
                  // out: their result is already authoritative, so a stale
                  // skip/retry must not be able to discard or re-run it
                  // during the recovery path's async metadata reads.
                  callIndexByChildExecution.set(
                    attemptFacts.childExecutionId,
                    index,
                  );
                }
                if (attemptFacts.model !== undefined) {
                  resolvedModel = attemptFacts.model;
                }
                if (attemptFacts.childStreamId !== undefined) {
                  childStreamId = attemptFacts.childStreamId;
                }
                if (
                  Object.values(attemptFacts).some((fact) => fact !== undefined)
                ) {
                  executionState.reportAttempt(progressId, attemptFacts);
                }
                if (agent !== undefined) {
                  executionState.updateCall(progressId, { agent });
                }
                if (attemptFacts.childStreamId !== undefined) {
                  emit({
                    type: 'agent:stream',
                    ...eventBase,
                    childStreamId: attemptFacts.childStreamId,
                  });
                }
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
        // This attempt's child ids are dead the moment it settles: a retry
        // launches under a fresh id, and a stale one must no-op. Deleting
        // during for...of is spec-safe for Map iterators.
        for (const [childExecutionId, callIndex] of callIndexByChildExecution) {
          if (callIndex === index) {
            callIndexByChildExecution.delete(childExecutionId);
          }
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
        continue;
      }
      if (action === 'skip') {
        executionState.settleCall(progressId, {
          status: WORKFLOW_CALL_STATUS.SKIPPED,
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
          failCall(fatal, attemptMetadata());
          throw fatal;
        }
        // A failed agent resolves to null and is deliberately NOT journaled, so
        // a resume retries it. Callers also exclude the truthy skip sentinel.
        failCall(
          attemptError.error,
          attemptMetadata(),
          options.signal?.aborted
            ? WORKFLOW_CALL_STATUS.CANCELLED
            : WORKFLOW_CALL_STATUS.FAILED,
        );
        return 'null';
      }

      // Validate before journaling. Resume storage must never contain a value
      // that the sandbox boundary cannot reproduce.
      const { payload, normalizedResult } = journalValue(
        result,
        'agent() result',
        attemptMetadata(),
      );
      let callSettled = false;
      try {
        const committed = await journalCommitFence.commit(async () => {
          await persistJournalEntry({
            index,
            key,
            result: normalizedResult,
          });
          executionState.settleCall(progressId, {
            status: WORKFLOW_CALL_STATUS.COMPLETED,
          });
          callSettled = true;
          emit({
            type: 'agent:end',
            ...eventBase,
            outcome: 'completed',
            ...attemptMetadata(),
          });
        });
        if (!committed) return undefined;
      } catch (error) {
        // `persistJournalEntry` is the only step inside the fence that can
        // fail before the call terminalizes. Once the call settled COMPLETED
        // (journaled), a late `emit` throw must not rewrite it to failed —
        // the journal and snapshot already agree, so the error propagates
        // without resettling the call.
        if (!callSettled) failCall(error, attemptMetadata());
        throw error;
      }
      return payload;
    }
  }

  let result: unknown;
  let scriptFailure: { readonly error: unknown } | undefined;
  // Everything from launch preparation onward runs inside one try so the
  // terminal snapshot is always written: an unserializable `args` value, an
  // invalid `files` option, or a bridge-serialization fault used to escape
  // before `finish()` and leave the persisted snapshot permanently non-terminal
  // — the state a host reads back as a run still in flight.
  try {
    const argsJson = serializeBridgeValue(options.args, 'Workflow args');
    const files = WorkflowScriptFilesSchema.parse(options.files ?? {});
    const filesJson = stableStringify(files);
    const abortFromParent = () => runAbort.abort(options.signal?.reason);
    const detachAbortFromParent = onAbort(options.signal, abortFromParent);

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
                throw contractFault(error);
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
  } catch (error) {
    // A launch-time fault never reaches the sandbox, so it is this run's
    // outcome; an inner rejection already recorded its own.
    scriptFailure ??= { error };
  } finally {
    // Stop admitting journal commits before writing the terminal snapshot. An
    // admitted persistence callback is opaque and cannot be cancelled safely,
    // so it must settle even after the runner drain grace expires. If it never
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
    // Neither call below can throw, so this block never masks the outcome the
    // caller must see.
    executionState.finish(
      terminalLifecycle,
      terminalError === undefined ? undefined : toErrorMessage(terminalError),
    );
    await snapshotWriter.flush();
  }

  snapshotWriter.throwIfFailed();
  snapshotWriter.seal();

  // Guest code may catch an agent() rejection, and an abandoned call can
  // reject while the final drain is running. Checkpoint failure is a run-level
  // invariant, so a fault outranks the script outcome, and the earliest fault
  // outranks the ones that cascade from it.
  if (firstFatalFault) throw firstFatalFault;
  if (scriptFailure) throw scriptFailure.error;

  return {
    result,
    journal: [...journal.values()].toSorted((a, b) => a.index - b.index),
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
