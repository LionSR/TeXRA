/**
 * In-band native subagent execution for callers that consume a typed result.
 *
 * This is the durable synchronous composition of the same native strategy
 * `childRunLoop` drives for detached delegation. It adds stable physical-attempt
 * reservation/recovery and required result persistence around that standard
 * launch primitive; XML presentation remains a delivery adapter.
 *
 * The attempt ledger here is physical: it records reservation and launch edges
 * for one model run. The workflow journal is logical: it records an `agent()`
 * call's replayable value. Journal replay is checked first by the workflow
 * engine; only a journal miss enters this physical attempt layer.
 */

// Local imports
import { getExecutionStore, type ResultMeta } from '@agent/storage';
import { registerOwnedExecution } from '@agent/storage/executionLifecycle';
import {
  ExecutionLeaseLostError,
  runWithInactiveExecutionLease,
  type OwnedExecutionLeaseScope,
} from '@agent/storage/executionLease';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import { getStreamTabId } from '@agent/runtime/streamTab';
import * as logger from '@logger/logUtils';
import {
  RUN_OUTCOME,
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { generateExecutionId, KeyedMutex } from '@utils/core';
import { deriveExecutionId } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  startDetachedChildRunLoop,
  type DetachedChildRunInput,
} from './detachedChildRun';
import {
  readStableSubagentAttempt,
  readStableSubagentSequence,
  reservedStableSubagentAttempt,
  writeStableSubagentAttempt,
  writeStableSubagentSequence,
  type StableSubagentAttempt,
  type StableSubagentSequence,
} from './stableSubagentAttempt';
import {
  createNativeSubagentStrategy,
  type ChildRunLaunchOptions,
} from './nativeSubagentStrategy';

const LOG_CHANNEL = 'inBandSubagentExecution';

interface InBandSubagentExecutionBaseOptions extends ChildRunLaunchOptions {
  readonly configPayload: AgentConfigPayload;
  readonly onCost?: (totalCostUsd: number | undefined) => void | Promise<void>;
  /**
   * Live progress sink for the in-band child. An in-band parent is mid-cycle,
   * so follow-up delivery cannot reach it — each caller degrades deliberately:
   * the headless delegation arm projects progress onto the parent run's trace,
   * and the workflow-script arm omits this because the engine already carries
   * grandchild progress on its own channel (`WorkflowScriptEvent`). Absent
   * therefore means deliberately silent, not accidentally dropped.
   */
  readonly notify?: (update: SubagentProgressUpdate) => void;
}

/** Options for the typed child API. Direct persisted parentage is required. */
export interface InBandSubagentExecutionOptions extends InBandSubagentExecutionBaseOptions {
  readonly parentExecutionId: ExecutionId;
}

export interface StableInBandSubagentExecutionOptions {
  /** Cryptographic identity of the prompt/options call, stable across restart. */
  readonly executionId: ExecutionId;
  readonly parentExecutionId: ExecutionId;
  readonly signal?: AbortSignal;
  /** Resolve mutable launch prerequisites only when no result can be recovered. */
  readonly prepare: () => Promise<InBandSubagentExecutionOptions>;
  /**
   * Fires once, just before a live attempt runs, with the execution id that
   * attempt actually uses — the logical id on attempt 0, an attempt-specific
   * id after a durable retry advanced the sequence. This is the id the child
   * stream registers under and the roster exposes, so a host targeting the
   * in-flight child (skip/retry) must key on it, not the pre-derived logical
   * id. Recovered attempts never run live, so this does not fire for them.
   */
  readonly onActiveExecutionId?: (executionId: ExecutionId) => void;
}

/**
 * Options for the XML-delivery API. A one-shot run context need not have a
 * persisted parent execution, so parentage is optional here.
 */
export interface InBandSubagentDeliveryOptions extends InBandSubagentExecutionBaseOptions {
  readonly parentExecutionId?: ExecutionId;
}

export interface InBandSubagentExecutionResult {
  readonly executionId: ExecutionId;
  readonly result: AgentFinalResult;
}

export interface InBandSubagentDeliveryResult extends InBandSubagentExecutionResult {
  readonly delivery: string;
}

type PersistenceMode = 'required-result' | 'best-effort-delivery';

type SettledInBandTurn = Parameters<
  NonNullable<DetachedChildRunInput<never>['onTurnSettled']>
>[0];

interface CompletedInBandSubagent {
  readonly executionId: ExecutionId;
  readonly result: AgentFinalResult;
  readonly delivery?: string;
}

type StableAttemptInspection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'advance' }
  | {
      readonly kind: 'recovered';
      readonly result: InBandSubagentExecutionResult;
    };

export class SubagentDurabilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SubagentDurabilityError';
  }
}

export class SubagentReconciliationError extends SubagentDurabilityError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SubagentReconciliationError';
  }
}

const MAX_STABLE_ATTEMPTS = 1_024;

// Parent execution ownership is process-local. Serialize duplicate dispatches
// within that owner while durable manifests handle later restart recovery.
const stableExecutionMutex = new KeyedMutex<ExecutionId>();

function stableAttemptExecutionId(
  logicalExecutionId: ExecutionId,
  attempt: number,
): ExecutionId {
  if (attempt === 0) return logicalExecutionId;
  return deriveExecutionId({ attempt, logicalExecutionId });
}

async function inspectStableAttempt(
  options: Pick<
    StableInBandSubagentExecutionOptions,
    'executionId' | 'parentExecutionId' | 'signal'
  >,
  executionId: ExecutionId,
): Promise<StableAttemptInspection> {
  const store = getExecutionStore(executionId);
  let persisted: [string[], StableSubagentAttempt | null, ResultMeta | null];
  try {
    persisted = await Promise.all([
      store.listKeys(),
      readStableSubagentAttempt(store),
      store.readResultMeta(),
    ]);
  } catch (error) {
    throw new SubagentReconciliationError(
      `Failed to inspect persisted subagent ${executionId}.`,
      { cause: error },
    );
  }
  const [keys, attempt, resultMeta] = persisted;
  if (keys.length === 0) return { kind: 'absent' };
  if (
    !attempt ||
    attempt.logicalExecutionId !== options.executionId ||
    attempt.parentExecutionId !== options.parentExecutionId
  ) {
    throw new SubagentReconciliationError(
      `Persisted subagent ${executionId} does not belong to this stable workflow call; refusing to reuse or repeat it.`,
    );
  }
  if (!resultMeta) {
    if (attempt.phase !== 'launched') return { kind: 'advance' };
    // A launched attempt without a manifest is unsafe to repeat only if the
    // child may have finished side-effectful work whose manifest was lost:
    // a recorded completed turn or a persisted COMPLETED outcome proves the
    // settle path ran, so those stay irreconcilable. Otherwise the child
    // never reached terminal persistence (interrupted, or its artifact drain
    // failed and the parent's failure-time retryable write was refused as
    // lease-lost) — repair the marker here, under the inactive-lease fence
    // so a live child's still-held lease keeps refusing the write.
    let settledEvidence: boolean;
    try {
      const [turnState, meta] = await Promise.all([
        store.readTurnState(),
        store.readMeta(),
      ]);
      settledEvidence =
        turnState?.lastCompletedTurn !== undefined ||
        meta?.outcome === RUN_OUTCOME.COMPLETED;
    } catch (error) {
      throw new SubagentReconciliationError(
        `Failed to inspect persisted subagent ${executionId}.`,
        { cause: error },
      );
    }
    if (!settledEvidence) {
      const repair = await runWithInactiveExecutionLease(executionId, () =>
        writeStableSubagentAttempt(store, {
          ...attempt,
          phase: 'retryable',
        }),
      ).catch((error: unknown) => {
        throw new SubagentReconciliationError(
          `Failed to repair the unsettled launched subagent ${executionId}.`,
          { cause: error },
        );
      });
      if (repair.status === 'performed') return { kind: 'advance' };
      throw new SubagentReconciliationError(
        `Subagent ${executionId} is still running under a live lease; refusing to repeat it.`,
      );
    }
    throw new SubagentReconciliationError(
      `Cannot reconcile incomplete persisted subagent ${executionId}; refusing to repeat it.`,
    );
  }
  if (attempt.phase === 'reserved') {
    throw new SubagentReconciliationError(
      `Persisted subagent ${executionId} has a result without a launch marker; refusing to reuse it.`,
    );
  }
  if (resultMeta.producer !== 'subagent') {
    throw new SubagentReconciliationError(
      `Persisted subagent ${executionId} does not match this workflow call; refusing to reuse or repeat it.`,
    );
  }
  if (resultMeta.parentExecutionId !== options.parentExecutionId) {
    throw new SubagentReconciliationError(
      `Persisted subagent ${executionId} has different parent lineage; refusing to reuse or repeat it.`,
    );
  }
  if (resultMeta.result.outcome !== 'completed') return { kind: 'advance' };
  options.signal?.throwIfAborted();
  return {
    kind: 'recovered',
    result: { executionId, result: resultMeta.result },
  };
}

async function throwRetryableDurabilityError(
  executionId: ExecutionId,
  stableAttempt: StableSubagentAttempt | undefined,
  error: SubagentDurabilityError,
): Promise<never> {
  if (!stableAttempt) throw error;
  const marker = { ...stableAttempt, phase: 'retryable' as const };
  try {
    await writeStableSubagentAttempt(getExecutionStore(executionId), marker);
  } catch (cause) {
    // A child whose artifact drain failed abandons its lease with the record
    // retained, so this parent-side write is refused as lease-lost until the
    // stale horizon. The refusal is not a recovery failure: reconciliation
    // repairs an unsettled launched attempt on the next resume (see
    // inspectStableAttempt), so surface the original durability error alone.
    if (cause instanceof ExecutionLeaseLostError) {
      const repair = await runWithInactiveExecutionLease(executionId, () =>
        writeStableSubagentAttempt(getExecutionStore(executionId), marker),
      ).catch((repairError: unknown) => {
        logger.warn(LOG_CHANNEL, 'Retryable-marker repair write failed', {
          data: { executionId, error: repairError },
        });
        return undefined;
      });
      if (repair?.status !== 'performed') {
        logger.warn(
          LOG_CHANNEL,
          'Deferred retryable marker to resume-time reconciliation: the child lease is still held',
          { data: { executionId } },
        );
      }
      throw error;
    }
    throw new SubagentDurabilityError(
      `${error.message} Failed to mark the stable attempt as retryable.`,
      {
        cause: new AggregateError(
          [error, cause],
          `Subagent ${executionId} durability recovery also failed.`,
        ),
      },
    );
  }
  throw error;
}

function recordCost(
  onCost: InBandSubagentExecutionBaseOptions['onCost'],
  totalCostUsd: number | undefined,
): void {
  try {
    const observed = onCost?.(totalCostUsd);
    void Promise.resolve(observed).catch((error: unknown) => {
      logger.warn(LOG_CHANNEL, 'Subagent cost observer rejected', {
        data: error,
      });
    });
  } catch (error) {
    logger.warn(LOG_CHANNEL, 'Subagent cost observer failed', {
      data: error,
    });
  }
}

/**
 * Execute one child through the one shared driver and read its typed result
 * back from the durable record. The child runs under the same detached
 * child-run loop every native child uses (single-cycle strategy, persist-only
 * delivery); "in-band" is only this caller awaiting the loop's completion.
 * Once the run reaches its own terminal persistence, later caller
 * cancellation rejects the awaiting stage but never rewrites the record.
 *
 * Failure taxonomy at the read-back boundary:
 * - completion rejected, or no result manifest exists afterwards → the
 *   infrastructure failed before the child's terminal persistence; durable
 *   callers mark the stable attempt retryable (SubagentDurabilityError).
 * - manifest present with a failed outcome → the child itself failed; the
 *   persisted terminal error message is the thrown message.
 * - manifest present with completed/cancelled outcome → returned typed.
 */
async function executeInBand(
  options: InBandSubagentDeliveryOptions,
  mode: PersistenceMode,
  executionId: ExecutionId,
  stableAttempt?: StableSubagentAttempt,
): Promise<CompletedInBandSubagent> {
  options.signal?.throwIfAborted();

  const config = AgentConfigSchema.parse(options.configPayload);
  const startedAt = Date.now();
  const workingDirectory = config.workingDirectory ?? undefined;
  const childStreamId = getStreamTabId(config.agent, { executionId });

  let runWithOwnership: OwnedExecutionLeaseScope;
  try {
    runWithOwnership = await registerOwnedExecution(
      executionId,
      config,
      options.agentName,
      {
        streamId: childStreamId,
        identity: { kind: 'agent', agent: config.agent },
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
        parentExecutionId: options.parentExecutionId,
      },
    );
  } catch (cause) {
    if (mode === 'required-result') {
      throw new SubagentDurabilityError(
        `Failed to register subagent ${executionId}.`,
        { cause },
      );
    }
    throw cause;
  }
  return await runWithOwnership(async () => {
    let settledTurn: SettledInBandTurn | undefined;
    const { completion } = await startDetachedChildRunLoop({
      executionId,
      parentStreamId: options.parentStreamId,
      childStreamId,
      agentName: options.agentName,
      recordCost: (totalCostUsd) => recordCost(options.onCost, totalCostUsd),
      // The parent is blocked awaiting this child, so it rides the parent's
      // budget slot (child-run budget design note).
      budgeted: false,
      ...(options.notify !== undefined && { notify: options.notify }),
      onTurnSettled: (settled) => {
        settledTurn = settled;
      },
      buildLaunch: async () => {
        // Inside the loop's lease launch guard, like every attempt-scoped
        // setup: a throw here releases the owned-execution lease.
        if (stableAttempt) {
          try {
            await writeStableSubagentAttempt(getExecutionStore(executionId), {
              ...stableAttempt,
              phase: 'launched',
            });
          } catch (cause) {
            throw new SubagentDurabilityError(
              `Failed to mark subagent ${executionId} as launched.`,
              { cause },
            );
          }
        }
        return {
          strategy: createNativeSubagentStrategy({
            ...options,
            config,
            agentCategoryExplicit: true,
            executionId,
            startedAt,
            workingDirectory,
            executionMode: 'single-cycle',
            resultOnly: mode === 'required-result',
            onStreamResolved: options.onStreamResolved ?? (() => {}),
          }),
        };
      },
    });

    let loopFailure: unknown;
    try {
      await completion;
    } catch (error) {
      loopFailure = error;
    }

    // The loop handed this caller the settled turn's facts in memory
    // (persistence stays best-effort loop-side); no turn settling means the
    // run was interrupted or the infrastructure failed before terminal
    // persistence — durable callers mark the attempt retryable.
    const resultMeta = settledTurn?.resultMeta;
    if (!settledTurn || !resultMeta || resultMeta.producer !== 'subagent') {
      const failure = new SubagentDurabilityError(
        `Subagent ${executionId} ended without a settled typed result (interrupted before terminal persistence, or the run loop failed).`,
        loopFailure !== undefined ? { cause: loopFailure } : undefined,
      );
      if (mode === 'required-result') {
        await throwRetryableDurabilityError(
          executionId,
          stableAttempt,
          failure,
        );
      }
      throw failure;
    }

    const result = resultMeta.result;
    const childFailed =
      settledTurn.isError || result.outcome === RUN_OUTCOME.FAILED;

    if (
      mode === 'required-result' &&
      loopFailure !== undefined &&
      !childFailed
    ) {
      await throwRetryableDurabilityError(
        executionId,
        stableAttempt,
        new SubagentDurabilityError(
          `Subagent ${executionId} failed to persist its final artifacts.`,
          { cause: loopFailure },
        ),
      );
    }

    if (mode === 'required-result') {
      // The ledger recovers restarts by inspecting the persisted manifest, so
      // the in-memory copy is not enough here: verify the write landed. A
      // FAILED child's attempt is marked retryable (re-running a failed child
      // is safe); a COMPLETED child whose manifest did not persist keeps its
      // 'launched' marker, so a later run refuses to repeat side-effectful
      // work rather than executing it twice.
      let persisted: ResultMeta | null;
      try {
        persisted = await getExecutionStore(executionId).readResultMeta();
      } catch (cause) {
        persisted = null;
        void cause;
      }
      if (!persisted) {
        if (childFailed) {
          const childError =
            settledTurn.error ??
            new Error(
              result.error?.message ??
                `Subagent ${executionId} ended with failed outcome.`,
            );
          await throwRetryableDurabilityError(
            executionId,
            stableAttempt,
            new SubagentDurabilityError(
              `Subagent ${executionId} failed (${toErrorMessage(childError)}), and its failure result could not be persisted.`,
              {
                cause: new AggregateError(
                  [childError],
                  `Subagent ${executionId} execution and persistence both failed.`,
                ),
              },
            ),
          );
        }
        throw new SubagentDurabilityError(
          `Failed to persist result for subagent ${executionId}.`,
        );
      }
    }

    if (childFailed) {
      // The raw application error when the turn threw; otherwise the typed
      // result's own structured error (the result-only contract).
      throw (
        settledTurn.error ??
        new Error(
          result.error?.message ??
            `Subagent ${executionId} ended with failed outcome.`,
        )
      );
    }

    // Post-run cancellation deliberately observes a terminal record:
    // rejecting here fails the awaiting caller without rewriting the child.
    options.signal?.throwIfAborted();
    return {
      executionId,
      result,
      ...(mode === 'best-effort-delivery' && { delivery: settledTurn.message }),
    };
  });
}

/** Recover a logical child first; resolve launch-only state only when needed. */
export async function executeStableSubagentInBand(
  options: StableInBandSubagentExecutionOptions,
): Promise<InBandSubagentExecutionResult> {
  return stableExecutionMutex.runExclusive(options.executionId, async () => {
    options.signal?.throwIfAborted();
    // The parent sequence enumerates every reserved child ID. Individual child
    // markers own launch state, so a deleted early directory cannot become a
    // reusable hole or hide a later completed result.
    const parentStore = getExecutionStore(options.parentExecutionId);
    let sequence: StableSubagentSequence | null;
    try {
      sequence = await readStableSubagentSequence(
        parentStore,
        options.executionId,
      );
    } catch (cause) {
      throw new SubagentReconciliationError(
        `Failed to inspect the attempt sequence for subagent ${options.executionId}.`,
        { cause },
      );
    }
    if (
      sequence &&
      (sequence.logicalExecutionId !== options.executionId ||
        sequence.parentExecutionId !== options.parentExecutionId)
    ) {
      throw new SubagentReconciliationError(
        `Persisted attempt sequence for subagent ${options.executionId} has different ownership.`,
      );
    }
    let nextAttempt = sequence?.nextAttempt ?? 0;
    if (nextAttempt > MAX_STABLE_ATTEMPTS) {
      throw new SubagentReconciliationError(
        `Subagent ${options.executionId} has an invalid durable-attempt count.`,
      );
    }

    let unresolved: SubagentReconciliationError | undefined;
    for (let attempt = 0; attempt < nextAttempt; attempt += 1) {
      const candidate = stableAttemptExecutionId(options.executionId, attempt);
      try {
        const inspection = await inspectStableAttempt(options, candidate);
        if (inspection.kind === 'recovered') return inspection.result;
        if (inspection.kind === 'absent') {
          unresolved ??= new SubagentReconciliationError(
            `Recorded subagent attempt ${candidate} is missing; refusing to repeat it.`,
          );
        }
      } catch (error) {
        if (!(error instanceof SubagentReconciliationError)) throw error;
        unresolved ??= error;
      }
    }
    if (unresolved) throw unresolved;

    let executionId: ExecutionId;
    let candidateInspection: StableAttemptInspection;
    while (true) {
      if (nextAttempt >= MAX_STABLE_ATTEMPTS) {
        throw new SubagentReconciliationError(
          `Subagent ${options.executionId} exceeded the ${MAX_STABLE_ATTEMPTS} durable-attempt limit.`,
        );
      }
      executionId = stableAttemptExecutionId(options.executionId, nextAttempt);
      candidateInspection = await inspectStableAttempt(options, executionId);
      if (candidateInspection.kind === 'recovered') {
        return candidateInspection.result;
      }
      if (candidateInspection.kind !== 'advance') break;
      nextAttempt += 1;
      try {
        await writeStableSubagentSequence(
          parentStore,
          options.executionId,
          options.parentExecutionId,
          nextAttempt,
        );
      } catch (cause) {
        throw new SubagentDurabilityError(
          `Failed to advance the attempt sequence for subagent ${options.executionId}.`,
          { cause },
        );
      }
    }
    const attempt = reservedStableSubagentAttempt(
      options.executionId,
      options.parentExecutionId,
    );
    if (candidateInspection.kind === 'absent') {
      try {
        await writeStableSubagentAttempt(
          getExecutionStore(executionId),
          attempt,
        );
      } catch (cause) {
        throw new SubagentDurabilityError(
          `Failed to reserve stable subagent ${executionId}.`,
          { cause },
        );
      }
    }
    try {
      await writeStableSubagentSequence(
        parentStore,
        options.executionId,
        options.parentExecutionId,
        nextAttempt + 1,
      );
    } catch (cause) {
      throw new SubagentDurabilityError(
        `Failed to publish stable subagent ${executionId}.`,
        { cause },
      );
    }
    // The resolved attempt id is now final and about to run live; surface it
    // so a host can target this in-flight attempt by the id the roster shows.
    options.onActiveExecutionId?.(executionId);
    const prepared = await options.prepare();
    if (prepared.parentExecutionId !== options.parentExecutionId) {
      throw new SubagentReconciliationError(
        `Prepared subagent ${executionId} changed its parent execution.`,
      );
    }
    const completed = await executeInBand(
      prepared,
      'required-result',
      executionId,
      attempt,
    );
    return {
      executionId: completed.executionId,
      result: completed.result,
    };
  });
}

/** Run one child and return its XML delivery alongside the typed result. */
export async function executeSubagentForDeliveryInBand(
  options: InBandSubagentDeliveryOptions,
): Promise<InBandSubagentDeliveryResult> {
  const executionId = generateExecutionId();
  const completed = await executeInBand(
    options,
    'best-effort-delivery',
    executionId,
  );
  if (completed.delivery === undefined) {
    throw new Error('Subagent delivery was not constructed.');
  }
  return {
    executionId: completed.executionId,
    result: completed.result,
    delivery: completed.delivery,
  };
}
