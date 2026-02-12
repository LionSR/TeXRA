/**
 * Formatting utilities for subagent results.
 *
 * Format helpers convert AgentFlowResult into structured XML strings
 * for FollowUpQueue delivery to the orchestrator.
 */

import type {
  AgentFlowResult,
  OutputFileSummary,
} from '@agent/runtime/AgentFlowResult';
import type { ExecResult } from '@agent/types/ResultTypes';
import { formatDuration } from '@utils/core';

// ============================================================================
// Formatting helpers
// ============================================================================

/** Format a single output file summary as XML. */
function formatOutputFile(o: OutputFileSummary): string {
  const attrs = [
    `path="${escapeAttr(o.relativePath)}"`,
    `location="${escapeAttr(o.location)}"`,
    o.originalPath !== null ? `original="${escapeAttr(o.originalPath)}"` : '',
    o.added !== null ? `added="${o.added}"` : '',
    o.removed !== null ? `removed="${o.removed}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<file ${attrs} />`;
}

/** Format workflow output files, grouping by round when there are multiple rounds. */
function formatWorkflowOutputs(outputs: OutputFileSummary[]): string[] {
  const rounds = new Set(outputs.map((o) => o.round));
  if (rounds.size <= 1) {
    return [
      '<output-files>',
      ...outputs.map(formatOutputFile),
      '</output-files>',
    ];
  }
  // Multiple rounds — group files under <round> tags
  const lines: string[] = ['<output-files>'];
  for (const round of [...rounds].sort((a, b) => a - b)) {
    const roundFiles = outputs.filter((o) => o.round === round);
    lines.push(`<round number="${round}">`);
    lines.push(...roundFiles.map(formatOutputFile));
    lines.push('</round>');
  }
  lines.push('</output-files>');
  return lines;
}

/**
 * Format an AgentFlowResult as a delivery message.
 * Injected into the orchestrator's FollowUpQueue as a user-role message.
 */
export function formatSubagentDelivery(
  agentName: string,
  result: AgentFlowResult,
): string {
  const lines = [
    `<subagent-result id="${escapeAttr(result.executionId)}" agent="${escapeAttr(agentName)}" category="${escapeAttr(result.category)}" status="${escapeAttr(result.status)}">`,
  ];

  if (result.category === 'workflow' && result.outputs.length > 0) {
    lines.push(...formatWorkflowOutputs(result.outputs));
  } else if (result.category === 'toolUse' && result.lastResponse) {
    lines.push('<response>', result.lastResponse, '</response>');
  }

  lines.push('</subagent-result>');
  return lines.join('\n');
}

/**
 * Format an error as a delivery message.
 */
export function formatSubagentError(
  executionId: string,
  agentName: string,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `<subagent-error id="${escapeAttr(executionId)}" agent="${escapeAttr(agentName)}">`,
    `<message>${escapeAttr(message)}</message>`,
    '</subagent-error>',
  ].join('\n');
}

// ============================================================================
// Background bash result formatting
// ============================================================================

/** Last N lines of output for the delivery preview. */
const OUTPUT_PREVIEW_LINES = 20;

/**
 * Format a completed background bash result as a delivery message.
 * Injected into the orchestrator's FollowUpQueue.
 */
export function formatBashDelivery(
  executionId: string,
  command: string,
  wallTimeMs: number,
  result: ExecResult,
): string {
  const preview = lastNLines(result.stdout ?? '', OUTPUT_PREVIEW_LINES);
  return [
    `<background-result id="${executionId}" command="${escapeAttr(command)}">`,
    `<exit-code>${result.exitCode ?? 'unknown'}</exit-code>`,
    `<wall-time>${formatDuration(wallTimeMs)}</wall-time>`,
    `<output-preview>${preview}</output-preview>`,
    '</background-result>',
  ].join('\n');
}

/**
 * Format a failed background bash result as a delivery message.
 */
export function formatBashError(
  executionId: string,
  command: string,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `<background-error id="${executionId}" command="${escapeAttr(command)}">`,
    `<message>${message}</message>`,
    '</background-error>',
  ].join('\n');
}

function lastNLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : lines.slice(-n).join('\n');
}

function escapeAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
}
