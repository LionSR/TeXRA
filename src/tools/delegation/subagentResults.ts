/**
 * Formatting utilities for subagent results and progress updates.
 *
 * Format helpers convert AgentFinalResult and progress updates into
 * structured XML strings for FollowUpQueue delivery to the orchestrator.
 *
 * Design: Typed objects internally, XML formatting only at the boundary
 * (just before injection into model context via FollowUpQueue).
 */

import type { ResultMeta } from '@agent/storage';
import type { AttachedMemoryMiss } from '@agent/types/AttachedMemory';
import type {
  AgentFlowCategory,
  AgentFlowResult,
} from '@agent/runtime/AgentFlowResult';
import {
  buildAgentFinalResult,
  type AgentFinalResult,
  type ResultDiffSummary,
} from '@agent/runtime/AgentFinalResult';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import type { ExecutionId, OutputFileSummary } from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { formatDuration, unique } from '@utils/core';
import {
  formatChildRunDelivery,
  formatChildRunError,
} from './deliveryEnvelope';

export type SubagentResultMeta = Extract<ResultMeta, { producer: 'subagent' }>;

// ============================================================================
// Formatting helpers
// ============================================================================

/**
 * Format a single output file summary as XML. `path` remains run-relative for
 * acceptance tools; `read-path` identifies the model-facing route to inspect
 * the generated artifact.
 * When diff info is provided, includes a `diff` attribute pointing to the diff
 * file path (readable via /executions/{id}/files/...). Large changes are
 * flagged with `large-change="true"` but still include a diff file.
 */
function formatOutputFile(
  o: OutputFileSummary,
  executionId: ExecutionId,
  diffInfo?: ResultDiffSummary,
): string {
  const readPath =
    o.location === 'runStorage'
      ? `/executions/${executionId}/files/${o.relativePath}`
      : o.absolutePath;
  const attrs = [
    `path="${escapeAttr(o.relativePath)}"`,
    `read-path="${escapeAttr(readPath)}"`,
    `location="${escapeAttr(o.location)}"`,
    o.originalPath !== null && `original="${escapeAttr(o.originalPath)}"`,
    o.added !== null && `added="${o.added}"`,
    o.removed !== null && `removed="${o.removed}"`,
  ]
    .filter(Boolean)
    .join(' ');

  if (diffInfo) {
    // Diff available as a file — orchestrator can read it on demand.
    const extra = diffInfo.largeChange ? ' large-change="true"' : '';
    return `<file ${attrs} diff="${escapeAttr(diffInfo.diffRelPath)}"${extra} />`;
  }
  return `<file ${attrs} />`;
}

/**
 * Format workflow output files, grouping by round when there are multiple rounds.
 * When diff info is provided, each <file> element includes a `diff` attribute
 * pointing to the diff file path (readable via /executions/{id}/files/...).
 */
function formatWorkflowOutputs(
  outputs: OutputFileSummary[],
  executionId: ExecutionId,
  diffInfos?: ReadonlyMap<string, ResultDiffSummary>,
): string[] {
  const format = (o: OutputFileSummary): string =>
    formatOutputFile(o, executionId, diffInfos?.get(o.absolutePath));
  const rounds = unique(outputs.map((o) => o.round)).sort((a, b) => a - b);
  if (rounds.length <= 1) {
    return ['<output-files>', ...outputs.map(format), '</output-files>'];
  }
  // Multiple rounds — group files under <round> tags
  return [
    '<output-files>',
    ...rounds.flatMap((round) => [
      `<round number="${round}">`,
      ...outputs.filter((o) => o.round === round).map(format),
      '</round>',
    ]),
    '</output-files>',
  ];
}

/**
 * Shared context lines for both native delivery and error messages:
 * working-directory, then memory-misses, in that order (rendered right after
 * the builder-owned wall-time).
 */
function formatDeliveryPreamble(options: {
  workingDirectory?: string;
  memoryMisses?: readonly AttachedMemoryMiss[];
}): string[] {
  const lines: string[] = [];
  if (options.workingDirectory) {
    lines.push(
      `<working-directory>${escapeText(options.workingDirectory)}</working-directory>`,
    );
  }
  const misses = options.memoryMisses ?? [];
  if (misses.length > 0) {
    lines.push(
      '<memory-misses>',
      ...misses.map(
        (miss) =>
          `<memory-miss path="${escapeAttr(miss.path)}" reason="${escapeAttr(miss.reason)}" />`,
      ),
      '</memory-misses>',
    );
  }
  return lines;
}

/**
 * Format an AgentFinalResult as a delivery message.
 * Injected into the orchestrator's FollowUpQueue as a user-role message.
 *
 * Diff files are accessible via /executions/{id}/files/{diffRelPath}; the
 * delivery includes only the path reference, not the diff content itself.
 */
export function formatSubagentDelivery(
  agentName: string,
  result: AgentFinalResult,
  options: {
    executionId: ExecutionId;
    memoryMisses?: readonly AttachedMemoryMiss[];
    wallTimeMs?: number;
    workingDirectory?: string;
  },
): string {
  const lines = formatDeliveryPreamble({
    workingDirectory: options.workingDirectory,
    memoryMisses: options.memoryMisses,
  });

  if (result.category === 'workflow') {
    if (result.diffsUnavailable) {
      lines.push(
        `<diffs-unavailable reason="${escapeAttr(result.diffsUnavailable)}">Diff computation failed: read the output files directly to review the changes.</diffs-unavailable>`,
      );
    }
    if (result.outputs.length > 0) {
      const diffsByPath = new Map(
        result.diffs.map((diff) => [diff.path, diff] as const),
      );
      lines.push(
        ...formatWorkflowOutputs(
          result.outputs,
          options.executionId,
          diffsByPath,
        ),
      );
    }
    if (result.compileFailures.length > 0) {
      lines.push('<compile-failures>');
      for (const failure of result.compileFailures) {
        lines.push(
          `<failure round="${failure.round}" file="${escapeAttr(failure.displayName)}" output="${escapeAttr(failure.outputPath)}" log="${escapeAttr(failure.logPath)}" />`,
        );
      }
      lines.push('</compile-failures>');
    }
  } else if (result.category === 'toolUse') {
    if (result.response) {
      lines.push('<response>', escapeText(result.response), '</response>');
    }
    if (result.files.length > 0) {
      lines.push(
        '<touched-files>',
        ...result.files.map((f) => `<file path="${escapeAttr(f)}" />`),
        '</touched-files>',
      );
    }
  }

  return formatChildRunDelivery(
    {
      tag: DELIVERY_TAG.subagentResult,
      executionId: options.executionId,
      attributes: [
        { name: 'agent', value: agentName },
        { name: 'category', value: result.category },
        { name: 'status', value: result.outcome },
      ],
    },
    {
      wallTime:
        options.wallTimeMs !== undefined
          ? formatDuration(options.wallTimeMs)
          : undefined,
      lines,
    },
  );
}

/**
 * Format an error as a delivery message.
 */
export function formatSubagentError(
  executionId: string,
  agentName: string,
  err: unknown,
  options?: {
    wallTimeMs?: number;
    workingDirectory?: string;
    memoryMisses?: readonly AttachedMemoryMiss[];
  },
): string {
  const formatted = normalizeProviderError(err);
  return formatChildRunError(
    {
      tag: DELIVERY_TAG.subagentError,
      executionId,
      attributes: [
        { name: 'agent', value: agentName },
        { name: 'retryable', value: formatted.userRetryable },
      ],
    },
    {
      wallTime:
        options?.wallTimeMs !== undefined
          ? formatDuration(options.wallTimeMs)
          : undefined,
      lines: formatDeliveryPreamble({
        workingDirectory: options?.workingDirectory,
        memoryMisses: options?.memoryMisses,
      }),
      message: formatted.message,
    },
  );
}

// ============================================================================
// Orchestrator follow-up framing
// ============================================================================

/**
 * Wrap an orchestrator's follow-up instruction in an XML tag so the subagent
 * knows this is a follow-up from its orchestrator (not a fresh user message).
 */
export function formatFollowUpInstruction(instruction: string): string {
  return [
    '<orchestrator-followup>',
    escapeText(instruction),
    '</orchestrator-followup>',
  ].join('\n');
}

/**
 * Build the structured result manifest for a finished subagent — the
 * machine-readable counterpart of {@link formatSubagentDelivery}'s XML.
 * Persisted to the execution KV store so later stages (orchestrator or a
 * workflow script) can chain on outputs/diffs/outcome as data instead of
 * parsing prose.
 */
export function buildSubagentResultMeta(
  agentName: string,
  result: AgentFinalResult,
  wallTimeMs: number,
  options: { readonly parentExecutionId?: ExecutionId } = {},
): SubagentResultMeta {
  return {
    producer: 'subagent',
    agentName,
    ...(options.parentExecutionId !== undefined && {
      parentExecutionId: options.parentExecutionId,
    }),
    wallTimeMs,
    result,
  };
}

/**
 * Build the failure manifest written when a subagent errors. Overwrites any
 * interim success manifest persisted by an earlier turn's delivery — without
 * this, a later failure would leave /executions/{id}/result claiming success
 * while the prose report describes the error, breaking the chaining contract.
 */
export function buildSubagentFailureResultMeta(
  agentName: string,
  fallbackCategory: AgentFlowCategory,
  result: AgentFlowResult | undefined,
  wallTimeMs: number,
  options: { readonly parentExecutionId?: ExecutionId } = {},
): SubagentResultMeta {
  const finalResult = result
    ? buildAgentFinalResult({
        flowResult: result,
        // A nominally completed flow that reached the error path is a failure;
        // genuine cancelled/failed outcomes pass through unchanged.
        outcome: result.outcome === 'completed' ? 'failed' : result.outcome,
      })
    : buildAgentFinalResult({
        category: fallbackCategory,
        outcome: 'failed',
      });
  return buildSubagentResultMeta(agentName, finalResult, wallTimeMs, options);
}
