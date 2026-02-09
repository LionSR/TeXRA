/**
 * Formatting utilities for subagent results.
 *
 * Format helpers convert AgentFlowResult into structured XML strings,
 * used by sync mode tool results and async mode FollowUpQueue delivery.
 */

import type {
  AgentFlowResult,
  OutputFileSummary,
} from '@agent/runtime/AgentFlowResult';
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
  return `<subagent-result id="${result.executionId}" agent="${agentName}" category="${result.category}" status="${result.status}">`;
}

/**
 * Format an AgentFlowResult as a delivery message for async mode.
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
 * Format an error as a delivery message for async mode.
 */
export function formatSubagentError(
  executionId: string,
  agentName: string,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `<subagent-error id="${executionId}" agent="${agentName}">`,
    `<message>${message}</message>`,
    '</subagent-error>',
  ].join('\n');
}
