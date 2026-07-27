import { createHash } from 'node:crypto';

import stableStringify from 'fast-json-stable-stringify';
import PQueue from 'p-queue';
import pTimeout from 'p-timeout';
import {
  WorkflowScriptFilesSchema,
  type WorkflowScriptFiles,
} from '@shared/schemas/workflowScriptFiles';
import { normalizeStructuredOutputSchema } from '@tools/structuredOutput';
import { isNonEmptyString } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { parseWorkflowScript } from './parseScript';
import { runScriptInSandbox } from './sandbox';
import {
  WORKFLOW_JOURNAL_KEY_FORMAT,
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
 * invalidate otherwise identical completed work. The legacy format is retained
 * only to verify and migrate version-1 journal entries. A prior entry at the
 * same call index with a matching key replays its cached result. sha256
 * (truncated) makes a collision that replays the wrong result impractical.
 */
function journalKey(
  prompt: string,
  options: WorkflowAgentCallOptions,
  keyFormat: WorkflowJournalEntry['keyFormat'],
  dependencyFingerprint?: string,
): string {
  const executionOptions: WorkflowAgentCallOptions = { ...options };
  if (keyFormat !== WORKFLOW_JOURNAL_KEY_FORMAT.LEGACY_V1) {
    delete executionOptions.label;
    delete executionOptions.phase;
  }
  return createHash('sha256')
    .update(
      stableStringify({
        options: executionOptions,
        prompt,
        ...(keyFormat === WORKFLOW_JOURNAL_KEY_FORMAT.DEPENDENCY_AWARE_V3 && {
          dependencyFingerprint,
        }),
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
const LABEL_EXCERPT_LENGTH = 48;
const WORKFLOW_AGENT_OPTION_FIELDS = new Set([
  'id',
  'label',
  'phase',
  'agentName',
  'model',
  'schema',
  'inputFiles',
  'contextFiles',
  'mediaFiles',
]);

type WorkflowScriptFailedEvent = Extract<
  WorkflowScriptEvent,
  { type: 'agent:end'; outcome: 'failed' }
>;
type WorkflowScriptFailureAttemptMetadata = Pick<
  WorkflowScriptFailedEvent,
  'durationMs' | 'model'
>;

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
 * Thrown when the whole run must stop (agent-call cap exceeded, wall-clock
 * timeout abort). The realm-side agent() primitive recognizes it by name and
 * rethrows instead of converting it to null; parallel() then propagates that
 * rejected call through Promise.all. Detected by name, not instanceof — the
 * error crosses the sandbox realm boundary as a realm-local copy carrying
 * only name/message.
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
    error instanceof WorkflowRunAbortError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'WorkflowRunAbortError')
  );
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
  const maxAgentCalls = options.maxAgentCalls ?? DEFAULT_MAX_AGENT_CALLS;

  const { meta, body } = parseWorkflowScript(options.script);
  const timeoutMs = options.timeoutMs ?? meta.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const priorEntries = new Map<number, WorkflowJournalEntry>(
    (options.journal ?? []).map((entry) => [entry.index, entry]),
  );
  const journal = new Map<number, WorkflowJournalEntry>();
  const queue = new PQueue({ concurrency });
  const runAbort = new AbortController();
  // One AbortController per in-flight call, keyed by call index and linked to
  // runAbort (a run abort cascades to every entry; a per-call abort leaves the
  // others running). skip()/retry() target a single entry; the entry is
  // removed as soon as its call settles. Control state is control-plane only —
  // never journaled, so resume identity is untouched.
  const callControllers = new Map<number, AbortController>();
  const pendingControlActions = new Map<number, 'skip' | 'retry'>();
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
  const issuedPlannedTaskIds = new Set<string>();
  let currentPhase: string | undefined;
  let fatalRunError: WorkflowRunAbortError | undefined;
  // Set only when sandbox settlement itself initiates the run abort. Sibling
  // rejections caused by this cleanup must not replace the script error that
  // triggered settlement; independent timeout/cap/checkpoint aborts stay fatal.
  let cleanupAbortStarted = false;

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
    const controller = callControllers.get(index);
    // No-op when the call is not in flight (never started, or already settled).
    if (!controller) return;
    pendingControlActions.set(index, action);
    controller.abort(new Error(`Workflow agent() call ${index} ${action}.`));
  };
  const control: WorkflowScriptControl = {
    skip: (index) => requestControl(index, 'skip'),
    retry: (index) => requestControl(index, 'retry'),
  };
  onControl?.(control);
  if (hasTaskPlan) {
    emit({ type: 'plan', tasks: plannedTasks });
  }

  const rememberFatalRunError = (error: unknown): WorkflowRunAbortError => {
    fatalRunError ??=
      error instanceof WorkflowRunAbortError
        ? error
        : new WorkflowRunAbortError(toErrorMessage(error));
    runAbort.abort();
    return fatalRunError;
  };

  const recordJournalEntry = async (
    entry: WorkflowJournalEntry,
  ): Promise<void> => {
    journal.set(entry.index, entry);
    try {
      await onJournalEntry?.(entry);
    } catch (error) {
      const message = `Failed to persist workflow journal entry ${entry.index}: ${toErrorMessage(error)}`;
      const fatal = rememberFatalRunError(new WorkflowRunAbortError(message));
      throw fatal;
    }
  };

  async function agentPrimitive(
    prompt: unknown,
    rawOptions?: unknown,
  ): Promise<string | undefined> {
    if (runAbort.signal.aborted) {
      throw rememberFatalRunError(
        new WorkflowRunAbortError(
          'Workflow run aborted (timeout or call cap); no new agent() calls may start.',
        ),
      );
    }
    if (!isNonEmptyString(prompt)) {
      throw new Error(
        'agent(prompt, options?) requires a non-empty string prompt.',
      );
    }
    let callOptions: WorkflowAgentCallOptions;
    try {
      callOptions = normalizeAgentOptions(rawOptions);
    } catch (error) {
      throw rememberFatalRunError(
        new WorkflowRunAbortError(toErrorMessage(error), { cause: error }),
      );
    }
    const index = callCounter;
    callCounter += 1;

    let plannedTask: WorkflowScriptTask | undefined;
    if (hasTaskPlan) {
      if (!callOptions.id) {
        throw rememberFatalRunError(
          new WorkflowRunAbortError(
            'Every agent() call must reference a task from meta.tasks with a non-empty "id" option.',
          ),
        );
      }
      plannedTask = plannedTasksById.get(callOptions.id);
      if (!plannedTask) {
        throw rememberFatalRunError(
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
        throw rememberFatalRunError(
          new WorkflowRunAbortError(
            `Task "${callOptions.id}" must use the label and phase declared in meta.tasks.`,
          ),
        );
      }
      callOptions.label = plannedTask.label;
      callOptions.phase = plannedTask.phase;
    } else {
      callOptions.phase ??= currentPhase;
    }

    const label =
      plannedTask?.label ??
      callOptions.label ??
      prompt.slice(0, LABEL_EXCERPT_LENGTH).replaceAll(/\s+/g, ' ').trim();
    const hasFileDependencies =
      (callOptions.inputFiles?.length ?? 0) > 0 ||
      (callOptions.contextFiles?.length ?? 0) > 0 ||
      (callOptions.mediaFiles?.length ?? 0) > 0;
    if (hasFileDependencies && fingerprintAgentDependencies === undefined) {
      throw rememberFatalRunError(
        new WorkflowRunAbortError(
          'The workflow host must fingerprint agent() file dependencies before they can be resumed safely.',
        ),
      );
    }
    const readDependencyFingerprint = async (): Promise<string> => {
      try {
        const fingerprint = await fingerprintAgentDependencies?.(callOptions);
        if (!isNonEmptyString(fingerprint)) {
          throw new WorkflowRunAbortError(
            'The workflow host returned no fingerprint for agent() file dependencies.',
          );
        }
        return fingerprint;
      } catch (error) {
        throw rememberFatalRunError(
          error instanceof WorkflowRunAbortError
            ? error
            : new WorkflowRunAbortError(
                `Workflow agent() file dependencies could not be fingerprinted: ${toErrorMessage(error)}`,
                { cause: error },
              ),
        );
      }
    };
    let dependencyFingerprint = hasFileDependencies
      ? await readDependencyFingerprint()
      : undefined;
    let key = journalKey(
      prompt,
      callOptions,
      WORKFLOW_JOURNAL_KEY_FORMAT.DEPENDENCY_AWARE_V3,
      dependencyFingerprint,
    );
    const progressId = plannedTask?.id ?? `call-${index}`;
    if (plannedTask) {
      if (issuedPlannedTaskIds.has(progressId)) {
        throw rememberFatalRunError(
          new WorkflowRunAbortError(
            `Workflow task "${progressId}" may be issued only once per run.`,
          ),
        );
      }
      issuedPlannedTaskIds.add(progressId);
    }
    const phaseContext = phaseContextFor(callOptions.phase);
    if (issuedCallKeys.has(key)) {
      throw rememberFatalRunError(
        new WorkflowRunAbortError(
          'Repeated agent() calls with the same prompt and execution options require distinct non-empty "id" options for restart-safe identity.',
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
        WORKFLOW_JOURNAL_KEY_FORMAT.DEPENDENCY_AWARE_V3,
        refreshedFingerprint,
      );
      if (issuedCallKeys.has(refreshedKey)) {
        throw rememberFatalRunError(
          new WorkflowRunAbortError(
            'A changed agent() file dependency now conflicts with another call identity; rerun the workflow from its saved script.',
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
      metadata: WorkflowScriptFailureAttemptMetadata = {},
    ): void => {
      const event: WorkflowScriptFailedEvent = {
        type: 'agent:end',
        progressId,
        index,
        label,
        ...phaseContext,
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
      metadata?: WorkflowScriptFailureAttemptMetadata,
    ): { payload: string | undefined; normalizedResult: unknown } => {
      try {
        const payload = serializeBridgeValue(value, valueLabel);
        return { payload, normalizedResult: deserializeBridgeValue(payload) };
      } catch (error) {
        emitFailedEnd(error, metadata);
        throw error;
      }
    };

    const prior = priorEntries.get(index);
    let priorKey: string | undefined;
    if (
      prior !== undefined &&
      (!hasFileDependencies ||
        prior.keyFormat === WORKFLOW_JOURNAL_KEY_FORMAT.DEPENDENCY_AWARE_V3)
    ) {
      priorKey = journalKey(
        prompt,
        callOptions,
        prior.keyFormat,
        dependencyFingerprint,
      );
    }
    if (prior && prior.key === priorKey) {
      const { payload, normalizedResult } = journalValue(
        prior.result,
        'Cached agent() result',
      );
      journal.set(index, {
        ...prior,
        key,
        keyFormat: WORKFLOW_JOURNAL_KEY_FORMAT.DEPENDENCY_AWARE_V3,
        result: normalizedResult,
      });
      emit({
        type: 'agent:end',
        progressId,
        index,
        label,
        ...phaseContext,
        outcome: 'cached',
      });
      return payload;
    }

    // Host-side wall clock (the sandbox's Date.now ban is guest-only): timing
    // and the reported model are progress-only, never journaled, so they can't
    // affect resume identity or determinism. Declared once outside the attempt
    // loop: durationMs spans the whole call (across any retry), and the latest
    // attempt's reportModel wins.
    const startedAt = Date.now();
    let resolvedModel: string | undefined;
    let startEmitted = false;
    const attemptMetadata = (): WorkflowScriptFailureAttemptMetadata => ({
      ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
      durationMs: Date.now() - startedAt,
    });
    // Attempt loop: retry() re-enters with a fresh AbortController and a fresh
    // runAgent call for this same index/key; skip() and normal settlement exit.
    // Every physical model attempt is charged against liveCallCounter; the
    // logical call key and eventual journal entry remain index-scoped.
    for (;;) {
      liveCallCounter += 1;
      if (liveCallCounter > maxAgentCalls) {
        // Abort first so in-flight siblings stop consuming quota. Retried
        // attempts consume the same cap as first attempts; cached calls never
        // enter this loop.
        const fatal = rememberFatalRunError(
          new WorkflowRunAbortError(
            `Workflow exceeded the ${maxAgentCalls} live agent-call cap (runaway-loop backstop; journal replays are free).`,
          ),
        );
        emitFailedEnd(fatal, startEmitted ? attemptMetadata() : undefined);
        throw fatal;
      }
      const callController = new AbortController();
      // Link this call to the run: any run-level abort cascades to it, so a
      // runner watching invocation.signal still stops on timeout/cap.
      const cascade = () => callController.abort(runAbort.signal.reason);
      if (runAbort.signal.aborted) cascade();
      else runAbort.signal.addEventListener('abort', cascade, { once: true });
      callControllers.set(index, callController);
      if (!startEmitted) {
        startEmitted = true;
        emit({
          type: 'agent:start',
          progressId,
          index,
          label,
          ...phaseContext,
        });
      }

      let result: unknown;
      let attemptError: { readonly error: unknown } | undefined;
      try {
        result = await (queue.add(() => {
          // Re-check after waiting for a slot: a timeout/cap abort while this
          // call was queued must not launch fresh model work.
          if (runAbort.signal.aborted) {
            if (cleanupAbortStarted) {
              runAbort.signal.throwIfAborted();
            }
            throw rememberFatalRunError(
              new WorkflowRunAbortError(
                'Workflow run aborted while this agent() call was queued.',
              ),
            );
          }
          callController.signal.throwIfAborted();
          const launch = () =>
            runAgent({
              index,
              key,
              ...(dependencyFingerprint !== undefined && {
                dependencyFingerprint,
              }),
              prompt,
              options: callOptions,
              signal: callController.signal,
              reportModel: (model) => {
                resolvedModel = model;
              },
            });
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
        runAbort.signal.removeEventListener('abort', cascade);
        if (callControllers.get(index) === callController) {
          callControllers.delete(index);
        }
      }

      // Control action wins over whatever the (possibly signal-ignoring) runner
      // did: a deliberate skip/retry discards this attempt's outcome.
      const action = pendingControlActions.get(index);
      if (action) pendingControlActions.delete(index);
      if (action === 'retry') continue;
      if (action === 'skip') {
        emit({
          type: 'agent:end',
          progressId,
          index,
          label,
          ...phaseContext,
          outcome: 'skipped',
          reason: 'user',
          ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
          durationMs: Date.now() - startedAt,
        });
        // First-class SKIPPED value, not journaled — a resume re-runs it.
        return JSON.stringify(WORKFLOW_SKIPPED_RESULT);
      }

      if (attemptError) {
        // A runner may surface the run abort (its signal cascades from
        // runAbort); that must stop the workflow, not degrade into a null.
        if (isWorkflowAbort(attemptError.error) && !cleanupAbortStarted) {
          const fatal = rememberFatalRunError(attemptError.error);
          emitFailedEnd(fatal, attemptMetadata());
          throw fatal;
        }
        // A failed agent resolves to null and is deliberately NOT journaled, so
        // a resume retries it. Callers also exclude the truthy skip sentinel.
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
        await recordJournalEntry({
          index,
          key,
          keyFormat: WORKFLOW_JOURNAL_KEY_FORMAT.DEPENDENCY_AWARE_V3,
          result: normalizedResult,
        });
      } catch (error) {
        emitFailedEnd(error, attemptMetadata());
        throw error;
      }
      emit({
        type: 'agent:end',
        progressId,
        index,
        label,
        ...phaseContext,
        outcome: 'completed',
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        durationMs: Date.now() - startedAt,
      });
      return payload;
    }
  }

  const argsJson = serializeBridgeValue(options.args, 'Workflow args');
  const files = WorkflowScriptFilesSchema.parse(options.files ?? {});
  const filesJson = stableStringify(files);
  const abortFromParent = () => runAbort.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromParent, { once: true });
  if (options.signal?.aborted) abortFromParent();

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
            currentPhase = normalizeWorkflowScriptPhaseTitle(String(args[0]));
            const { phaseIndex, phaseTotal } = phaseContextFor(currentPhase);
            emit({
              type: 'phase',
              title: currentPhase,
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
        onTimeout: () => runAbort.abort(),
      },
    );
  } catch (error) {
    scriptFailure = { error };
  } finally {
    options.signal?.removeEventListener('abort', abortFromParent);
    // Abort unconditionally once the sandbox returns. This stops in-flight
    // work the script abandoned and makes agentPrimitive reject any late call.
    cleanupAbortStarted = !runAbort.signal.aborted;
    runAbort.abort();
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
        fallback: () => undefined,
      });
    }
  }

  // Guest code may catch an agent() rejection, and an abandoned call can
  // reject while the final drain is running. Checkpoint failure is a run-level
  // invariant, so inspect it only after every bounded cleanup opportunity.
  if (fatalRunError) throw fatalRunError;
  if (scriptFailure) throw scriptFailure.error;

  return {
    meta,
    result,
    journal: [...journal.values()].toSorted((a, b) => a.index - b.index),
    agentCalls: callCounter,
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

function deserializeBridgeValue(payload: string | undefined): unknown {
  return payload === undefined ? undefined : JSON.parse(payload);
}

function normalizeAgentOptions(raw: unknown): WorkflowAgentCallOptions {
  if (
    (raw !== undefined && raw !== null && typeof raw !== 'object') ||
    Array.isArray(raw)
  ) {
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
  for (const field of ['id', 'label', 'phase', 'agentName', 'model'] as const) {
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

  const requestedFiles = {
    ...(source.inputFiles !== undefined && {
      inputFiles: source.inputFiles,
    }),
    ...(source.contextFiles !== undefined && {
      contextFiles: source.contextFiles,
    }),
    ...(source.mediaFiles !== undefined && {
      mediaFiles: source.mediaFiles,
    }),
  };
  let files: WorkflowScriptFiles;
  try {
    files = WorkflowScriptFilesSchema.parse(requestedFiles);
  } catch (error) {
    throw new Error(
      `agent() options "inputFiles", "contextFiles", and "mediaFiles" must be arrays of non-empty strings: ${toErrorMessage(error)}`,
    );
  }
  const hasFileOptions = Object.keys(requestedFiles).length > 0;

  if (schema !== undefined) {
    if (hasFileOptions) {
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
  return {
    ...common,
    ...(source.inputFiles !== undefined && { inputFiles: files.inputFiles }),
    ...(source.contextFiles !== undefined && {
      contextFiles: files.contextFiles,
    }),
    ...(source.mediaFiles !== undefined && { mediaFiles: files.mediaFiles }),
  };
}
