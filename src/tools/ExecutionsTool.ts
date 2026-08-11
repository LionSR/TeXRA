/**
 * Tool for viewing and managing execution history, generated files, and
 * running processes. Supports viewing past executions, waiting for status
 * changes, reading output from background processes, and killing running
 * executions.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import {
  deriveResumability,
  getExecutionStore,
  listExecutionWorkspaceFiles,
  unwrapResultMeta,
  type ChildRecord,
  type ExecutionKVStore,
  type TodoEntry,
  listExecutions,
  resolveExecutionWorkspaceFilePath,
} from '@agent/storage';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  AgentExecutionHandle,
  type ExecutionHandle,
} from '@agent/runtime/ExecutionHandle';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import {
  getRunContextExecutionId,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import * as logger from '@logger/logUtils';
import type { FileStat } from '@platform/interfaces';
import { platform } from '@platform/platform';
import {
  ExecutionIdSchema,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  TERMINAL_WORKFLOW_CALL_STATUSES,
  WORKFLOW_CALL_STATUS,
  deriveWorkflowCounts,
  type ExecutionId,
  type StreamLogEntry,
  type WorkflowExecutionSnapshot,
} from '@shared/schemas';
import {
  BASH_BACKGROUND_LOG_CAP_CHARS,
  type BackgroundBashOutputSource,
  EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
  getBackgroundBashOutputSource,
  EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
} from '@shared/toolUse';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { requireRunStream, requireStreamId } from '@tools/contextHelpers';
import { assertNoParentTraversal } from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
  readCompletedRunTodos,
} from '@transcript';
import { AbsoluteFS, StorageFS } from '@utils/files';
import { clamp, unique } from '@utils/core';
import { isDirectory } from '@utils/files/fsEntryType';
import { findExistingRunStoragePath } from '@utils/files/taskRunStorage';
import { getPathSegments } from '@utils/core/pathCore';
import { splitContentLines } from '@utils/text/stringUtils';

// Local file imports
import {
  buildCompletedSummaryLines,
  buildRunningSummaryLines,
  buildSummaryTailLines,
  formatChildLine,
  formatListingLine,
  formatStatusInfo,
  formatTodoHeader,
  formatTodoSection,
  getExecutionStatusInfo,
  executionDisplayCategory,
  shouldSuppressAutoDeliveredSubagentReport,
  type ExecutionDisplayCategory,
  type ExecutionSummaryOptions,
} from './executionFormatters';
import { defineTool } from './core/define';
import {
  formatFileView,
  paginateToolListing,
  formatPaginationHint,
  ViewRangeSchema,
} from './formatting';
import { formatConversation } from './executions/conversationFormat';
import { listRunDirectoryFiles } from './executions/runDirectoryFiles';
import { serializeFilteredConfig } from './executions/configFieldFilter';
import {
  listenForFollowUp,
  shouldSkipWait,
} from './executions/waitCoordination';
import { formatSizedEntryLines } from './executions/fileListingFormat';

const CHANNEL = 'ExecutionsTool';

// ============================================================================
// Resource path catalog
// ============================================================================

/**
 * Single source of truth for the virtual resource paths this tool serves.
 * Both the tool `description` and the "Unknown path" error render from this
 * list, so the two cannot drift.
 */
const EXECUTION_PATH_CATALOG: ReadonlyArray<{ path: string; summary: string }> =
  [
    {
      path: '/executions',
      summary: 'List executions (paginated; use offset/limit for pages)',
    },
    {
      path: '/executions/{id}',
      summary:
        'Execution summary (agent, model, timestamp, status, children, todos)',
    },
    { path: '/executions/{id}/config', summary: 'Agent configuration JSON' },
    {
      path: '/executions/{id}/conversation',
      summary: 'Full message history (subagents)',
    },
    {
      path: '/executions/{id}/todos',
      summary: 'Task list (tool-use subagents)',
    },
    {
      path: '/executions/{id}/report',
      summary: 'Result report (persists after context compaction)',
    },
    {
      path: '/executions/{id}/result',
      summary:
        'Final result envelope (JSON) for chaining; process result for background commands',
    },
    {
      path: '/executions/{id}/output',
      summary:
        'stdout/stderr of a background command, readable WHILE IT RUNS (report/result only exist once it finishes)',
    },
    { path: '/executions/{id}/children', summary: 'Child executions' },
    {
      path: '/executions/{id}/files',
      summary: 'Generated files (workflows only)',
    },
    {
      path: '/executions/{id}/files/{path}',
      summary: 'Read specific generated file (workflows only)',
    },
    {
      path: '/executions/{id}/workspace-files',
      summary: 'Workspace files edited by tool-use runs',
    },
    {
      path: '/executions/{id}/workspace-files/{path}',
      summary: 'Read a workspace file edited by a tool-use run',
    },
  ];

/** Renders the catalog as a bulleted `- <path> - <summary>` list. */
const EXECUTION_PATH_LIST = EXECUTION_PATH_CATALOG.map(
  ({ path: resourcePath, summary }) => `- ${resourcePath} - ${summary}`,
).join('\n');

function getRunningTodos(
  session: SessionHandle,
  handle: ExecutionHandle,
): TodoEntry[] {
  return handle instanceof AgentExecutionHandle
    ? session.snapshots.getWorkPlan(handle.childStreamId).todos
    : [];
}

/**
 * One-line attribution note for /report and /result when a newer turn was
 * accepted but never persisted a result (#9531): without it, the single
 * latest-value slots would silently present the previous turn as current.
 * Reads "still running" while the execution is live and "was interrupted"
 * once it has terminalized. Returns null when the slots reflect the latest
 * accepted turn (or the execution has no turn identity at all).
 */
async function turnAttributionNote(
  store: ExecutionKVStore,
): Promise<string | null> {
  const [turnState, meta] = await Promise.all([
    store.readTurnState(),
    store.readMeta(),
  ]);
  const active = turnState?.activeTurn;
  const completed = turnState?.lastCompletedTurn?.token;
  if (!active || active.token === completed) {
    return null;
  }
  const fate =
    meta?.outcome === undefined
      ? `turn ${active.token} is still running`
      : `turn ${active.token} was interrupted before producing a result`;
  const showing = completed
    ? `showing the latest completed turn (${completed}).`
    : 'no turn has completed yet.';
  return `[Note: ${fate}; ${showing}]`;
}

// ============================================================================
// Background command output
// ============================================================================

/** Lines returned by /executions/{id}/output when no view_range is given. */
const OUTPUT_TAIL_LINES = 200;

/** Hard ceiling on lines a single /output read returns, view_range included. */
const OUTPUT_MAX_LINES = 1_000;

/** Marks a projected line that the command wrote to stderr. */
const OUTPUT_STDERR_PREFIX = 'err: ';

const WORKFLOW_SUMMARY_MAX_ENTRIES = 8;
const WORKFLOW_SUMMARY_MAX_ATTEMPTS = 2;
const WORKFLOW_SUMMARY_MAX_FILES_PER_KIND = 3;
const WORKFLOW_SUMMARY_TEXT_LENGTH = 160;

function compactWorkflowText(value: string | undefined): string | undefined {
  return value?.slice(0, WORKFLOW_SUMMARY_TEXT_LENGTH);
}

function workflowStageView(
  stage: WorkflowExecutionSnapshot['stages'][number],
): unknown {
  return {
    id: compactWorkflowText(stage.id),
    title: compactWorkflowText(stage.title),
    order: stage.order,
    lifecycle: stage.lifecycle,
    startedAt: stage.startedAt,
    completedAt: stage.completedAt,
  };
}

function workflowAttemptView(
  attempt: WorkflowExecutionSnapshot['calls'][number]['attempts'][number],
): unknown {
  return {
    number: attempt.number,
    id: compactWorkflowText(attempt.id),
    childStreamId: compactWorkflowText(attempt.childStreamId),
    model: compactWorkflowText(attempt.model),
    costUsd: attempt.costUsd,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
  };
}

function workflowCallFailurePriority(status: string): number {
  // Within terminal calls, elevate failed/cancelled so the bounded projection
  // keeps the outcomes that matter for debugging (matches stage ranking).
  if (
    status === WORKFLOW_CALL_STATUS.FAILED ||
    status === WORKFLOW_CALL_STATUS.CANCELLED
  ) {
    return 0;
  }
  return 1;
}

function workflowExecutionView(snapshot: WorkflowExecutionSnapshot): unknown {
  const byPriority = snapshot.calls.toSorted(
    (left, right) =>
      Number(TERMINAL_WORKFLOW_CALL_STATUSES.has(left.status)) -
        Number(TERMINAL_WORKFLOW_CALL_STATUSES.has(right.status)) ||
      workflowCallFailurePriority(left.status) -
        workflowCallFailurePriority(right.status) ||
      Number(left.stageId !== snapshot.currentStageId) -
        Number(right.stageId !== snapshot.currentStageId) ||
      right.timestamps.updatedAt.localeCompare(left.timestamps.updatedAt),
  );
  const stages = snapshot.stages
    .toSorted((left, right) => {
      const priority = (stage: (typeof snapshot.stages)[number]): number => {
        if (stage.id === snapshot.currentStageId) return 0;
        if (stage.lifecycle === 'failed' || stage.lifecycle === 'cancelled') {
          return 1;
        }
        return 2;
      };
      return priority(left) - priority(right) || right.order - left.order;
    })
    .slice(0, WORKFLOW_SUMMARY_MAX_ENTRIES)
    .map(workflowStageView);
  const calls = byPriority
    .slice(0, WORKFLOW_SUMMARY_MAX_ENTRIES)
    .map((call) => {
      const compactFiles = (files: readonly string[]) => ({
        sample: files
          .slice(0, WORKFLOW_SUMMARY_MAX_FILES_PER_KIND)
          .map((file) => compactWorkflowText(file)!),
        ...(files.length > WORKFLOW_SUMMARY_MAX_FILES_PER_KIND && {
          omitted: files.length - WORKFLOW_SUMMARY_MAX_FILES_PER_KIND,
        }),
      });
      return {
        id: compactWorkflowText(call.id),
        label: compactWorkflowText(call.label),
        stageId: compactWorkflowText(call.stageId),
        stageTitle: compactWorkflowText(call.stageTitle),
        agent: compactWorkflowText(call.agent),
        model: compactWorkflowText(call.model),
        files: {
          input: compactFiles(call.files.input),
          context: compactFiles(call.files.context),
          media: compactFiles(call.files.media),
        },
        childExecutionId: compactWorkflowText(call.childExecutionId),
        childStreamId: compactWorkflowText(call.childStreamId),
        attempts: call.attempts
          .slice(-WORKFLOW_SUMMARY_MAX_ATTEMPTS)
          .map(workflowAttemptView),
        ...(call.attempts.length > WORKFLOW_SUMMARY_MAX_ATTEMPTS && {
          omittedAttempts: call.attempts.length - WORKFLOW_SUMMARY_MAX_ATTEMPTS,
        }),
        status: call.status,
        blockedReason: compactWorkflowText(call.blockedReason),
        error: compactWorkflowText(call.error),
        costUsd: call.costUsd,
        timestamps: call.timestamps,
      };
    });
  const currentStage = snapshot.stages.find(
    (stage) => stage.id === snapshot.currentStageId,
  );
  return {
    aggregate: {
      lifecycle: snapshot.lifecycle,
      error: compactWorkflowText(snapshot.error),
      counts: deriveWorkflowCounts(snapshot.calls),
      timestamps: snapshot.timestamps,
      responseBounds: {
        maxStages: WORKFLOW_SUMMARY_MAX_ENTRIES,
        maxCalls: WORKFLOW_SUMMARY_MAX_ENTRIES,
        maxAttemptsPerCall: WORKFLOW_SUMMARY_MAX_ATTEMPTS,
        maxFilesPerKind: WORKFLOW_SUMMARY_MAX_FILES_PER_KIND,
      },
    },
    currentStage: currentStage ? workflowStageView(currentStage) : null,
    stages,
    calls,
    ...(snapshot.stages.length > stages.length && {
      omittedStages: snapshot.stages.length - stages.length,
    }),
    ...(snapshot.calls.length > calls.length && {
      omittedCalls: snapshot.calls.length - calls.length,
    }),
  };
}

/**
 * Line break in captured terminal output. A bare CR counts: progress bars
 * (curl, pip, docker) redraw with `\r` and no newline, so splitting on LF
 * alone would collapse a whole build's progress into one enormous "line" and
 * hand the caller the entire log however small the requested window was.
 */
const OUTPUT_LINE_BREAK = /\r\n|\r|\n/;

interface ProcessOutputProjection {
  readonly lines: readonly string[];
  readonly chars: number;
}

/**
 * Flatten a background command's transcript rows into display lines.
 *
 * Tagged stdout/stderr chunks stay in append order and concatenate only while
 * their source remains compatible, so chunk-split lines are reconstructed
 * without crossing a stream switch. Untagged lifecycle and legacy rows flush
 * any pending command fragment and render standalone. Structured rows (usage,
 * context state, tool frames) carry a non-default `messageType` and are
 * dropped: this endpoint projects command output, not run bookkeeping.
 */
function projectProcessOutput(
  entries: readonly StreamLogEntry[],
): ProcessOutputProjection {
  const lines: string[] = [];
  let chars = 0;
  let pendingText = '';
  let pendingSource: BackgroundBashOutputSource | undefined;

  const emitText = (text: string, stderr: boolean): void => {
    // A trailing break terminates the last line rather than opening an empty
    // one; blank lines inside the text still survive the split.
    const normalized = text.replace(/\r\n$|[\r\n]$/, '');
    for (const line of normalized.split(OUTPUT_LINE_BREAK)) {
      lines.push(stderr ? `${OUTPUT_STDERR_PREFIX}${line}` : line);
    }
  };
  const flushPending = (): void => {
    if (pendingText && pendingSource) {
      emitText(pendingText, pendingSource === 'stderr');
    }
    pendingText = '';
    pendingSource = undefined;
  };

  for (const entry of entries) {
    if (entry.type !== STREAM_LOG_ENTRY_TYPES.LOG) continue;
    if ((entry.messageType ?? MESSAGE_TYPES.DEFAULT) !== MESSAGE_TYPES.DEFAULT)
      continue;
    const text = entry.text;
    if (!text) continue;

    chars += text.length;
    const source = getBackgroundBashOutputSource(entry.data);
    if (!source) {
      flushPending();
      emitText(
        text,
        entry.level === LOG_LEVELS.WARN || entry.level === LOG_LEVELS.ERROR,
      );
      continue;
    }

    if (pendingSource && pendingSource !== source) flushPending();
    pendingSource = source;
    pendingText += text;
  }
  flushPending();

  return { lines, chars };
}

// ============================================================================
// Schema
// ============================================================================

const ExecutionsToolInputSchema = z.strictObject({
  /** Virtual path: /executions, /executions/{id}, /executions/{id}/files, /executions/{id}/workspace-files/{path} */
  path: z.string().describe('Path starting with /executions'),

  /** Action to perform. */
  action: z
    .enum(['view', 'wait', 'kill', 'subscribe', 'unsubscribe'])
    .prefault('view')
    .describe(
      'view: read execution data (returns immediately). ' +
        'wait: wait for a status change on /executions or /executions/{id}, then return the same data as view (avoids sleep-poll loops). ' +
        'kill: terminate a running execution by ID (use on /executions/{id}). ' +
        'subscribe: receive future status changes for /executions/{id} as <execution-activity> follow-ups; auto-disposes when the execution finishes or this stream is released. ' +
        'unsubscribe: stop receiving <execution-activity> follow-ups for /executions/{id}.',
    ),

  /** Optional line range [start, end] for large outputs (action="view" only). */
  view_range: ViewRangeSchema.nullish().describe(
    'Line range [start, end] for paginating file and background-command output (action="view" only). Conversation pagination uses offset and limit.',
  ),

  /** Execution IDs to wait on (action="wait" with /executions only). */
  ids: z
    .array(ExecutionIdSchema)
    .min(1)
    .max(50)
    .nullish()
    .describe(
      'List of execution IDs to wait on (action="wait" with /executions only). ' +
        'Waits for any of the listed executions to change status. ' +
        'If omitted, waits for any active execution.',
    ),

  /** Max seconds to wait (action="wait" only). Default: 300. */
  timeout: z
    .number()
    .finite()
    .nullish()
    // Clamp in the schema so input.timeout is always a ready-to-use number:
    // an out-of-range or missing value becomes a value inside the wait window.
    .transform((v) =>
      clamp(
        v ?? EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
        EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
        EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
      ),
    )
    .describe(
      `Max seconds to wait for a status change (action="wait" only). Default: ${EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS}; finite values are clamped to the ${EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS}-${EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS} range.`,
    ),

  /** Zero-based offset for list or conversation pagination (action="view" only). */
  offset: z
    .int()
    .min(0)
    .nullish()
    .describe(
      'Zero-based offset into the executions list or conversation messages. Use with limit on /executions or /executions/{id}/conversation. Default: 0.',
    ),

  /** Maximum list entries or conversation messages to return (action="view" only). */
  limit: z
    .int()
    .min(1)
    .max(200)
    .nullish()
    .describe(
      'Max entries or conversation messages to return. Use on /executions or /executions/{id}/conversation. Default: 100, max: 200.',
    ),
});

type ExecutionsToolInput = z.infer<typeof ExecutionsToolInputSchema>;

export class ExecutionsTool extends defineTool({
  name: 'executions',
  slow: true,
  description: `View execution history and manage running executions.

Paths:
${EXECUTION_PATH_LIST}

Use "current" as {id} to access the active execution.
Use offset/limit to paginate the /executions listing or conversation messages (default: offset 0, limit 100).
Use view_range: [start, end] to paginate file and background-command output content.
Use action: "wait" on /executions or /executions/{id} to wait for a status change instead of polling.
Use action: "wait" with ids: ["id1", "id2", ...] on /executions to wait for any of the listed executions to change.
Use action: "kill" on /executions/{id} to terminate a running execution.
Use action: "subscribe" on /executions/{id} to receive future status and termination events as <execution-activity> follow-ups (auto-disposes when the execution finishes or this stream is released). Use action: "unsubscribe" on /executions/{id} to stop them.
Delegated subagent and workflow results are delivered automatically as follow-up messages. No wait or subscription is needed for executions you launched. Use action: "wait" only when you cannot proceed without a status change; use action: "subscribe" for push updates on executions whose results are not auto-delivered.`,
  schema: ExecutionsToolInputSchema,
}) {
  protected async execute(input: ExecutionsToolInput): Promise<ToolResult> {
    const segments = getPathSegments(input.path);
    const [namespace, id, resource, ...rest] = segments;

    if (namespace !== 'executions') {
      throw new ToolError(
        `Path must start with /executions. Got: ${input.path}`,
      );
    }

    // /executions - list all executions
    if (!id) {
      if (input.action === 'subscribe' || input.action === 'unsubscribe') {
        throw new ToolError(
          `action='${input.action}' requires a specific execution: use /executions/{id}.`,
        );
      }
      if (input.action === 'wait')
        await this.waitForAnyChange(input.timeout, input.ids);
      return this.listExecutions(input.offset ?? 0, input.limit ?? 100);
    }

    const executionId = this.resolveExecutionId(id);

    // /executions/{id} - execution summary or actions
    if (!resource) {
      // Kill action: terminate a running execution (only valid on /executions/{id})
      if (input.action === 'kill') {
        return this.handleKill(executionId);
      }
      if (input.action === 'subscribe') {
        return this.handleSubscribe(executionId);
      }
      if (input.action === 'unsubscribe') {
        return this.handleUnsubscribe(executionId);
      }
      if (input.action === 'wait')
        await this.waitForChange(executionId, input.timeout);
      return this.showSummary(executionId, {
        suppressAutoDeliveredSubagentReport: input.action === 'wait',
      });
    }

    const viewRange = input.view_range ?? undefined;

    switch (resource) {
      case 'config':
        return this.showConfig(executionId);
      case 'conversation': {
        if (viewRange) {
          throw new ToolError(
            'Conversation pagination is message-based. Use offset and limit; view_range applies only to file and background-command output.',
          );
        }
        return this.showConversation(
          executionId,
          input.offset ?? 0,
          input.limit ?? 100,
        );
      }
      case 'todos':
        return this.showTodos(executionId);
      case 'report':
        return this.showReport(executionId);
      case 'result':
        return this.showResultMeta(executionId);
      case 'children':
        return this.showChildren(executionId);
      case 'output':
        return this.showOutput(executionId, viewRange);
      case 'files':
        if (rest.length === 0) {
          return this.listFiles(executionId);
        }
        return this.readFile(executionId, rest.join('/'), viewRange);
      case 'workspace-files':
        if (rest.length === 0) {
          return this.listWorkspaceFiles(executionId);
        }
        return this.readWorkspaceFile(executionId, rest.join('/'), viewRange);
    }

    throw new ToolError(
      `Unknown path: ${input.path}.\nValid paths:\n${EXECUTION_PATH_LIST}`,
    );
  }

  private resolveExecutionId(id: string): ExecutionId {
    if (id === 'current') {
      const executionId = getRunContextExecutionId();
      if (!executionId) {
        throw new ToolError(
          'No active execution. Use a specific execution ID instead of "current".',
        );
      }
      return executionId;
    }
    const result = ExecutionIdSchema.safeParse(id);
    if (!result.success) {
      throw new ToolError(
        `Invalid execution ID format: ${id}. Expected hex string.`,
      );
    }
    return result.data;
  }

  /** Wait for executions to change status, with timeout. */
  private async waitForAnyChange(
    timeout: number,
    ids?: readonly string[] | null,
  ): Promise<void> {
    const candidateIds = ids?.length
      ? unique(ids)
      : currentSession().executions.getActiveIds();
    // Exclude executions that are already effectively done
    // (completed, inactive, or tool-use subagent WAITING with result delivered).
    const pendingIds = candidateIds.filter((id) => !shouldSkipWait(id));
    if (pendingIds.length === 0) return;

    await this.waitWithTimeout(
      timeout,
      (signal) =>
        currentSession().executions.waitForAnyChange(pendingIds, signal),
      () => pendingIds.every(shouldSkipWait),
    );
  }

  /** Wait for a specific execution to change status, with timeout. */
  private async waitForChange(
    executionId: ExecutionId,
    timeout: number,
  ): Promise<void> {
    if (shouldSkipWait(executionId)) return;
    await this.waitWithTimeout(
      timeout,
      (signal) =>
        currentSession().executions.waitForChange(executionId, signal),
      () => shouldSkipWait(executionId),
    );
  }

  /**
   * Shared wait choreography: arm a timeout and a follow-up listener that both
   * abort the wait, register the change callback, then re-check `settled` to
   * close the race window between the initial pre-check and registration.
   */
  private async waitWithTimeout(
    timeout: number,
    register: (signal: AbortSignal) => Promise<unknown>,
    settled: () => boolean,
  ): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout * 1000);
    // Abort early if a follow-up is sent to this stream (user wants to break the wait).
    const cleanupFollowUp = listenForFollowUp(ac);
    try {
      const waitPromise = register(ac.signal);
      if (settled()) ac.abort();
      await waitPromise;
    } finally {
      clearTimeout(timer);
      cleanupFollowUp();
    }
  }

  private async listExecutions(
    offset: number,
    limit: number,
  ): Promise<ToolResult> {
    const entries = await listExecutions();

    if (entries.length === 0) {
      return executed('No execution history found.');
    }

    const { page, start, end, total } = paginateToolListing(
      entries,
      offset,
      limit,
    );
    const lines = page.map(formatListingLine);

    return executed(
      `Executions (showing ${start}–${end} of ${total}, most recent first):\n\n${lines.join('\n')}${formatPaginationHint(end, total)}`,
    );
  }

  private async showSummary(
    executionId: ExecutionId,
    options: ExecutionSummaryOptions = {},
  ): Promise<ToolResult> {
    // Check in-memory handle first (free) — running executions have everything we need
    const session = currentSession();
    const handle = session.executions.getHandle(executionId);

    if (handle) {
      // Running execution: agent/status and task state are session-owned;
      // fetch only the remaining durable details from execution storage.
      const store = getExecutionStore(executionId);
      const todos = getRunningTodos(session, handle);
      const [meta, children, report] = await Promise.all([
        store.readMeta(),
        store.readChildren(),
        store.readReport(),
      ]);

      const info = session.executions.getStatus(handle);
      // `handle.category` is the live wire's execution mode, fabricated for a
      // non-agent run (a background bash reports toolUse). The stamped
      // identity is what the completed branch displays, so the running branch
      // reads it too and the same run cannot change category as it settles;
      // an agent run has no identity-derived category and keeps its mode.
      const category =
        executionDisplayCategory(meta?.identity, null) ?? handle.category;
      const lines = buildRunningSummaryLines(
        executionId,
        handle,
        category,
        info,
        meta,
      );

      await this.appendSummaryTail(
        lines,
        executionId,
        category,
        children,
        todos,
        report,
        {
          workflow: meta?.workflow,
          suppressReport: shouldSuppressAutoDeliveredSubagentReport(
            options,
            handle,
          ),
        },
      );

      return executed(lines.join('\n'));
    }

    // Completed execution: full KV fetch
    const store = getExecutionStore(executionId);
    const [meta, record, children, todosResult, report] = await Promise.all([
      store.readMeta(),
      store.readRunRecord(),
      store.readChildren(),
      readCompletedRunTodos(executionId),
      store.readReport(),
    ]);

    if (!meta && !record) {
      const resumability = await deriveResumability(executionId);
      if (!resumability.resumable) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      return executed(
        `Execution: ${executionId}\nStatus: resumable\n(No metadata available - use /executions/${executionId}/conversation to view messages)`,
      );
    }

    // Identity comes only from the stamped execution row; pre-identity rows
    // lost their reader per #9590 Stage 7 and degrade to the config-derived
    // display category, loudly.
    const identity = meta?.identity;
    if (meta && !identity) {
      logger.warn(
        CHANNEL,
        `Execution ${executionId} is a pre-identity row; showing config-derived category only (reader retired per #9590 Stage 7)`,
      );
    }
    const category = executionDisplayCategory(identity, record);
    const info = getExecutionStatusInfo(executionId, meta?.outcome);
    const lines = buildCompletedSummaryLines(
      executionId,
      record,
      identity,
      category,
      info,
      meta,
    );

    await this.appendSummaryTail(
      lines,
      executionId,
      category,
      children,
      todosResult.todos,
      report,
      { workflow: meta?.workflow },
    );

    return executed(lines.join('\n'));
  }

  /**
   * Append the shared summary tail (children, todos, report, available paths)
   * common to both the running-handle and completed-execution branches.
   */
  private async appendSummaryTail(
    lines: string[],
    executionId: ExecutionId,
    category: ExecutionDisplayCategory | undefined,
    children: ChildRecord[],
    todos: TodoEntry[],
    report: string | null,
    options: {
      readonly workflow?: WorkflowExecutionSnapshot;
      readonly suppressReport?: boolean;
    } = {},
  ): Promise<void> {
    if (options.workflow) {
      lines.push(
        '',
        'Workflow:',
        JSON.stringify(workflowExecutionView(options.workflow), null, 2),
      );
    }
    if (children.length > 0) {
      lines.push('', `Children (${children.length}):`);
      const formatted = await this.formatChildren(children);
      lines.push(...formatted.map((line) => `  ${line}`));
    }
    lines.push(
      ...buildSummaryTailLines(
        executionId,
        category,
        children.length > 0,
        todos,
        report,
        options,
      ),
    );
  }

  /** Fetch metas and format each child as a summary line. */
  private async formatChildren(children: ChildRecord[]): Promise<string[]> {
    const metas = await Promise.all(
      children.map((c) => getExecutionStore(c.id).readMeta()),
    );
    return children.map((child, i) => formatChildLine(child, metas[i]));
  }

  private handleKill(executionId: ExecutionId): ToolResult {
    const ctx = tryUseRunContext();
    const callerStreamId = getRunContextStreamId(ctx);

    if (getRunContextExecutionId(ctx) === executionId) {
      throw new ToolError(`Cannot kill your own execution (${executionId}).`);
    }

    const target = currentSession().executions.getHandle(executionId);
    if (!target) {
      throw new ToolError(
        `Execution ${executionId} not found or already completed.`,
      );
    }

    // Scope: can only kill your own children. Deny if no context.
    if (
      !(target instanceof AgentExecutionHandle) ||
      !target.isOwnedBy(callerStreamId)
    ) {
      throw new ToolError(
        `Cannot kill execution ${executionId}: not a child of this session.`,
      );
    }

    // Only block kills when the toggle is disabled (the guard above has
    // already narrowed `target` to an owned AgentExecutionHandle).
    if (
      !platform().workspaceState.get<boolean>(
        WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
        true,
      )
    ) {
      throw new ToolError(
        'Killing subagents is disabled. Enable it in Settings > Multi-Agent.',
      );
    }

    const success = currentSession().executions.kill(executionId, {
      detachActiveChildren: detachSubagentsOnStop(),
    });
    if (success) {
      return executed(`Execution ${executionId} terminated.`);
    }
    throw new ToolError(`Execution ${executionId} could not be terminated.`);
  }

  private handleSubscribe(executionId: ExecutionId): ToolResult {
    const { streamId, context: ctx } = requireRunStream('subscribe');
    // Subscribing to your own execution would feed every status transition
    // back into the same session, creating a self-sustaining loop of
    // <execution-activity> follow-ups.
    if (getRunContextExecutionId(ctx) === executionId) {
      throw new ToolError(
        `Cannot subscribe to your own execution (${executionId}).`,
      );
    }
    // A bind failure propagates as-is: `BaseTool.call` already formats the
    // message with `toErrorMessage`, so re-wrapping it added nothing.
    currentSession().subscriptions.bind(streamId, executionId);
    return executed(
      `Subscribed to ${executionId}. Status and termination events will arrive as follow-ups wrapped in <execution-activity>. Auto-disposes when the execution finishes or this stream is released. Call again with action='unsubscribe' to stop sooner.`,
      `Subscribed to ${executionId}`,
    );
  }

  private handleUnsubscribe(executionId: ExecutionId): ToolResult {
    const streamId = requireStreamId('unsubscribe');
    const removed = currentSession().subscriptions.unbind(
      streamId,
      executionId,
    );
    return executed(
      removed
        ? `Unsubscribed from ${executionId}.`
        : `No active subscription to ${executionId} on this stream.`,
    );
  }

  /**
   * Same source of truth as `showSummary()`'s completed-run todos branch: a
   * running execution's task list is read from session snapshot state. Once
   * the execution is finished this must route through
   * `readCompletedRunTodos()` so this endpoint never disagrees with the
   * summary about which tasks are still pending.
   */
  private async showTodos(executionId: ExecutionId): Promise<ToolResult> {
    const session = currentSession();
    const handle = session.executions.getHandle(executionId);
    const todos = handle
      ? getRunningTodos(session, handle)
      : (await readCompletedRunTodos(executionId)).todos;

    if (todos.length === 0) {
      return executed(`No task list found for execution ${executionId}.`);
    }

    const lines = formatTodoSection(todos);
    const header = formatTodoHeader(executionId, todos);

    return executed(`${header}\n\n${lines.join('\n')}`);
  }

  private async showReport(executionId: ExecutionId): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const [report, note] = await Promise.all([
      store.readReport(),
      turnAttributionNote(store),
    ]);
    if (!report) {
      return executed(
        `No report found for execution ${executionId}. Reports are persisted when subagents or background processes complete.`,
      );
    }
    return executed(note ? `${note}\n\n${report}` : report);
  }

  /**
   * Machine-readable final result for chaining a completed execution into a
   * later stage without parsing the prose report.
   */
  private async showResultMeta(executionId: ExecutionId): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const [resultMeta, note] = await Promise.all([
      store.readResultMeta(),
      turnAttributionNote(store),
    ]);
    if (!resultMeta) {
      return executed(
        `No structured result recorded for ${executionId} yet. It is written when the execution completes.`,
      );
    }
    // The note rides INSIDE the JSON: /result is the machine-readable
    // chaining endpoint, so prefixed prose would break JSON.parse
    // consumers precisely in the interrupted-turn case it describes.
    const payload = note
      ? { turnAttribution: note, ...unwrapResultMeta(resultMeta) }
      : unwrapResultMeta(resultMeta);
    return executed(JSON.stringify(payload, null, 2));
  }

  private async showChildren(executionId: ExecutionId): Promise<ToolResult> {
    const children = await getExecutionStore(executionId).readChildren();
    if (children.length === 0) {
      return executed(`No child executions found for ${executionId}.`);
    }

    const lines = await this.formatChildren(children);
    return executed(
      `Children of ${executionId} (${children.length}):\n\n${lines.join('\n')}`,
    );
  }

  private async showConfig(executionId: ExecutionId): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const record = await store.readRunRecord();

    if (!record) {
      throw new ToolError(`Config not found for execution: ${executionId}.`);
    }

    // Filter out fields irrelevant to this agent's category. Identity comes
    // only from the stamped execution row; a pre-identity row (reader retired
    // per #9590 Stage 7) degrades to the config-derived category, loudly.
    const meta = await store.readMeta();
    const identity = meta?.identity;
    if (meta && !identity) {
      logger.warn(
        CHANNEL,
        `Execution ${executionId} is a pre-identity row; filtering config by its config-derived category only (reader retired per #9590 Stage 7)`,
      );
    }
    const category = executionDisplayCategory(identity, record);
    return executed(serializeFilteredConfig(record, category));
  }

  private async showConversation(
    executionId: ExecutionId,
    offset: number,
    limit: number,
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const conversationResult = await readCompletedRunConversation(executionId);
    const { conversation, source, streamId } = conversationResult;
    const streamDiagnostics = [`Stream: ${streamId ?? 'none'}`];

    if (!conversation) {
      // Match the top-level execution lookup: a flow-only record is found only
      // when the shared storage decision says it is resumable.
      const meta = await store.readMeta();
      const resumability = await deriveResumability(executionId);
      const exists =
        meta !== null ||
        resumability.resumable ||
        hasCompletedRunConversationEvidence(conversationResult);
      if (!exists) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      return executed(
        formatConversation([], {
          totalMessages: 0,
          metadata: [
            'Source: none',
            ...streamDiagnostics,
            'Returned message interval: [0, 0)',
            'Next offset: none',
          ],
        }),
      );
    }

    const pageStart = Math.min(offset, conversation.length);
    const page = conversation.slice(pageStart, pageStart + limit);
    const pageEnd = pageStart + page.length;
    const output = formatConversation(page, {
      offset: pageStart,
      totalMessages: conversation.length,
      metadata: [
        `Source: ${source}`,
        ...streamDiagnostics,
        `Returned message interval: [${pageStart}, ${pageEnd})`,
        `Next offset: ${pageEnd < conversation.length ? pageEnd : 'none'}`,
      ],
    });

    return executed(output);
  }

  /**
   * stdout/stderr of a background command, projected from the transcript log
   * its child stream already writes (`createChildStream` in `tools/bash.ts`).
   *
   * This is the only route readable *while the command runs*: `/report` and
   * `/result` are written at completion, and the completion follow-up carries
   * only a 20-line preview, so without this the middle of a long build log is
   * unreachable even after the run ends. Restricted to process executions —
   * an agent run's rows are a model transcript, which `/conversation` already
   * renders properly.
   */
  private async showOutput(
    executionId: ExecutionId,
    viewRange?: [number, number],
  ): Promise<ToolResult> {
    // A tracked handle is also the liveness fact: the shared terminal
    // finalizer untracks it, so its presence means the command is still up.
    const handle = currentSession().executions.getHandle(executionId);
    const meta = await getExecutionStore(executionId).readMeta();
    if (!meta && !handle) {
      throw new ToolError(`Execution not found: ${executionId}`);
    }
    if (meta?.identity?.kind !== 'process') {
      return executed(
        `/executions/${executionId}/output is only available for background commands (bash with run_in_background). ` +
          `Use /executions/${executionId}/conversation for an agent run's message history.`,
      );
    }

    const transcripts = currentSession().transcripts;
    // The stream is the one stamped on execution metadata at registration.
    const streamId =
      handle instanceof AgentExecutionHandle
        ? handle.childStreamId
        : meta?.streamId;
    // Resident while the command runs (an open writer refuses eviction); a
    // released stream rehydrates from disk, and an ephemeral store no-ops.
    if (streamId) await transcripts.ensureLoaded(streamId);
    const log = streamId ? transcripts.get(streamId) : undefined;
    if (!log) {
      return executed(
        `No retained output for ${executionId}: its stream log is no longer available. ` +
          `Use /executions/${executionId}/report for the result summary.`,
      );
    }

    const { lines, chars } = projectProcessOutput(log.toJSON());
    const info = getExecutionStatusInfo(executionId, meta?.outcome);
    const footer = handle
      ? `[still running: re-read for more output, or use action='wait' on /executions/${executionId} to block until it finishes]`
      : `[finished: this is the retained log; /executions/${executionId}/report has the result summary]`;
    const out: string[] = [
      `Output for ${executionId} (process, ${formatStatusInfo(info)}): ${chars.toLocaleString()} retained transcript chars; command-output cap ${BASH_BACKGROUND_LOG_CAP_CHARS.toLocaleString()} chars, ${lines.length.toLocaleString()} lines.`,
    ];

    if (lines.length === 0) {
      out.push('', footer);
      return executed(out.join('\n'));
    }
    out.push('Lines are in arrival order; `err:` marks one written to stderr.');

    // Default to the tail, where a live build's news is; a view_range window
    // is clamped so a wide request still can't return an unbounded log.
    const first =
      viewRange?.[0] ?? Math.max(lines.length - OUTPUT_TAIL_LINES, 0) + 1;
    const requestedLast = Math.min(
      viewRange?.[1] ?? lines.length,
      lines.length,
    );
    const last = Math.min(requestedLast, first + OUTPUT_MAX_LINES - 1);

    if (first > last) {
      out.push(
        `No lines in the requested range; the log has ${lines.length} lines.`,
        '',
        footer,
      );
      return executed(out.join('\n'));
    }

    let hint = '';
    if (last < requestedLast) {
      hint = ` (capped at ${OUTPUT_MAX_LINES} lines per read; continue from view_range: [${last + 1}, …])`;
    } else if (!viewRange && first > 1) {
      hint = ` (the last ${OUTPUT_TAIL_LINES} by default; use view_range to page earlier ones)`;
    }
    out.push(
      `Showing lines ${first}-${last} of ${lines.length}${hint}.`,
      '',
      lines.slice(first - 1, last).join('\n'),
      '',
      footer,
    );

    return executed(
      out.join('\n'),
      `Read lines ${first}-${last} of /executions/${executionId}/output`,
    );
  }

  private async listFiles(executionId: ExecutionId): Promise<ToolResult> {
    const runDir = await findExistingRunStoragePath(executionId);
    if (!runDir) {
      return executed('No files generated for this execution.');
    }

    const entries = await listRunDirectoryFiles(runDir);

    if (entries.length === 0) {
      return executed('No files generated for this execution.');
    }

    const lines = formatSizedEntryLines(entries);

    return executed(
      `Files in /executions/${executionId}/files:\n\n${lines.join('\n')}`,
    );
  }

  private async readFile(
    executionId: ExecutionId,
    filePath: string,
    viewRange?: [number, number],
  ): Promise<ToolResult> {
    const displayPath = `/executions/${executionId}/files/${filePath}`;
    assertNoParentTraversal(filePath);
    const fullPath = await findExistingRunStoragePath(executionId, filePath);
    if (!fullPath) {
      throw new ToolError(`File not found: ${displayPath}`);
    }

    return readFileContent(StorageFS, fullPath, {
      directoryErrorPath: displayPath,
      resultPath: displayPath,
      viewRange,
    });
  }

  private async listWorkspaceFiles(
    executionId: ExecutionId,
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const [record, paths] = await Promise.all([
      store.readRunRecord(),
      store.readWorkspaceFiles(),
    ]);
    const entries = await listExecutionWorkspaceFiles(record, paths);

    if (entries.length === 0) {
      return executed(
        `No workspace files recorded for execution ${executionId}.`,
      );
    }

    const lines = formatSizedEntryLines(
      entries.map((entry) => ({
        path: entry.path,
        size: entry.size,
        isDir: entry.isDirectory,
      })),
    );

    return executed(
      `Workspace files for /executions/${executionId}/workspace-files:\n\n` +
        lines.join('\n'),
    );
  }

  private async readWorkspaceFile(
    executionId: ExecutionId,
    filePath: string,
    viewRange?: [number, number],
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const [record, paths] = await Promise.all([
      store.readRunRecord(),
      store.readWorkspaceFiles(),
    ]);
    const recordedPaths = new Set(
      paths.flatMap((candidate) => {
        const resolvedCandidate = resolveExecutionWorkspaceFilePath(
          record,
          candidate,
        );
        return resolvedCandidate ? [resolvedCandidate.path] : [];
      }),
    );
    // The listing renders recorded paths under a `workspace/` display prefix,
    // so a read in that display form retries against the stripped path.
    const direct = resolveExecutionWorkspaceFilePath(record, filePath);
    let resolved =
      direct && recordedPaths.has(direct.path) ? direct : undefined;
    const displayPrefix = 'workspace/';
    if (!resolved && filePath.startsWith(displayPrefix)) {
      const stripped = resolveExecutionWorkspaceFilePath(
        record,
        filePath.slice(displayPrefix.length),
      );
      resolved =
        stripped && recordedPaths.has(stripped.path) ? stripped : undefined;
    }
    if (!resolved) {
      throw new ToolError(
        `Workspace file not found: /executions/${executionId}/workspace-files/${filePath}`,
      );
    }

    return readFileContent(AbsoluteFS, resolved.absolutePath, {
      directoryErrorPath: `/executions/${executionId}/workspace-files/${filePath}`,
      resultPath: `/executions/${executionId}/workspace-files/${resolved.path}`,
      viewRange,
    });
  }
}

/**
 * Shared stat → directory-guard → read → format tail for `readFile` and
 * `readWorkspaceFile`, which differ only in which FS backend resolved the
 * path. `directoryErrorPath` and `resultPath` can differ (a workspace-file
 * read reports the raw requested path on error but the canonical resolved
 * path on success).
 */
interface FileBackend {
  stat: (target: string) => Promise<FileStat>;
  read: (target: string) => Promise<string>;
}

async function readFileContent(
  fs: FileBackend,
  fullPath: string,
  {
    directoryErrorPath,
    resultPath,
    viewRange,
  }: {
    directoryErrorPath: string;
    resultPath: string;
    viewRange: [number, number] | undefined;
  },
): Promise<ToolResult> {
  const stats = await fs.stat(fullPath);
  if (isDirectory(stats.type)) {
    throw new ToolError(
      `Path is a directory: ${directoryErrorPath}. Use without trailing path to list.`,
    );
  }

  const content = await fs.read(fullPath);
  return formatFileView({
    path: resultPath,
    lines: splitContentLines(content),
    viewRange,
    maxLines: Infinity,
  });
}
