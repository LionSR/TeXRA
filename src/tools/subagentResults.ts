/**
 * Pending subagent results and formatting utilities.
 *
 * pendingResults holds Promise<AgentFlowResult> for async mode (Mode B).
 * The await_subagent tool resolves these promises.
 *
 * Format helpers convert AgentFlowResult into tool result output strings,
 * used by both sync/async mode tool results and background mode delivery.
 */

import type {
  AgentFlowResult,
  OutputFileSummary,
} from '@agent/runtime/AgentFlowResult';
import type { ToolResult } from './result';

// ============================================================================
// Pending results map (Mode B: async)
// ============================================================================

/** Entry in the pending results map — stores context needed to format the result. */
export interface PendingSubagent {
  promise: Promise<AgentFlowResult>;
  agentName: string;
  inputFile?: string;
}

/**
 * Pending subagent results, keyed by subagent ID.
 * Cleanup is handled by AwaitSubagentTool after consuming the result.
 * Entries for unawaited subagents remain until extension reload (bounded, small).
 */
export const pendingResults = new Map<string, PendingSubagent>();

/** Store a pending subagent result. Caller must clean up via pendingResults.delete(). */
export function addPendingResult(
  subagentId: string,
  promise: Promise<AgentFlowResult>,
  agentName: string,
  inputFile?: string,
): void {
  pendingResults.set(subagentId, { promise, agentName, inputFile });
}

// ============================================================================
// Formatting helpers
// ============================================================================

/** Format a single output file summary as XML. */
function formatOutputFile(o: OutputFileSummary): string {
  const attrs = [
    `path="${o.relativePath}"`,
    `location="${o.location}"`,
    o.originalPath !== null ? `original="${o.originalPath}"` : '',
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

/** Build the opening <subagent-result> tag. */
function resultTag(result: AgentFlowResult, agentName: string): string {
  return `<subagent-result id="${result.streamId}" agent="${agentName}" category="${result.category}" status="${result.status}">`;
}

/** Format an AgentFlowResult into a ToolResult for sync/async modes. */
export function formatFlowResult(
  result: AgentFlowResult,
  agentName: string,
  inputFile?: string,
): ToolResult {
  if (result.category === 'workflow') {
    const lines = [resultTag(result, agentName)];
    if (result.outputs.length > 0) {
      lines.push(...formatWorkflowOutputs(result.outputs));
    }
    lines.push('</subagent-result>');
    return {
      summary: `'${agentName}' completed on ${inputFile ?? 'input'}`,
      output: lines.join('\n'),
    };
  }

  // Tool-use agent
  const lines = [resultTag(result, agentName)];
  if (result.lastResponse) {
    lines.push('<response>', result.lastResponse, '</response>');
  }
  lines.push('</subagent-result>');
  return {
    summary: `'${agentName}' completed`,
    output: lines.join('\n'),
  };
}

/**
 * Format an AgentFlowResult as a delivery message for background mode (Mode C).
 * Injected into the orchestrator's FollowUpQueue as a user-role message.
 */
export function formatSubagentDelivery(
  agentName: string,
  result: AgentFlowResult,
): string {
  const lines = [resultTag(result, agentName)];

  if (result.category === 'workflow' && result.outputs.length > 0) {
    lines.push(...formatWorkflowOutputs(result.outputs));
  } else if (result.category === 'toolUse' && result.lastResponse) {
    lines.push('<response>', result.lastResponse, '</response>');
  }

  lines.push('</subagent-result>');
  return lines.join('\n');
}

/**
 * Format an error as a delivery message for background mode (Mode C).
 */
export function formatSubagentError(
  subagentId: string,
  agentName: string,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `<subagent-error id="${subagentId}" agent="${agentName}">`,
    `<message>${message}</message>`,
    '</subagent-error>',
  ].join('\n');
}
