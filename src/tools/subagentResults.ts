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
import {
  buildAgentFinalResult,
  type AgentFinalResult,
  type ResultDiffSummary,
} from '@agent/runtime/AgentFinalResult';
import type {
  AgentFlowCategory,
  AgentFlowResult,
} from '@agent/runtime/AgentFlowResult';
import type { AttachedMemoryMiss } from '@agent/types/AttachedMemory';
import { normalizeProviderError } from '@common/errors';
import type {
  ActiveChildInfo,
  ExecutionId,
  SubagentProgressUpdate,
  TodoItem,
  WorkPlanSnapshot,
} from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import type { OutputFileSummary } from '@shared/schemas/output';
import type { ExecResult } from '@shared/schemas/opResults';
import { countByStatus, STATUS_DISPLAY } from '@shared/schemas/todoDisplay';
import { planSummaryLine } from '@shared/schemas/workPlan';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { formatDuration } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { splitContentLines } from '@utils/text/stringUtils';
import {
  formatChildRunDelivery,
  formatChildRunError,
} from './deliveryEnvelope';

export type SubagentResultMeta = Extract<ResultMeta, { producer: 'subagent' }>;

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
  diffInfo?: ResultDiffSummary,
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
  diffInfos?: ReadonlyMap<string, ResultDiffSummary>,
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

function workingDirectoryElement(value: string | undefined): string | null {
  return value
    ? `<working-directory>${escapeText(value)}</working-directory>`
    : null;
}

function formatMemoryMisses(
  misses: readonly AttachedMemoryMiss[] = [],
): string[] {
  if (misses.length === 0) return [];
  return [
    '<memory-misses>',
    ...misses.map(
      (miss) =>
        `<memory-miss path="${escapeAttr(miss.path)}" reason="${escapeAttr(miss.reason)}" />`,
    ),
    '</memory-misses>',
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
  const wdElement = workingDirectoryElement(options.workingDirectory);
  if (wdElement) lines.push(wdElement);
  lines.push(...formatMemoryMisses(options.memoryMisses));
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
        `<diffs-unavailable reason="${escapeAttr(result.diffsUnavailable)}">Diff computation failed — read the output files directly to review the changes.</diffs-unavailable>`,
      );
    }
    if (result.outputs.length > 0) {
      const diffsByPath = new Map(
        result.diffs.map((diff) => [diff.path, diff] as const),
      );
      lines.push(...formatWorkflowOutputs(result.outputs, diffsByPath));
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
// Subagent progress formatting (typed → XML at boundary)
// ============================================================================

/** Format a typed progress update as XML for injection into orchestrator context. */
export function formatSubagentProgress(
  executionId: string,
  agentName: string,
  update: SubagentProgressUpdate,
): string {
  const tag = DELIVERY_TAG.subagentProgress;
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
        `<${tag} ${idAttr} ${agentAttr} type="todos" completed="${completed}" active="${inProgress}" pending="${pending}">`,
        items,
        `</${tag}>`,
      ].join('\n');
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
      return `<${tag} ${idAttr} ${agentAttr} ${attrs.join(' ')} />`;
    }

    case 'plan': {
      if (!update.plan) {
        return `<${tag} ${idAttr} ${agentAttr} type="plan" status="cleared" />`;
      }
      return `<${tag} ${idAttr} ${agentAttr} type="plan" status="updated" summary="${escapeAttr(planSummaryLine(update.plan.objective))}" />`;
    }

    case 'started':
      return `<${tag} ${idAttr} ${agentAttr} type="started" />`;
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
 * `outputTail` and `stderrTail` are accumulated from `onStdout`/`onStderr`
 * chunks as the process runs, since `buffer: false` means `result.stdout` is
 * always empty.
 *
 * `outputHead`/`stderrHead` are optional and should only be passed
 * (non-empty) when the corresponding stream was actually truncated — the
 * caller (bash.ts) preserves a small head budget alongside the tail so a
 * long run's first fatal error survives even once total output exceeds the
 * tail budget. Unlike the tail preview (`lastNLines`), the head is emitted
 * as-is and may end mid-line — it's a best-effort char-capped excerpt, not a
 * line-bounded preview, and a truncated trailing line is fine for an LLM
 * consumer to recover the error from.
 *
 * `outputElidedChars`/`stderrElidedChars` report the gap between the head and
 * tail (mirroring the foreground `checkToolResultTextLimit`'s
 * "[... N characters elided ...]" note) so the model doesn't mistake the
 * head+tail excerpt for the complete stream.
 */
export function formatBashDelivery(
  executionId: string,
  command: string,
  wallTimeMs: number,
  result: ExecResult,
  outputTail: string,
  stderrTail: string,
  outputHead = '',
  stderrHead = '',
  outputElidedChars = 0,
  stderrElidedChars = 0,
): string {
  const stdoutPreview = lastNLines(outputTail, OUTPUT_PREVIEW_LINES);
  const stderrPreview = lastNLines(stderrTail, OUTPUT_PREVIEW_LINES);
  const tag = DELIVERY_TAG.backgroundResult;
  const lines = [
    `<${tag} id="${escapeAttr(executionId)}" command="${escapeAttr(command)}">`,
    `<exit-code>${result.exitCode ?? 'unknown'}</exit-code>`,
    `<wall-time>${formatDuration(wallTimeMs)}</wall-time>`,
  ];
  if (outputHead) {
    lines.push(`<output-head>${escapeText(outputHead)}</output-head>`);
    if (outputElidedChars > 0) {
      lines.push(
        `<output-elided>${outputElidedChars.toLocaleString()} characters elided</output-elided>`,
      );
    }
  }
  if (stdoutPreview) {
    lines.push(`<output-preview>${escapeText(stdoutPreview)}</output-preview>`);
  }
  if (stderrHead) {
    lines.push(`<stderr-head>${escapeText(stderrHead)}</stderr-head>`);
    if (stderrElidedChars > 0) {
      lines.push(
        `<stderr-elided>${stderrElidedChars.toLocaleString()} characters elided</stderr-elided>`,
      );
    }
  }
  if (stderrPreview) {
    lines.push(`<stderr-preview>${escapeText(stderrPreview)}</stderr-preview>`);
  }
  lines.push(`</${tag}>`);
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
  const message = toErrorMessage(err);
  const tag = DELIVERY_TAG.backgroundError;
  return [
    `<${tag} id="${escapeAttr(executionId)}" command="${escapeAttr(command)}">`,
    `<message>${escapeText(message)}</message>`,
    `</${tag}>`,
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
 * Format the plan document as XML lines for post-compaction context.
 */
function formatPlanContext(workPlan: WorkPlanSnapshot): string[] {
  const objective = workPlan.plan?.objective ?? workPlan.planSummary;
  if (!objective) return [];
  return ['<current-plan>', escapeText(objective), '</current-plan>'];
}

function lastNLines(text: string, n: number): string {
  const lines = splitContentLines(text);
  return lines.length <= n ? text : lines.slice(-n).join('\n');
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
