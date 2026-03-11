/**
 * Formatting utilities for subagent results and progress updates.
 *
 * Format helpers convert AgentFlowResult and progress updates into
 * structured XML strings for FollowUpQueue delivery to the orchestrator.
 *
 * Design: Typed objects internally, XML formatting only at the boundary
 * (just before injection into model context via FollowUpQueue).
 */

import type {
  AgentFlowResult,
  OutputFileSummary,
} from '@agent/runtime/AgentFlowResult';
import type { ExecResult } from '@agent/types/ResultTypes';
import type { SubagentProgressUpdate } from '@shared/schemas';
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

/** Map internal end-group statuses to agent-friendly labels. */
function agentFriendlyStatus(status: string): string {
  return status === 'stopped' ? 'completed' : status;
}

/**
 * Format an AgentFlowResult as a delivery message.
 * Injected into the orchestrator's FollowUpQueue as a user-role message.
 */
export function formatSubagentDelivery(
  agentName: string,
  result: AgentFlowResult,
): string {
  const displayStatus = agentFriendlyStatus(result.status);
  const lines = [
    `<subagent-result id="${escapeAttr(result.executionId)}" agent="${escapeAttr(agentName)}" category="${escapeAttr(result.category)}" status="${escapeAttr(displayStatus)}">`,
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
    `<message>${escapeText(message)}</message>`,
    '</subagent-error>',
  ].join('\n');
}

// ============================================================================
// Subagent progress formatting (typed → XML at boundary)
// ============================================================================

/** Format a typed progress update as XML for injection into orchestrator context. */
export function formatSubagentProgress(
  executionId: string,
  agentName: string,
  update: SubagentProgressUpdate,
): string {
  const idAttr = `id="${escapeAttr(executionId)}"`;
  const agentAttr = `agent="${escapeAttr(agentName)}"`;

  switch (update.kind) {
    case 'todos': {
      const completed = update.todos.filter(
        (t) => t.status === 'completed',
      ).length;
      const inProgress = update.todos.filter(
        (t) => t.status === 'in_progress',
      ).length;
      const pending = update.todos.length - completed - inProgress;
      const TODO_PROGRESS_ICON: Record<string, string> = {
        completed: '[x]',
        in_progress: '[>]',
      };
      const items = update.todos
        .map((t) => {
          const icon = TODO_PROGRESS_ICON[t.status ?? ''] ?? '[ ]';
          return `  ${icon} ${escapeText(t.content)}`;
        })
        .join('\n');
      return [
        `<subagent-progress ${idAttr} ${agentAttr} type="todos" completed="${completed}" active="${inProgress}" pending="${pending}">`,
        items,
        '</subagent-progress>',
      ].join('\n');
    }

    case 'round':
      return `<subagent-progress ${idAttr} ${agentAttr} type="round" current="${update.currentRound + 1}" total="${update.totalRounds}" />`;

    case 'overview': {
      const fileList =
        update.filesChanged.length > 0
          ? update.filesChanged.map((f) => escapeAttr(f)).join(', ')
          : 'none';
      const attrs = [
        `type="overview"`,
        `tool-calls="${update.toolCallCount}"`,
        `files-changed="${fileList}"`,
      ];
      if (update.cost !== undefined) {
        attrs.push(`cost="${update.cost.toFixed(4)}"`);
      }
      return `<subagent-progress ${idAttr} ${agentAttr} ${attrs.join(' ')} />`;
    }

    case 'started':
      return `<subagent-progress ${idAttr} ${agentAttr} type="started" />`;
  }
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

// ============================================================================
// Background bash result formatting
// ============================================================================

/** Last N lines of output for the delivery preview. */
const OUTPUT_PREVIEW_LINES = 20;

/**
 * Format a completed background bash result as a delivery message.
 * Injected into the orchestrator's FollowUpQueue.
 *
 * `outputTail` and `stderrTail` are read from ephemeral temp files before
 * cleanup, since `buffer: false` means `result.stdout` is always empty.
 */
export function formatBashDelivery(
  executionId: string,
  command: string,
  wallTimeMs: number,
  result: ExecResult,
  outputTail: string,
  stderrTail: string,
): string {
  const stdoutPreview = lastNLines(outputTail, OUTPUT_PREVIEW_LINES);
  const stderrPreview = lastNLines(stderrTail, OUTPUT_PREVIEW_LINES);
  const lines = [
    `<background-result id="${executionId}" command="${escapeAttr(command)}">`,
    `<exit-code>${result.exitCode ?? 'unknown'}</exit-code>`,
    `<wall-time>${formatDuration(wallTimeMs)}</wall-time>`,
  ];
  if (stdoutPreview) {
    lines.push(`<output-preview>${escapeText(stdoutPreview)}</output-preview>`);
  }
  if (stderrPreview) {
    lines.push(`<stderr-preview>${escapeText(stderrPreview)}</stderr-preview>`);
  }
  lines.push('</background-result>');
  return lines.join('\n');
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
    `<message>${escapeText(message)}</message>`,
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

/** Escape XML text content (element bodies). */
function escapeText(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}
