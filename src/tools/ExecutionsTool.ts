/**
 * Tool for viewing and managing execution history, generated files, and
 * running processes. Supports viewing past executions, waiting for status
 * changes, reading output from background processes, and killing running
 * executions.
 */

// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - agent
import {
  getExecutionStore,
  type ExecutionListingEntry,
  type ChildRecord,
  type TodoEntry,
  listExecutions,
} from '@agent/storage';
import { flowKey } from '@agent/node/persistedFlow';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import {
  type ExecutionHandle,
  type ExecutionStatusInfo,
  ACTIVE_STATUSES,
  AgentExecutionHandle,
  ProcessExecutionHandle,
  getHandle,
  getActiveExecutionIds,
  waitForExecutionChange,
  waitForAnyExecutionChange,
  killExecution,
} from '@agent/runtime/executionRegistry';

// Local imports - utils
import { WorkspaceStateKey, workspaceSM } from '@common/state';
import { isDirectory } from '@common/files/fsEntryType';
import {
  STREAM_STATUS,
  EXECUTION_STATUS,
  ExecutionIdSchema,
  type ExecutionId,
} from '@shared/schemas';
import { StorageFS } from '@utils/files';
import { resolveStoragePath } from '@utils/files/taskRunStorage';
import { getPathSegments } from '@utils/core/pathCore';
import { splitContentLines } from '@utils/text/stringUtils';
import { ToolError, type ToolResult } from './result';
import { defineTool } from './core/define';
import {
  formatFileView,
  paginateToolListing,
  formatPaginationHint,
} from './utils';

// ============================================================================
// Category-aware field filtering
// ============================================================================

/** Config fields only relevant to workflow agents — hidden for toolUse. */
const WORKFLOW_ONLY_FIELDS = new Set([
  'inputFile',
  'inputFiles',
  'referenceFile',
  'referenceFiles',
  'auxiliaryFile',
  'auxiliaryFiles',
  'mediaFile',
  'mediaFiles',
  'outputFiles',
  'editedFile',
  'editedFiles',
  'useMultipleOutputs',
]);

/** Config fields only relevant to toolUse agents — hidden for workflow. */
const TOOL_USE_ONLY_FIELDS = new Set(['toolConfig']);

/** Return paths available for a given agent category. */
function getAvailablePaths(category?: string, hasChildren?: boolean): string[] {
  const common = ['config', 'report'];
  if (hasChildren) common.push('children');
  switch (category) {
    case 'toolUse':
      return [...common, 'conversation', 'todos'];
    case 'workflow':
      return [...common, 'files'];
    case 'process':
      return [...common, 'output'];
    default:
      return [...common, 'conversation', 'todos', 'files', 'output'];
  }
}

// ============================================================================
// Schema
// ============================================================================

const ExecutionsToolInputSchema = z.strictObject({
  /** Virtual path: /executions, /executions/{id}, /executions/{id}/files, /executions/{id}/files/{path} */
  path: z.string().describe('Path starting with /executions'),

  /** Action to perform. */
  action: z
    .enum(['view', 'wait', 'kill'])
    .prefault('view')
    .describe(
      'view: read execution data (returns immediately). ' +
        'wait: wait for a status change on /executions or /executions/{id}, then return the same data as view (avoids sleep-poll loops). ' +
        'kill: terminate a running execution by ID (use on /executions/{id}).',
    ),

  /** Optional line range [start, end] for large outputs (action="view" only). */
  view_range: z
    .array(z.int().min(1))
    .length(2)
    .refine(([start, end]) => end >= start, {
      error: 'view_range[1] must be >= view_range[0]',
    })
    .nullish()
    .describe(
      'Line range [start, end] for paginating large outputs (action="view" only).',
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
    .min(60)
    .max(1800)
    .nullish()
    .describe(
      'Max seconds to wait for a status change (action="wait" only). Default: 300, max: 1800.',
    ),

  /** Zero-based offset for paginating the /executions listing (action="view" only). */
  offset: z
    .int()
    .min(0)
    .nullish()
    .describe(
      'Zero-based offset into the executions list. Use with limit for pagination on /executions. Default: 0.',
    ),

  /** Maximum number of entries to return from the /executions listing (action="view" only). */
  limit: z
    .int()
    .min(1)
    .max(200)
    .nullish()
    .describe(
      'Max entries to return from /executions listing. Default: 100, max: 200.',
    ),
});

export type ExecutionsToolInput = z.infer<typeof ExecutionsToolInputSchema>;

// ============================================================================
// Helpers
// ============================================================================

/** Format status info as a display string. */
function formatStatusInfo(info: ExecutionStatusInfo): string {
  return info.elapsed
    ? `${info.status} (${info.elapsed} elapsed)`
    : info.status;
}

/** Resolve the runtime status for an execution ID, using persisted terminal status as fallback. */
function getExecutionStatusInfo(
  executionId: string,
  terminalStatus?: string,
): ExecutionStatusInfo {
  const handle = getHandle(executionId);
  if (handle) return handle.getStatus();
  return {
    status: terminalStatus ?? EXECUTION_STATUS.COMPLETED,
    elapsed: null,
  };
}

/**
 * Single-pass check: should the wait endpoint skip blocking on this execution?
 *
 * Returns true when:
 * - The handle is gone (execution already untracked / completed), OR
 * - The stream left all ACTIVE_STATUSES, OR
 * - The execution is a *tool-use subagent* in WAITING (job done, result
 *   already delivered via onBeforeWaiting). Workflow subagents in WAITING
 *   may still be awaiting retry/user action and should keep blocking.
 *
 * One getHandle + one getStatus per call — no redundant lookups.
 */
function shouldSkipWait(executionId: string): boolean {
  const handle = getHandle(executionId);
  if (!handle) return true;

  const { status } = handle.getStatus();
  if (!ACTIVE_STATUSES.has(status)) return true;

  // Tool-use subagent in WAITING = job delivered via onBeforeWaiting, don't block.
  // Workflow subagent in WAITING = may be waiting for retry/user action. Blocking
  // isn't very useful (only the user can unblock it), but the subagent is still
  // technically active so we don't skip — avoids misreporting it as done.
  // Non-subagent WAITING = human input needed, keep blocking.
  if (
    status === STREAM_STATUS.WAITING &&
    handle instanceof AgentExecutionHandle &&
    handle.category === 'toolUse' &&
    handle.parentStreamId !== handle.childStreamId
  ) {
    return true;
  }

  return false;
}

/** Format round progress as a display line, or empty string if unavailable. */
function formatProgressLine(handle: ExecutionHandle | undefined): string {
  const progress = handle?.getProgress();
  if (
    progress?.currentRound === undefined ||
    progress.totalRounds === undefined
  ) {
    return '';
  }
  return `Progress: round ${progress.currentRound + 1}/${progress.totalRounds}`;
}

/** Format a listing entry as a single summary line. */
function formatListingLine(entry: ExecutionListingEntry): string {
  const ts = entry.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
  const info = getExecutionStatusInfo(entry.id, entry.terminalStatus);
  const categoryTag = entry.category ? `  ${entry.category}` : '';
  const parentSuffix = entry.parentExecutionId
    ? `  parent=${entry.parentExecutionId}`
    : '';
  const descSuffix = entry.description ? `  — ${entry.description}` : '';
  return `${entry.id}  ${ts}  ${entry.agent}${categoryTag}  ${entry.model}  [${formatStatusInfo(info)}]${parentSuffix}${descSuffix}`;
}

const TODO_ICON: Record<string, string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
};

/** Format todo items as a checklist. */
function formatTodoSection(todos: TodoEntry[]): string[] {
  return todos.map((t) => {
    const icon = TODO_ICON[t.status ?? ''] ?? '[ ]';
    return `${icon} ${t.content ?? '(no description)'}`;
  });
}

/** Format a todo header with counts. */
function formatTodoHeader(executionId: string, todos: TodoEntry[]): string {
  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const pending = todos.length - completed - inProgress;
  return `Tasks for ${executionId} (${completed} done, ${inProgress} active, ${pending} pending):`;
}

export class ExecutionsTool extends defineTool({
  name: 'executions',
  description: `View execution history and manage running executions.

Paths:
- /executions - List executions (paginated; use offset/limit for pages)
- /executions/{id} - Execution summary (agent, model, timestamp, status, progress, children, todos)
- /executions/{id}/config - Agent configuration JSON
- /executions/{id}/conversation - Full message history (subagents)
- /executions/{id}/todos - Task list (tool-use subagents)
- /executions/{id}/report - Result report (persists after context compaction)
- /executions/{id}/children - Child executions
- /executions/{id}/output - stdout/stderr (background processes only)
- /executions/{id}/files - Generated files (workflows only)
- /executions/{id}/files/{path} - Read specific generated file (workflows only)

Use "current" as {id} to access the active execution.
Use offset/limit to paginate the /executions listing (default: offset 0, limit 100).
Use view_range: [start, end] to paginate conversation, output, and file content.
Use action: "wait" on /executions or /executions/{id} to wait for a status change instead of polling.
Use action: "wait" with ids: ["id1", "id2", ...] on /executions to wait for any of the listed executions to change.
Use action: "kill" on /executions/{id} to terminate a running execution.`,
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
      if (input.action === 'wait')
        await this.waitForAnyChange(input.timeout ?? 300, input.ids);
      return this.listExecutions(input.offset ?? 0, input.limit ?? 100);
    }

    const executionId = this.resolveExecutionId(id);

    // /executions/{id} - execution summary or actions
    if (!resource) {
      // Kill action: terminate a running execution (only valid on /executions/{id})
      if (input.action === 'kill') {
        return this.handleKill(executionId);
      }
      if (input.action === 'wait')
        await this.waitForChange(executionId, input.timeout ?? 300);
      return this.showSummary(executionId);
    }

    // /executions/{id}/config - agent configuration
    if (resource === 'config') {
      return this.showConfig(executionId);
    }

    // /executions/{id}/conversation - message history
    if (resource === 'conversation') {
      return this.showConversation(executionId, input.view_range ?? undefined);
    }

    // /executions/{id}/todos - subagent task list
    if (resource === 'todos') {
      return this.showTodos(executionId);
    }

    // /executions/{id}/report - persisted result report
    if (resource === 'report') {
      return this.showReport(executionId);
    }

    // /executions/{id}/children - child executions
    if (resource === 'children') {
      return this.showChildren(executionId);
    }

    // /executions/{id}/output - background process output
    if (resource === 'output') {
      return this.readProcessOutput(executionId, input.view_range ?? undefined);
    }

    // /executions/{id}/files or /executions/{id}/files/{path}
    if (resource === 'files') {
      if (rest.length === 0) {
        return this.listFiles(executionId);
      }
      return this.readFile(
        executionId,
        rest.join('/'),
        // Schema enforces length 2; cast since Zod infers number[]
        input.view_range as [number, number] | undefined,
      );
    }

    throw new ToolError(
      `Unknown path: ${input.path}.\n` +
        `Valid paths:\n` +
        `- /executions/{id}              - Summary (status, agent, model)\n` +
        `- /executions/{id}/config       - Agent configuration\n` +
        `- /executions/{id}/report       - Result report\n` +
        `- /executions/{id}/conversation - Message history (subagents)\n` +
        `- /executions/{id}/todos        - Task list (tool-use subagents)\n` +
        `- /executions/{id}/children     - Child executions\n` +
        `- /executions/{id}/output       - stdout/stderr (background processes)\n` +
        `- /executions/{id}/files        - Generated files (workflows)`,
    );
  }

  private resolveExecutionId(id: string): ExecutionId {
    if (id === 'current') {
      const ctx = getCurrentToolFileInteractionContext();
      if (!ctx?.executionId) {
        throw new ToolError(
          'No active execution. Use a specific execution ID instead of "current".',
        );
      }
      return ctx.executionId;
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
    const candidateIds = ids?.length ? [...ids] : getActiveExecutionIds();
    if (candidateIds.length === 0) return;

    // Exclude executions that are already effectively done
    // (completed, inactive, or tool-use subagent WAITING with result delivered).
    const pendingIds = candidateIds.filter((id) => !shouldSkipWait(id));
    if (pendingIds.length === 0) return;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout * 1000);
    // Register callback before re-checking to close the race window
    const waitPromise = waitForAnyExecutionChange(pendingIds, ac.signal);
    // Re-check after registration: if all resolved in the gap, abort.
    if (pendingIds.every(shouldSkipWait)) ac.abort();
    await waitPromise;
    clearTimeout(timer);
  }

  /** Wait for a specific execution to change status, with timeout. */
  private async waitForChange(
    executionId: ExecutionId,
    timeout: number,
  ): Promise<void> {
    if (shouldSkipWait(executionId)) return;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout * 1000);
    // Register callback before re-checking to close the race window
    const waitPromise = waitForExecutionChange(executionId, ac.signal);
    // Re-check after registration: if state changed in the gap, abort.
    if (shouldSkipWait(executionId)) ac.abort();
    await waitPromise;
    clearTimeout(timer);
  }

  private async listExecutions(
    offset: number,
    limit: number,
  ): Promise<ToolResult> {
    const entries = await listExecutions();

    if (entries.length === 0) {
      return { output: 'No execution history found.' };
    }

    const { page, start, end, total } = paginateToolListing(
      entries,
      offset,
      limit,
    );
    const lines = page.map(formatListingLine);

    // Count active background processes for the header
    const activeIds = getActiveExecutionIds();
    const bgCount = activeIds.filter(
      (id) => getHandle(id)?.category === 'process',
    ).length;
    const bgSuffix =
      bgCount > 0
        ? `, ${bgCount} background process${bgCount > 1 ? 'es' : ''} running`
        : '';

    const header = `Executions (showing ${start}\u2013${end} of ${total}${bgSuffix}, most recent first):`;
    return {
      output: `${header}\n\n${lines.join('\n')}${formatPaginationHint(end, total)}`,
    };
  }

  private async showSummary(executionId: ExecutionId): Promise<ToolResult> {
    // Check in-memory handle first (free) — running executions have everything we need
    const handle = getHandle(executionId);

    if (handle) {
      // Running execution: agent/status from handle, only fetch live data from KV
      const store = getExecutionStore(executionId);
      const [children, todos, report] = await Promise.all([
        store.readChildren(),
        store.readTodos(),
        store.readReport(),
      ]);

      const info = handle.getStatus();
      const lines = [
        `Execution: ${executionId}`,
        `Agent: ${handle.agentName}`,
        `Category: ${handle.category}`,
        `Started: ${new Date(handle.startedAt).toISOString()}`,
        `Status: ${formatStatusInfo(info)}`,
      ];

      const progressLine = formatProgressLine(handle);
      if (progressLine) lines.push(progressLine);

      await this.appendChildren(lines, children);

      if (todos.length > 0) {
        lines.push('', ...formatTodoSection(todos));
      }

      if (report) {
        lines.push('', 'Result:', report);
      }

      const runningPaths = getAvailablePaths(
        handle.category,
        children.length > 0,
      );
      lines.push(
        '',
        `Available paths: ${runningPaths.map((p) => `/executions/${executionId}/${p}`).join(', ')}`,
      );

      return { output: lines.join('\n') };
    }

    // Completed execution: full KV fetch
    const store = getExecutionStore(executionId);
    const [meta, config, children, todos, report] = await Promise.all([
      store.readMeta(),
      store.readConfig(),
      store.readChildren(),
      store.readTodos(),
      store.readReport(),
    ]);

    if (!meta && !config) {
      const hasFlow = await store.exists(flowKey(executionId));
      if (!hasFlow) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      return {
        output: `Execution: ${executionId}\nStatus: completed\n(No metadata available - use /executions/${executionId}/conversation to view messages)`,
      };
    }

    const category = meta?.category ?? config?.agentCategory;
    const info = getExecutionStatusInfo(executionId, meta?.terminalStatus);
    const lines = [
      `Execution: ${executionId}`,
      `Agent: ${config?.agent ?? 'unknown'}`,
      ...(category ? [`Category: ${category}`] : []),
      `Model: ${config?.model ?? 'default'}`,
      `Timestamp: ${meta?.timestamp ?? 'unknown'}`,
      `Status: ${formatStatusInfo(info)}`,
    ];

    if (meta?.description) {
      lines.push(`Description: ${meta.description}`);
    }

    if (meta?.parentExecutionId) {
      lines.push(`Parent: ${meta.parentExecutionId}`);
    }

    await this.appendChildren(lines, children);

    if (todos.length > 0) {
      lines.push('', ...formatTodoSection(todos));
    }

    if (report) {
      lines.push('', 'Result:', report);
    }

    const completedPaths = getAvailablePaths(category, children.length > 0);
    lines.push(
      '',
      `Available paths: ${completedPaths.map((p) => `/executions/${executionId}/${p}`).join(', ')}`,
    );

    return { output: lines.join('\n') };
  }

  /** Fetch metas and format each child as a summary line. */
  private async formatChildren(children: ChildRecord[]): Promise<string[]> {
    const metas = await Promise.all(
      children.map((c) => getExecutionStore(c.id).readMeta()),
    );
    return children.map((child, i) => {
      const childMeta = metas[i];
      const info = getExecutionStatusInfo(child.id, childMeta?.terminalStatus);
      const ts = child.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
      const desc = childMeta?.description ? `  — ${childMeta.description}` : '';
      return `${child.id}  ${ts}  ${child.agent}  [${formatStatusInfo(info)}]${desc}`;
    });
  }

  /** Append formatted child entries to output lines. */
  private async appendChildren(
    lines: string[],
    children: ChildRecord[],
  ): Promise<void> {
    if (children.length === 0) return;
    lines.push('', `Children (${children.length}):`);
    const formatted = await this.formatChildren(children);
    lines.push(...formatted.map((line) => `  ${line}`));
  }

  private handleKill(executionId: ExecutionId): ToolResult {
    const ctx = getCurrentToolFileInteractionContext();
    const callerStreamId = ctx?.streamId;

    if (ctx?.executionId === executionId) {
      return {
        output: `Cannot kill your own execution (${executionId}).`,
        isError: true,
      };
    }

    const target = getHandle(executionId);
    if (!target) {
      return {
        output: `Execution ${executionId} not found or already completed.`,
        isError: true,
      };
    }

    // Scope: can only kill your own children. Deny if no context.
    if (!callerStreamId || target.parentStreamId !== callerStreamId) {
      return {
        output: `Cannot kill execution ${executionId}: not a child of this session.`,
        isError: true,
      };
    }

    // Only block subagent kills when the toggle is disabled; process kills are always allowed.
    if (
      target instanceof AgentExecutionHandle &&
      !workspaceSM.get<boolean>(WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL, true)
    ) {
      return {
        output:
          'Killing subagents is disabled. Enable it in Settings > Multi-Agent.',
        isError: true,
      };
    }

    const success = killExecution(executionId);
    if (success) {
      return { output: `Execution ${executionId} terminated.` };
    }
    return {
      output: `Execution ${executionId} could not be terminated.`,
      isError: true,
    };
  }

  private async readProcessOutput(
    executionId: ExecutionId,
    viewRange?: number[],
  ): Promise<ToolResult> {
    // Running process: read live output from ephemeral temp files
    const handle = getHandle(executionId);
    if (handle instanceof ProcessExecutionHandle && handle.outputPaths) {
      const [stdout, stderr] = await Promise.all([
        fs.promises
          .readFile(handle.outputPaths.stdout, 'utf-8')
          .catch(() => ''),
        fs.promises
          .readFile(handle.outputPaths.stderr, 'utf-8')
          .catch(() => ''),
      ]);
      const sections: string[] = [`Output for ${executionId}:`];
      if (stdout) sections.push('', '<stdout>', stdout, '</stdout>');
      if (stderr) sections.push('', '<stderr>', stderr, '</stderr>');
      if (!stdout && !stderr) sections.push('', '(no output yet)');
      return { output: this.applyViewRange(sections.join('\n'), viewRange) };
    }

    // Completed process: temp files already cleaned up
    return {
      output: `Output for ${executionId} is no longer available (ephemeral output is cleaned up on completion). Use /executions/${executionId}/report to view the result summary.`,
    };
  }

  private async showTodos(executionId: ExecutionId): Promise<ToolResult> {
    const todos = await getExecutionStore(executionId).readTodos();

    if (todos.length === 0) {
      return { output: `No task list found for execution ${executionId}.` };
    }

    const lines = formatTodoSection(todos);
    const header = formatTodoHeader(executionId, todos);

    return { output: `${header}\n\n${lines.join('\n')}` };
  }

  private async showReport(executionId: ExecutionId): Promise<ToolResult> {
    const report = await getExecutionStore(executionId).readReport();
    if (!report) {
      return {
        output: `No report found for execution ${executionId}. Reports are persisted when subagents or background processes complete.`,
      };
    }
    return { output: report };
  }

  private async showChildren(executionId: ExecutionId): Promise<ToolResult> {
    const children = await getExecutionStore(executionId).readChildren();
    if (children.length === 0) {
      return {
        output: `No child executions found for ${executionId}.`,
      };
    }

    const lines = await this.formatChildren(children);
    return {
      output: `Children of ${executionId} (${children.length}):\n\n${lines.join('\n')}`,
    };
  }

  private async showConfig(executionId: ExecutionId): Promise<ToolResult> {
    const config = await getExecutionStore(executionId).readConfig();

    if (!config) {
      throw new ToolError(`Config not found for execution: ${executionId}.`);
    }

    // Filter out fields irrelevant to this agent's category
    const { agentCategory } = config;
    if (agentCategory) {
      const excludeSet =
        agentCategory === 'toolUse'
          ? WORKFLOW_ONLY_FIELDS
          : TOOL_USE_ONLY_FIELDS;
      const filtered = Object.fromEntries(
        Object.entries(config).filter(([key]) => !excludeSet.has(key)),
      );
      return { output: JSON.stringify(filtered, null, 2) };
    }

    return {
      output: JSON.stringify(config, null, 2),
    };
  }

  private async showConversation(
    executionId: ExecutionId,
    viewRange?: number[],
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const conversation = await store.readConversation();

    if (!conversation) {
      // readConversation already checked the flow blob; use lightweight
      // exists checks to distinguish "no execution" from "no messages yet"
      const exists =
        (await store.exists('meta')) ||
        (await store.exists(flowKey(executionId)));
      if (!exists) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      return { output: '(No conversation history available)' };
    }

    const messages = conversation.map((msg, i) => {
      const m = msg as { role?: string; content?: unknown };
      const role = m.role ?? 'unknown';
      const content = this.formatMessageContent(m.content);
      return `<message index="${i + 1}" role="${role}">\n${content}\n</message>`;
    });

    const header = `Conversation (${conversation.length} messages):\n\n`;
    const output = this.applyViewRange(
      header + messages.join('\n\n'),
      viewRange,
    );

    return { output };
  }

  private formatMessageContent(content: unknown): string {
    if (content == null) return '';
    if (typeof content === 'string') {
      return this.truncate(content, 500);
    }
    if (Array.isArray(content)) {
      return content.map((block) => this.formatBlock(block)).join('\n');
    }
    return this.truncate(JSON.stringify(content) ?? '', 500);
  }

  private formatBlock(block: unknown): string {
    if (typeof block === 'string') {
      return block;
    }
    const b = block as Record<string, unknown>;
    switch (b?.type) {
      case 'text':
        return (b.text as string) ?? '';
      case 'tool_use':
        return `[tool_use: ${b.name}(${this.truncate(JSON.stringify(b.input ?? {}), 100)})]`;
      case 'tool_result': {
        const output =
          typeof b.content === 'string'
            ? b.content
            : (JSON.stringify(b.content) ?? '');
        return `[tool_result: ${this.truncate(output, 100)}]`;
      }
      default:
        return this.truncate(JSON.stringify(block), 100);
    }
  }

  private truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
  }

  /** Internal KV metadata files stored alongside generated files. */
  private static readonly KV_FILES = new Set([
    'meta.json',
    'config.json',
    'conversation.json',
    'todos.json',
    'report.json',
    'result-meta.json',
  ]);

  private isKVFile(name: string): boolean {
    return (
      ExecutionsTool.KV_FILES.has(name) ||
      name.startsWith('child-') ||
      name.startsWith('flow_')
    );
  }

  private async listFiles(executionId: ExecutionId): Promise<ToolResult> {
    const runDir = await resolveStoragePath(executionId);
    if (!runDir) {
      return { output: 'No files generated for this execution.' };
    }

    const entries = (await this.walkDirectory(runDir, '', 2)).filter(
      (entry) => !this.isKVFile(entry.path.split('/').pop() ?? ''),
    );

    if (entries.length === 0) {
      return { output: 'No files generated for this execution.' };
    }

    const lines = entries.map((entry) => {
      const sizeStr = entry.isDir ? '<dir>' : this.formatSize(entry.size);
      return `${sizeStr.padStart(8)}  ${entry.path}`;
    });

    return {
      output: `Files in /executions/${executionId}/files:\n\n${lines.join('\n')}`,
    };
  }

  private async walkDirectory(
    basePath: string,
    relativePath: string,
    maxDepth: number,
  ): Promise<Array<{ path: string; size: number; isDir: boolean }>> {
    const results: Array<{ path: string; size: number; isDir: boolean }> = [];
    const fullPath = relativePath
      ? path.join(basePath, relativePath)
      : basePath;

    try {
      const entries = await StorageFS.readDir(fullPath);

      for (const [name, type] of entries) {
        // Build raw path for filesystem access (preserves platform separators),
        // then normalize to forward slashes only for display output.
        const entryRaw = relativePath ? path.join(relativePath, name) : name;
        const entryRelative = entryRaw.replaceAll('\\', '/');
        const entryFull = path.join(basePath, entryRaw);
        const isDir = isDirectory(type);

        try {
          const stats = await StorageFS.stat(entryFull);
          results.push({ path: entryRelative, size: stats.size, isDir });

          if (isDir && maxDepth > 1) {
            const children = await this.walkDirectory(
              basePath,
              entryRaw,
              maxDepth - 1,
            );
            results.push(...children);
          }
        } catch {
          // Skip entries we can't stat
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return results;
  }

  private async readFile(
    executionId: ExecutionId,
    filePath: string,
    viewRange?: [number, number],
  ): Promise<ToolResult> {
    const displayPath = `/executions/${executionId}/files/${filePath}`;
    const fullPath = await resolveStoragePath(executionId, filePath);
    if (!fullPath) {
      throw new ToolError(`File not found: ${displayPath}`);
    }

    const stats = await StorageFS.stat(fullPath);
    if (isDirectory(stats.type)) {
      throw new ToolError(
        `Path is a directory: ${displayPath}. Use without trailing path to list.`,
      );
    }

    const content = await StorageFS.read(fullPath);
    const lines = splitContentLines(content);

    return formatFileView({
      path: displayPath,
      lines,
      viewRange,
      maxLines: Infinity,
    });
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  }

  private applyViewRange(output: string, viewRange?: number[]): string {
    if (!viewRange || viewRange.length < 2) return output;
    const lines = output.split('\n');
    const [start, end] = viewRange;
    return lines
      .slice(Math.max(start - 1, 0), Math.min(end, lines.length))
      .join('\n');
  }
}
