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
import {
  persistChildRunReport,
  persistChildRunResultMeta,
} from '@agent/storage/childRunPersistence';
import { registerOwnedExecution } from '@agent/storage/executionLifecycle';
import {
  markOwnedExecutionLeaseUndurable,
  ownsExecutionLease,
  type OwnedExecutionLeaseScope,
  runWithOwnedExecutionLeaseLaunchGuard,
} from '@agent/storage/executionLease';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import { getStreamTabId } from '@agent/runtime/streamTab';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { releaseExecutionLeaseAfterArtifacts } from '@agent/runtime/executionOwnership';
import * as logger from '@logger/logUtils';
import { USER_FOLLOW_UP_SUPPORT, type ExecutionId } from '@shared/schemas';
import { generateExecutionId, KeyedMutex } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { deriveExecutionId } from '@utils/core/idHash';
import {
  buildSubagentFailureResultMeta,
  formatSubagentError,
} from './subagentResults';

// Local file imports
// Type-only: the strategy module pulls in `@agent/runtime/executeAgent` at
// runtime (see the lazy import below), but a type import is erased at build.
import {
  buildSubagentResult,
  formatBuiltSubagentDelivery,
  type BuiltSubagentResult,
} from './subagentDeliveryFormat';
import {
  readStableSubagentAttempt,
  readStableSubagentSequence,
  reservedStableSubagentAttempt,
  writeStableSubagentAttempt,
  writeStableSubagentSequence,
  type StableSubagentAttempt,
  type StableSubagentSequence,
} from './stableSubagentAttempt';
import type { ChildRunLaunchOptions } from './nativeSubagentStrategy';

const LOG_CHANNEL = 'inBandSubagentExecution';

interface InBandSubagentExecutionBaseOptions extends ChildRunLaunchOptions {
  readonly configPayload: AgentConfigPayload;
  readonly onCost?: (totalCostUsd: number | undefined) => void | Promise<void>;
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

interface CompletedInBandSubagent {
  readonly executionId: ExecutionId;
  readonly built: BuiltSubagentResult;
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

interface InBandExecutionFailure {
  readonly error: unknown;
}

/** Release final ownership without letting cleanup replace the run failure. */
async function releaseInBandExecutionLease(
  session: SessionHandle,
  executionId: ExecutionId,
  executionFailure?: InBandExecutionFailure,
): Promise<void> {
  if (!ownsExecutionLease(executionId)) return;
  try {
    await releaseExecutionLeaseAfterArtifacts(session, executionId);
  } catch (releaseError) {
    if (!executionFailure) throw releaseError;
    logger.warn(
      LOG_CHANNEL,
      `Failed to persist final artifacts for failed subagent ${executionId}: ${toErrorMessage(releaseError)}`,
      {
        data: {
          executionError: executionFailure.error,
          releaseError,
        },
      },
    );
  }
}

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

function logPersistenceFailure(
  kind: 'report' | 'result manifest',
  executionId: ExecutionId,
  error: unknown,
): void {
  markOwnedExecutionLeaseUndurable(executionId);
  logger.warn(
    LOG_CHANNEL,
    `Failed to persist subagent ${kind} for ${executionId}: ${toErrorMessage(error)}`,
  );
}

async function persistResultMetaRequired(
  executionId: ExecutionId,
  resultMeta: ResultMeta,
): Promise<void> {
  const result = await persistChildRunResultMeta(executionId, resultMeta);
  if (result.kind === 'failed') {
    throw new SubagentDurabilityError(
      `Failed to persist result for subagent ${executionId}.`,
      { cause: result.err },
    );
  }
}

async function throwRetryableDurabilityError(
  executionId: ExecutionId,
  stableAttempt: StableSubagentAttempt | undefined,
  error: SubagentDurabilityError,
): Promise<never> {
  if (!stableAttempt) throw error;
  try {
    await writeStableSubagentAttempt(getExecutionStore(executionId), {
      ...stableAttempt,
      phase: 'retryable',
    });
  } catch (cause) {
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

async function persistDeliveryBestEffort(
  executionId: ExecutionId,
  delivery: string,
  resultMeta: ResultMeta,
): Promise<void> {
  const [reportResult, metaResult] = await Promise.all([
    persistChildRunReport(executionId, delivery),
    persistChildRunResultMeta(executionId, resultMeta),
  ]);
  if (reportResult.kind === 'failed') {
    logPersistenceFailure('report', executionId, reportResult.err);
  }
  if (metaResult.kind === 'failed') {
    logPersistenceFailure('result manifest', executionId, metaResult.err);
  }
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

async function persistFailure(
  mode: PersistenceMode,
  executionId: ExecutionId,
  stableAttempt: StableSubagentAttempt | undefined,
  agentName: string,
  parentExecutionId: ExecutionId | undefined,
  fallbackCategory: AgentFlowResult['category'],
  error: unknown,
  result: AgentFlowResult | undefined,
  startedAt: number,
  workingDirectory: string | undefined,
): Promise<void> {
  const wallTimeMs = Date.now() - startedAt;
  let resultMeta: ResultMeta;
  try {
    resultMeta = buildSubagentFailureResultMeta(
      agentName,
      fallbackCategory,
      result,
      wallTimeMs,
      { parentExecutionId },
    );
  } catch (cause) {
    if (mode === 'required-result') {
      await throwRetryableDurabilityError(
        executionId,
        stableAttempt,
        new SubagentDurabilityError(
          `Subagent ${executionId} failed (${toErrorMessage(error)}), and its failure result could not be constructed.`,
          {
            cause: new AggregateError(
              [error, cause],
              `Subagent ${executionId} execution and result construction both failed.`,
            ),
          },
        ),
      );
    }
    throw cause;
  }
  if (mode === 'required-result') {
    try {
      await persistResultMetaRequired(executionId, resultMeta);
    } catch (cause) {
      await throwRetryableDurabilityError(
        executionId,
        stableAttempt,
        new SubagentDurabilityError(
          `Subagent ${executionId} failed (${toErrorMessage(error)}), and its failure result could not be persisted.`,
          {
            cause: new AggregateError(
              [error, cause],
              `Subagent ${executionId} execution and persistence both failed.`,
            ),
          },
        ),
      );
    }
    return;
  }
  const delivery = formatSubagentError(executionId, agentName, error, {
    wallTimeMs,
    workingDirectory,
    memoryMisses: result?.memoryMisses,
  });
  await persistDeliveryBestEffort(executionId, delivery, resultMeta);
}

/**
 * Execute one child and construct its terminal typed result. Once
 * `executeAgent` returns, the child's outcome is fixed: later caller
 * cancellation may reject the waiting workflow stage, but it never rewrites
 * the completed child's manifest.
 */
async function executeInBand(
  options: InBandSubagentDeliveryOptions,
  mode: PersistenceMode,
  executionId: ExecutionId,
  stableAttempt?: StableSubagentAttempt,
): Promise<CompletedInBandSubagent> {
  options.signal?.throwIfAborted();

  // Lazy import: the strategy imports executeAgent, whose runtime registry
  // loads delegation tools. Keeping this edge lazy avoids closing that cycle.
  const { createNativeSubagentStrategy } =
    await import('./nativeSubagentStrategy.js');
  const config = AgentConfigSchema.parse(options.configPayload);
  const startedAt = Date.now();
  const workingDirectory = config.workingDirectory ?? undefined;

  let runWithOwnership: OwnedExecutionLeaseScope;
  try {
    runWithOwnership = await registerOwnedExecution(
      executionId,
      config,
      options.agentName,
      {
        streamId: getStreamTabId(config.agent, { executionId }),
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
    let executionFailure: InBandExecutionFailure | undefined;
    try {
      if (stableAttempt) {
        await runWithOwnedExecutionLeaseLaunchGuard(executionId, async () => {
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
        });
      }

      // The base options carry the shared ChildRunLaunchOptions fields, so a
      // spread forwards every launch option to the strategy automatically — a
      // new shared option needs a single declaration, not a second mapping.
      const strategy = createNativeSubagentStrategy({
        ...options,
        config,
        agentCategoryExplicit: true,
        executionId,
        startedAt,
        workingDirectory,
        executionMode: 'single-cycle',
        onStreamResolved: options.onStreamResolved ?? (() => {}),
      });
      let flowResult: AgentFlowResult;
      try {
        const turn = await strategy.launch(
          {
            notify: () => {},
            recordCost: (totalCostUsd) =>
              recordCost(options.onCost, totalCostUsd),
          },
          new AbortController(),
        );
        if (turn.outcome === 'waiting') {
          throw new Error(
            `Single-cycle subagent ${executionId} unexpectedly suspended.`,
          );
        }
        if (turn.outcome === 'failed') {
          throw (
            strategy.getTurnError() ??
            new Error('Subagent ended with failed outcome.')
          );
        }
        flowResult = turn;
      } catch (error) {
        await persistFailure(
          mode,
          executionId,
          stableAttempt,
          options.agentName,
          options.parentExecutionId,
          config.agentCategory,
          error,
          strategy.getTurnResult(),
          startedAt,
          workingDirectory,
        );
        throw error;
      }

      let built: BuiltSubagentResult;
      try {
        built = await buildSubagentResult(
          executionId,
          options.agentName,
          flowResult,
          {
            startedAt,
            parentExecutionId: options.parentExecutionId,
          },
        );
      } catch (error) {
        // The runtime has already finalized this child. A post-flow construction
        // error must not rewrite a completed execution as failed or try to parse
        // the same invalid flow data again through the failure-result builder.
        if (mode === 'required-result') {
          throw new SubagentDurabilityError(
            `Failed to construct result for subagent ${executionId}.`,
            { cause: error },
          );
        }
        const reportResult = await persistChildRunReport(
          executionId,
          formatSubagentError(executionId, options.agentName, error, {
            wallTimeMs: Date.now() - startedAt,
            workingDirectory,
            memoryMisses: flowResult.memoryMisses,
          }),
        );
        if (reportResult.kind === 'failed') {
          logPersistenceFailure('report', executionId, reportResult.err);
        }
        throw error;
      }

      let delivery: string | undefined;
      if (mode === 'required-result') {
        await persistResultMetaRequired(executionId, built.resultMeta);
      } else {
        try {
          delivery = formatBuiltSubagentDelivery(
            executionId,
            options.agentName,
            flowResult,
            built,
            workingDirectory,
          );
        } catch (error) {
          await persistDeliveryBestEffort(
            executionId,
            formatSubagentError(executionId, options.agentName, error, {
              wallTimeMs: built.wallTimeMs,
              workingDirectory,
              memoryMisses: flowResult.memoryMisses,
            }),
            built.resultMeta,
          );
          throw error;
        }
        await persistDeliveryBestEffort(
          executionId,
          delivery,
          built.resultMeta,
        );
      }

      // Post-flow artifact construction deliberately reaches a terminal record.
      // Cancellation observed here rejects the caller without changing that record.
      options.signal?.throwIfAborted();
      return { executionId, built, delivery };
    } catch (error) {
      markOwnedExecutionLeaseUndurable(executionId);
      executionFailure = { error };
      throw error;
    } finally {
      await releaseInBandExecutionLease(
        options.session,
        executionId,
        executionFailure,
      );
    }
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
      result: completed.built.result,
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
    result: completed.built.result,
    delivery: completed.delivery,
  };
}
