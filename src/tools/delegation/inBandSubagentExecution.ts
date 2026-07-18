/**
 * In-band native subagent execution for callers that consume a typed result.
 *
 * This is the synchronous counterpart to `childRunLoop`: it owns child
 * registration, execution, post-flow artifact construction, result persistence,
 * and caller cancellation. XML presentation remains in a separate adapter for
 * the existing delegation tool.
 */

// Local imports - agent runtime and storage
import {
  getExecutionStore,
  registerExecution,
  releaseOwnedExecutionLeaseAfterFailure,
  type ResultMeta,
} from '@agent/storage';
import {
  markOwnedExecutionLeaseUndurable,
  ownsExecutionLease,
} from '@agent/storage/executionLease';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import {
  getAgentFlowErrorResult,
  type AgentFlowResult,
} from '@agent/runtime/AgentFlowResult';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { AgentRunHandle } from '@agent/runtime/ExecutionHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { releaseExecutionLeaseAfterArtifacts } from '@agent/runtime/executionOwnership';
import * as logger from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  persistChildRunReport,
  persistChildRunResultMeta,
} from '@tools/childRunDelivery';
import {
  buildSubagentFailureResultMeta,
  formatSubagentError,
} from '@tools/subagentResults';
import { generateExecutionId, KeyedMutex } from '@utils/core';
import { deriveExecutionId } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - delegation
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

const LOG_CHANNEL = 'inBandSubagentExecution';

interface InBandSubagentExecutionBaseOptions {
  readonly configPayload: AgentConfigPayload;
  readonly agentName: string;
  readonly parentStreamId: StreamTabId;
  readonly runtimeHost: AgentRuntimeHost;
  readonly session: SessionHandle;
  readonly approvalPromptsUnavailable?: boolean;
  readonly runtimeUnavailableTools?: readonly string[];
  readonly signal?: AbortSignal;
  readonly onStreamResolved?: (streamId: StreamTabId) => void;
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

/** Legacy delivery callers may still provide a bare one-shot run context. */
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
  logger.warn(
    LOG_CHANNEL,
    `Failed to persist subagent ${kind} for ${executionId}: ${toErrorMessage(error)}`,
  );
}

async function persistResultMetaBestEffort(
  executionId: ExecutionId,
  resultMeta: ResultMeta,
): Promise<void> {
  const result = await persistChildRunResultMeta(executionId, resultMeta);
  if (result.kind === 'failed') {
    logPersistenceFailure('result manifest', executionId, result.err);
  }
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

async function persistReportBestEffort(
  executionId: ExecutionId,
  report: string,
): Promise<void> {
  const result = await persistChildRunReport(executionId, report);
  if (result.kind === 'failed') {
    logPersistenceFailure('report', executionId, result.err);
  }
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

/** Bind caller cancellation to the live child while its flow is running. */
function bindAbortSignal(
  signal: AbortSignal | undefined,
  handle: AgentRunHandle,
): () => void {
  if (!signal) return () => {};
  const interrupt = (): void => {
    handle.interrupt();
  };
  if (signal.aborted) {
    interrupt();
    return () => {};
  }
  signal.addEventListener('abort', interrupt, { once: true });
  return () => signal.removeEventListener('abort', interrupt);
}

function createCostSettler(
  onCost: InBandSubagentExecutionBaseOptions['onCost'],
): (totalCostUsd: number | undefined) => void {
  let settled = false;
  return (totalCostUsd) => {
    if (settled) return;
    settled = true;
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
  };
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

  // Lazy import: the agent runtime loads delegation tools through its registry.
  // Keeping this edge lazy avoids closing that registry cycle at module load.
  const { executeAgent } = await import('@agent/runtime/executeAgent');
  const config = AgentConfigSchema.parse(options.configPayload);
  const startedAt = Date.now();
  const workingDirectory = config.workingDirectory ?? undefined;
  const settleCost = createCostSettler(options.onCost);

  try {
    await registerExecution(
      executionId,
      config,
      options.agentName,
      options.parentExecutionId,
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
  if (stableAttempt) {
    try {
      await writeStableSubagentAttempt(getExecutionStore(executionId), {
        ...stableAttempt,
        phase: 'launched',
      });
    } catch (cause) {
      throw await releaseOwnedExecutionLeaseAfterFailure(
        executionId,
        new SubagentDurabilityError(
          `Failed to mark subagent ${executionId} as launched.`,
          { cause },
        ),
      );
    }
  }

  let runError: unknown;
  let detachAbort = (): void => {};
  let flowResult: AgentFlowResult;
  try {
    flowResult = await executeAgent(config, executionId, {
      runtimeHost: options.runtimeHost,
      session: options.session,
      isSubagent: true,
      enforceCategory: true,
      parentStreamId: options.parentStreamId,
      approvalPromptsUnavailable: options.approvalPromptsUnavailable,
      runtimeUnavailableTools: options.runtimeUnavailableTools,
      stopAfterCycle: true,
      onStreamResolved: options.onStreamResolved,
      onRunError: (error) => {
        runError = error;
      },
      onRun: (handle) => {
        detachAbort();
        detachAbort = bindAbortSignal(options.signal, handle);
      },
    });
  } catch (error) {
    const errorResult = getAgentFlowErrorResult(error);
    settleCost(errorResult?.totalCostUsd);
    await persistFailure(
      mode,
      executionId,
      stableAttempt,
      options.agentName,
      options.parentExecutionId,
      config.agentCategory,
      error,
      errorResult,
      startedAt,
      workingDirectory,
    );
    throw error;
  } finally {
    detachAbort();
  }

  settleCost(flowResult.totalCostUsd);
  if (flowResult.outcome === 'failed') {
    const error = runError ?? new Error('Subagent ended with failed outcome.');
    await persistFailure(
      mode,
      executionId,
      stableAttempt,
      options.agentName,
      options.parentExecutionId,
      config.agentCategory,
      error,
      flowResult,
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
        workingDirectory,
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
    await persistReportBestEffort(
      executionId,
      formatSubagentError(executionId, options.agentName, error, {
        wallTimeMs: Date.now() - startedAt,
        workingDirectory,
        memoryMisses: flowResult.memoryMisses,
      }),
    );
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
      await persistResultMetaBestEffort(executionId, built.resultMeta);
      await persistReportBestEffort(
        executionId,
        formatSubagentError(executionId, options.agentName, error, {
          wallTimeMs: built.wallTimeMs,
          workingDirectory,
          memoryMisses: flowResult.memoryMisses,
        }),
      );
      throw error;
    }
    await persistDeliveryBestEffort(executionId, delivery, built.resultMeta);
  }

  // Post-flow artifact construction deliberately reaches a terminal record.
  // Cancellation observed here rejects the caller without changing that record.
  options.signal?.throwIfAborted();
  return { executionId, built, delivery };
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
    let executionFailure: InBandExecutionFailure | undefined;
    try {
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
    } catch (error) {
      markOwnedExecutionLeaseUndurable(executionId);
      executionFailure = { error };
      throw error;
    } finally {
      await releaseInBandExecutionLease(
        prepared.session,
        executionId,
        executionFailure,
      );
    }
  });
}

/** Preserve the existing headless delegation tool's XML/report behavior. */
export async function executeSubagentForDeliveryInBand(
  options: InBandSubagentDeliveryOptions,
): Promise<InBandSubagentDeliveryResult> {
  const executionId = generateExecutionId() as ExecutionId;
  let executionFailure: InBandExecutionFailure | undefined;
  try {
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
}
