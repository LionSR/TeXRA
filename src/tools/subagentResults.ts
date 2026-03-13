/**
 * Formatting utilities for subagent results and progress updates.
 *
 * Format helpers convert AgentFlowResult and progress updates into
 * structured XML strings for FollowUpQueue delivery to the orchestrator.
 *
 * Design: Typed objects internally, XML formatting only at the boundary
 * (just before injection into model context via FollowUpQueue).
 */

import { diff_match_patch } from 'diff-match-patch';

import type {
  AgentFlowResult,
  OutputFileSummary,
} from '@agent/runtime/AgentFlowResult';
import type { ExecResult } from '@agent/types/ResultTypes';
import type { ActiveChildInfo, SubagentProgressUpdate } from '@shared/schemas';
import { TODO_STATUS } from '@shared/schemas/todo';
import { formatDuration } from '@utils/core';
import { AbsoluteFS } from '@utils/files';

// ============================================================================
// Diff computation for workflow deliveries
// ============================================================================

/** Maximum lines of unified diff to include per file in deliveries. */
const MAX_DIFF_LINES = 200;

/**
 * When the changed lines (added + removed) exceed this fraction of the
 * original file's line count, the diff is considered too large to be useful
 * and is skipped. Full rewrites produce noisy diffs that waste context;
 * the orchestrator is better off reading the output directly.
 */
const CHANGE_RATIO_THRESHOLD = 0.4;

/** Sentinel value indicating the diff was intentionally skipped (too large). */
const DIFF_SKIPPED = Symbol('diff-skipped');

/**
 * Compute a unified diff between two strings.
 * Returns a patch-style diff string, or null if files are identical.
 */
function computeUnifiedDiff(original: string, modified: string): string | null {
  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(original, modified);
  if (patches.length === 0) return null;
  return dmp.patch_toText(patches);
}

/**
 * Truncate diff text to a maximum number of lines.
 * Appends a truncation notice if the diff exceeds the limit.
 */
function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  return lines.slice(0, maxLines).join('\n') + '\n[... diff truncated]';
}

/**
 * Compute diffs for workflow output files where changes are modest.
 *
 * Returns a map from output absolutePath to either:
 * - A truncated diff string (when the change ratio is below the threshold)
 * - The DIFF_SKIPPED sentinel (when the diff is too large / full rewrite)
 *
 * Files without an original (new files) or where reading fails are omitted.
 */
export async function computeWorkflowDiffs(
  outputs: OutputFileSummary[],
): Promise<Map<string, string | typeof DIFF_SKIPPED>> {
  const diffs = new Map<string, string | typeof DIFF_SKIPPED>();

  await Promise.all(
    outputs.map(async (o) => {
      if (!o.originalPath) return;
      try {
        const [original, modified] = await Promise.all([
          AbsoluteFS.read(o.originalPath),
          AbsoluteFS.read(o.absolutePath),
        ]);

        // Skip diff when changes are too large relative to the original.
        const originalLines = countLinesSimple(original);
        if (originalLines > 0 && o.added !== null && o.removed !== null) {
          const changedLines = (o.added ?? 0) + (o.removed ?? 0);
          if (changedLines / originalLines > CHANGE_RATIO_THRESHOLD) {
            diffs.set(o.absolutePath, DIFF_SKIPPED);
            return;
          }
        }

        const diff = computeUnifiedDiff(original, modified);
        if (diff) {
          diffs.set(o.absolutePath, truncateDiff(diff, MAX_DIFF_LINES));
        }
      } catch {
        // File read failure is non-fatal — skip diff for this file.
      }
    }),
  );

  return diffs;
}

/** Fast line counter — avoids allocating a split array. */
function countLinesSimple(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count > 0 || text.length > 0 ? count + 1 : 0;
}

// ============================================================================
// Formatting helpers
// ============================================================================

/** Format a single output file summary as XML, optionally including inline diff. */
function formatOutputFile(
  o: OutputFileSummary,
  diff?: string | typeof DIFF_SKIPPED,
): string {
  const attrs = [
    `path="${escapeAttr(o.relativePath)}"`,
    `location="${escapeAttr(o.location)}"`,
    o.originalPath !== null ? `original="${escapeAttr(o.originalPath)}"` : '',
    o.added !== null ? `added="${o.added}"` : '',
    o.removed !== null ? `removed="${o.removed}"` : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (diff === DIFF_SKIPPED) {
    // Large change ratio — omit diff, signal that the orchestrator should
    // read the output file directly rather than rely on an inline diff.
    return `<file ${attrs} diff-omitted="large-change" />`;
  }
  if (diff) {
    return [
      `<file ${attrs}>`,
      `<diff>${escapeText(diff)}</diff>`,
      '</file>',
    ].join('\n');
  }
  return `<file ${attrs} />`;
}

/**
 * Format workflow output files, grouping by round when there are multiple rounds.
 * When diffs are provided, they are included inline within each <file> element.
 */
function formatWorkflowOutputs(
  outputs: OutputFileSummary[],
  diffs?: Map<string, string | typeof DIFF_SKIPPED>,
): string[] {
  const rounds = new Set(outputs.map((o) => o.round));
  if (rounds.size <= 1) {
    return [
      '<output-files>',
      ...outputs.map((o) => formatOutputFile(o, diffs?.get(o.absolutePath))),
      '</output-files>',
    ];
  }
  // Multiple rounds — group files under <round> tags
  const lines: string[] = ['<output-files>'];
  for (const round of [...rounds].sort((a, b) => a - b)) {
    const roundFiles = outputs.filter((o) => o.round === round);
    lines.push(`<round number="${round}">`);
    lines.push(
      ...roundFiles.map((o) =>
        formatOutputFile(o, diffs?.get(o.absolutePath)),
      ),
    );
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
 *
 * For workflow results, an optional `diffs` map (output absolutePath → diff text)
 * can be provided to include inline diffs so the orchestrator can immediately
 * assess the scope of changes without reading files manually.
 */
export function formatSubagentDelivery(
  agentName: string,
  result: AgentFlowResult,
  diffs?: Map<string, string | typeof DIFF_SKIPPED>,
): string {
  const displayStatus = agentFriendlyStatus(result.status);
  const lines = [
    `<subagent-result id="${escapeAttr(result.executionId)}" agent="${escapeAttr(agentName)}" category="${escapeAttr(result.category)}" status="${escapeAttr(displayStatus)}">`,
  ];

  if (result.category === 'workflow' && result.outputs.length > 0) {
    lines.push(...formatWorkflowOutputs(result.outputs, diffs));
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
        (t) => t.status === TODO_STATUS.COMPLETED,
      ).length;
      const inProgress = update.todos.filter(
        (t) => t.status === TODO_STATUS.IN_PROGRESS,
      ).length;
      const pending = update.todos.length - completed - inProgress;
      const TODO_PROGRESS_ICON: Record<string, string> = {
        [TODO_STATUS.COMPLETED]: '[x]',
        [TODO_STATUS.IN_PROGRESS]: '[>]',
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

    case 'plan': {
      if (!update.plan) {
        return `<subagent-progress ${idAttr} ${agentAttr} type="plan" status="cleared" />`;
      }
      const steps = update.plan.steps;
      const completed = steps.filter(
        (s) => s.status === TODO_STATUS.COMPLETED,
      ).length;
      const inProgress = steps.filter(
        (s) => s.status === TODO_STATUS.IN_PROGRESS,
      ).length;
      const pending = steps.length - completed - inProgress;
      return `<subagent-progress ${idAttr} ${agentAttr} type="plan" steps="${steps.length}" completed="${completed}" active="${inProgress}" pending="${pending}" />`;
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

// ============================================================================
// Post-compaction execution context
// ============================================================================

/**
 * Format active execution state as context for the agent after compaction.
 * Returns null if there are no active children to report.
 *
 * This helps the agent understand what subagents and background processes
 * are still running after context was compressed, so it can:
 * - Avoid launching duplicate subagents
 * - Know which execution IDs to check on
 * - Understand that pending results may arrive as follow-up messages
 */
export function formatPostCompactionContext(
  subagents: ActiveChildInfo[],
  processes: ActiveChildInfo[],
): string | null {
  if (subagents.length === 0 && processes.length === 0) {
    return null;
  }

  const lines: string[] = [
    '<post-compaction-context>',
    '<note>Your conversation context was compacted (summarized) to free up space. The following executions were launched before compaction and may still be active. Their results will be delivered as follow-up messages when they complete. Use the executions tool to check on their status or read their results.</note>',
  ];

  if (subagents.length > 0) {
    lines.push(`<active-subagents count="${subagents.length}">`);
    for (const sa of subagents) {
      const statusAttr = sa.status ? ` status="${escapeAttr(sa.status)}"` : '';
      const elapsedAttr = sa.elapsed
        ? ` elapsed="${escapeAttr(sa.elapsed)}"`
        : '';
      lines.push(
        `  <subagent id="${escapeAttr(sa.executionId)}" agent="${escapeAttr(sa.agentName)}"${statusAttr}${elapsedAttr} />`,
      );
    }
    lines.push('</active-subagents>');
  }

  if (processes.length > 0) {
    lines.push(`<active-background-bash count="${processes.length}">`);
    for (const proc of processes) {
      const elapsedAttr = proc.elapsed
        ? ` elapsed="${escapeAttr(proc.elapsed)}"`
        : '';
      lines.push(
        `  <background-bash id="${escapeAttr(proc.executionId)}" command="${escapeAttr(proc.agentName)}"${elapsedAttr} />`,
      );
    }
    lines.push('</active-background-bash>');
  }

  lines.push('</post-compaction-context>');
  return lines.join('\n');
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
