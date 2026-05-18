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
import { normalizeProviderError } from '@common/errors';
import type {
  ActiveChildInfo,
  SubagentProgressUpdate,
  TodoItem,
  WorkPlanSnapshot,
} from '@shared/schemas';
import { countByStatus, STATUS_DISPLAY } from '@shared/schemas/todoDisplay';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { formatDuration } from '@utils/core';
import type { DiffFileInfo } from './subagentDiffs';

// ============================================================================
// Formatting helpers
// ============================================================================

/**
 * Format a single output file summary as XML.
 * When diff info is provided, includes a `diff` attribute pointing to the diff
 * file path (readable via /executions/{id}/files/...). Large changes are
 * flagged with `large-change="true"` but still include a diff file.
 */
function formatOutputFile(
  o: OutputFileSummary,
  diffInfo?: DiffFileInfo,
): string {
  const attrs = [
    `path="${escapeAttr(o.relativePath)}"`,
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
  diffInfos?: Map<string, DiffFileInfo>,
): string[] {
  const rounds = new Set(outputs.map((o) => o.round));
  if (rounds.size <= 1) {
    return [
      '<output-files>',
      ...outputs.map((o) =>
        formatOutputFile(o, diffInfos?.get(o.absolutePath)),
      ),
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
        formatOutputFile(o, diffInfos?.get(o.absolutePath)),
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
 * For workflow results, an optional `diffInfos` map (output absolutePath →
 * DiffFileInfo) can be provided. Diff files are accessible via
 * /executions/{id}/files/{diffRelPath} — the delivery only includes
 * the path reference, not the diff content itself.
 */
function workingDirectoryElement(value: string | undefined): string | null {
  return value
    ? `<working-directory>${escapeText(value)}</working-directory>`
    : null;
}

export function formatSubagentDelivery(
  agentName: string,
  result: AgentFlowResult,
  options?: {
    diffInfos?: Map<string, DiffFileInfo>;
    wallTimeMs?: number;
    workingDirectory?: string;
  },
): string {
  const displayStatus = agentFriendlyStatus(result.status);
  const lines = [
    `<subagent-result id="${escapeAttr(result.executionId)}" agent="${escapeAttr(agentName)}" category="${escapeAttr(result.category)}" status="${escapeAttr(displayStatus)}">`,
  ];

  if (options?.wallTimeMs !== undefined) {
    lines.push(`<wall-time>${formatDuration(options.wallTimeMs)}</wall-time>`);
  }

  const wdElement = workingDirectoryElement(options?.workingDirectory);
  if (wdElement) lines.push(wdElement);

  if (result.category === 'workflow') {
    if (result.outputs.length > 0) {
      lines.push(...formatWorkflowOutputs(result.outputs, options?.diffInfos));
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
    if (result.lastResponse) {
      lines.push('<response>', result.lastResponse, '</response>');
    }
    if (result.touchedFiles && result.touchedFiles.length > 0) {
      lines.push(
        '<touched-files>',
        ...result.touchedFiles.map((f) => `<file path="${escapeAttr(f)}" />`),
        '</touched-files>',
      );
    }
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
  options?: { wallTimeMs?: number; workingDirectory?: string },
): string {
  const formatted = normalizeProviderError(err);
  const lines = [
    `<subagent-error id="${escapeAttr(executionId)}" agent="${escapeAttr(agentName)}" retryable="${formatted.userRetryable ? 'true' : 'false'}">`,
  ];
  if (options?.wallTimeMs !== undefined) {
    lines.push(`<wall-time>${formatDuration(options.wallTimeMs)}</wall-time>`);
  }
  const wdElement = workingDirectoryElement(options?.workingDirectory);
  if (wdElement) lines.push(wdElement);
  lines.push(
    `<message>${escapeText(formatted.message)}</message>`,
    '</subagent-error>',
  );
  return lines.join('\n');
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
      const { completed, inProgress, pending } = countByStatus(update.todos);
      const items = update.todos
        .map((t) => {
          const icon = STATUS_DISPLAY[t.status].icon;
          return `  ${icon} ${escapeText(t.content)}`;
        })
        .join('\n');
      return [
        `<subagent-progress ${idAttr} ${agentAttr} type="todos" completed="${completed}" active="${inProgress}" pending="${pending}">`,
        items,
        '</subagent-progress>',
      ].join('\n');
    }

    case 'round': {
      const head = `<subagent-progress ${idAttr} ${agentAttr} type="round" current="${update.currentRound + 1}" total="${update.totalRounds}"`;
      if (update.outputPaths.length === 0) {
        return `${head} />`;
      }
      const fileLines = update.outputPaths.map(
        (p) => `<file path="${escapeAttr(p)}" />`,
      );
      return [`${head}>`, ...fileLines, '</subagent-progress>'].join('\n');
    }

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
      const { completed, inProgress, pending } = countByStatus(steps);
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
  workPlan?: WorkPlanSnapshot | null,
): string | null {
  const hasChildren = subagents.length > 0 || processes.length > 0;
  const todos = workPlan?.todos ?? [];
  const hasTodos = todos.length > 0;
  const hasPlan = workPlan?.plan != null || workPlan?.planSummary != null;

  if (!hasChildren && !hasTodos && !hasPlan) {
    return null;
  }

  let note =
    'Your conversation context was compacted (summarized) to free up space. The following state was preserved from before compaction.';
  if (hasChildren) {
    note +=
      ' Any active executions listed below may still be running and their results will be delivered as follow-up messages when they complete.';
  }

  const lines: string[] = ['<post-compaction-context>', `<note>${note}</note>`];

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

  if (hasTodos) {
    lines.push(...formatTodoContext(todos));
  }

  if (hasPlan) {
    lines.push(...formatPlanContext(workPlan));
  }

  lines.push('</post-compaction-context>');
  return lines.join('\n');
}

/**
 * Format todo items as XML lines for post-compaction context.
 */
function formatTodoContext(todos: TodoItem[]): string[] {
  const lines: string[] = [`<current-todos count="${todos.length}">`];
  for (const todo of todos) {
    lines.push(
      `  <todo status="${escapeAttr(todo.status)}" activeForm="${escapeAttr(todo.activeForm)}">${escapeText(todo.content)}</todo>`,
    );
  }
  lines.push('</current-todos>');
  return lines;
}

/**
 * Format plan as XML lines for post-compaction context.
 */
function formatPlanContext(workPlan: WorkPlanSnapshot): string[] {
  const plan = workPlan.plan;
  const summary = plan?.summary ?? workPlan.planSummary;
  if (!summary) return [];

  const lines: string[] = [`<current-plan summary="${escapeAttr(summary)}">`];
  if (plan) {
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      const filesAttr =
        step.files.length > 0
          ? ` files="${escapeAttr(step.files.join(', '))}"`
          : '';
      lines.push(
        `  <step index="${i + 1}" status="${escapeAttr(step.status)}" title="${escapeAttr(step.title)}"${filesAttr}>${escapeText(step.description)}</step>`,
      );
    }
  }
  lines.push('</current-plan>');
  return lines;
}

function lastNLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : lines.slice(-n).join('\n');
}
