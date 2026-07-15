/**
 * In-band native subagent execution for callers that consume a typed result.
 *
 * This is the synchronous counterpart to `childRunLoop`: it owns child
 * registration, execution, post-flow artifact construction, result persistence,
 * and caller cancellation. XML presentation remains in a separate adapter for
 * the existing delegation tool.
 */

import { registerExecution, type ResultMeta } from '@agent/storage';
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
import type { AgentRunHandle } from '@agent/runtime/executionRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
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
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  buildSubagentResult,
  formatBuiltSubagentDelivery,
  type BuiltSubagentResult,
} from './subagentDeliveryFormat';

const LOG_CHANNEL = 'inBandSubagentExecution';
logger.initialize(LOG_CHANNEL);

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
  readonly flowResult: AgentFlowResult;
  readonly built: BuiltSubagentResult;
  readonly delivery?: string;
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
    throw new Error(`Failed to persist result for subagent ${executionId}.`, {
      cause: result.err,
    });
  }
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
  agentName: string,
  fallbackCategory: AgentFlowResult['category'],
  error: unknown,
  result: AgentFlowResult | undefined,
  startedAt: number,
  workingDirectory: string | undefined,
): Promise<void> {
  const wallTimeMs = Date.now() - startedAt;
  const resultMeta = buildSubagentFailureResultMeta(
    agentName,
    fallbackCategory,
    result,
    wallTimeMs,
  );
  if (mode === 'required-result') {
    // Preserve the execution error even if its diagnostic manifest cannot be
    // written; a failed call is never journaled by the workflow engine.
    await persistResultMetaBestEffort(executionId, resultMeta);
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
): Promise<CompletedInBandSubagent> {
  options.signal?.throwIfAborted();

  // Lazy import: the agent runtime loads delegation tools through its registry.
  // Keeping this edge lazy avoids closing that registry cycle at module load.
  const { executeAgent } = await import('@agent/runtime/executeAgent');
  const executionId = generateExecutionId() as ExecutionId;
  const config = AgentConfigSchema.parse(options.configPayload);
  const startedAt = Date.now();
  const workingDirectory = config.workingDirectory ?? undefined;
  const settleCost = createCostSettler(options.onCost);

  await registerExecution(
    executionId,
    config,
    options.agentName,
    options.parentExecutionId,
  );

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
      options.agentName,
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
      options.agentName,
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
      { startedAt, workingDirectory },
    );
  } catch (error) {
    // The runtime has already finalized this child. A post-flow construction
    // error must not rewrite a completed execution as failed or try to parse
    // the same invalid flow data again through the failure-result builder.
    if (mode === 'best-effort-delivery') {
      await persistReportBestEffort(
        executionId,
        formatSubagentError(executionId, options.agentName, error, {
          wallTimeMs: Date.now() - startedAt,
          workingDirectory,
          memoryMisses: flowResult.memoryMisses,
        }),
      );
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
  return { executionId, flowResult, built, delivery };
}

/** Run a direct child and return the durable, XML-free result envelope. */
export async function executeSubagentInBand(
  options: InBandSubagentExecutionOptions,
): Promise<InBandSubagentExecutionResult> {
  const completed = await executeInBand(options, 'required-result');
  return {
    executionId: completed.executionId,
    result: completed.built.result,
  };
}

/** Preserve the existing headless delegation tool's XML/report behavior. */
export async function executeSubagentForDeliveryInBand(
  options: InBandSubagentDeliveryOptions,
): Promise<InBandSubagentDeliveryResult> {
  const completed = await executeInBand(options, 'best-effort-delivery');
  if (completed.delivery === undefined) {
    throw new Error('Subagent delivery was not constructed.');
  }
  return {
    executionId: completed.executionId,
    result: completed.built.result,
    delivery: completed.delivery,
  };
}
