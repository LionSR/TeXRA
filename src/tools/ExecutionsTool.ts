/**
 * Tool for viewing and managing execution history, generated files, and
 * running processes. Supports viewing past executions, reading output
 * from background processes, and killing running executions.
 */

// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent
import {
  getExecutionStore,
  type TodoEntry,
  readTodos,
  readConversation,
  readReport,
  readMeta,
  readConfig,
  readChildren,
} from '@agent/storage';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import {
  type ExecutionStatusInfo,
  ACTIVE_STATUSES,
  getHandle,
  getActiveExecutionIds,
  waitForExecutionChange,
  waitForAnyExecutionChange,
  killExecution,
} from '@agent/runtime/executionRegistry';

// Local imports - common
import {
  AgentHistoryManager,
  type AgentHistoryItem,
} from '@common/history/AgentHistoryManager';

// Local imports - utils
import { StorageFS } from '@utils/files';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { getPathSegments } from '@utils/core/pathCore';
import { ToolError, type ToolResult } from './result';
import { defineTool } from './core/define';
import {
  EXECUTION_STATUS,
  ExecutionIdSchema,
  type ExecutionId,
} from '@shared/schemas';

// ============================================================================
// Schema
// ============================================================================

const ExecutionsToolInputSchema = z.strictObject({
  /** Virtual path: /executions, /executions/{id}, /executions/{id}/files, /executions/{id}/files/{path} */
  path: z.string().describe('Path starting with /executions'),

  /** Action to perform. */
  action: z
    .enum(['view', 'kill'])
    .prefault('view')
    .describe(
      'view: read execution data. kill: terminate a running execution by ID (use on /executions/{id}).',
    ),

  /** Optional line range [start, end] for large outputs */
  view_range: z
    .array(z.int().min(1))
    .length(2)
    .refine(([start, end]) => end >= start, {
      error: 'view_range[1] must be >= view_range[0]',
    })
    .nullish(),

  /** Block until next status change instead of returning immediately. */
  block: z
    .boolean()
    .prefault(false)
    .describe(
      'Wait for a status change instead of returning immediately (avoids sleep-poll loops). ' +
        'On /executions: wait for any active execution to change. ' +
        'On /executions/{id}: wait for that specific execution to change.',
    ),

  /** Max seconds to wait when block=true. */
  timeout: z
    .number()
    .min(1)
    .max(1800)
    .prefault(300)
    .describe(
      'Max seconds to wait when block=true. Ignored otherwise. Default: 300, max: 1800.',
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

/** Resolve the runtime status for an execution ID. */
function getExecutionStatusInfo(executionId: string): ExecutionStatusInfo {
  const handle = getHandle(executionId);
  if (handle) return handle.getStatus();
  return { status: EXECUTION_STATUS.COMPLETED, elapsed: null };
}

/** Format round progress as a display line, or empty string if unavailable. */
function formatProgressLine(executionId: string): string {
  const handle = getHandle(executionId);
  const progress = handle?.getProgress();
  if (
    progress?.currentRound === undefined ||
    progress.totalRounds === undefined
  ) {
    return '';
  }
  return `Progress: round ${progress.currentRound + 1}/${progress.totalRounds}`;
}

/** Format a history item as a single summary line. */
function formatHistoryLine(item: AgentHistoryItem): string {
  const agent = item.agentConfig.agent;
  const model = item.agentConfig.model ?? 'unknown';
  const ts = item.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
  const info = getExecutionStatusInfo(item.id);
  const parentSuffix = item.parentExecutionId
    ? `  parent=${item.parentExecutionId}`
    : '';
  return `${item.id}  ${ts}  ${agent}  ${model}  [${formatStatusInfo(info)}]${parentSuffix}`;
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
  description: `View execution history, generated files, and background process output. Kill running executions.

Paths:
- /executions - List all past executions (with status and elapsed time)
- /executions/{id} - Execution summary (agent, model, timestamp, status, elapsed, progress)
- /executions/{id}/config - Agent configuration JSON (for delegate_workflow/delegate_agent)
- /executions/{id}/conversation - Full message history
- /executions/{id}/todos - Subagent task list (if using todo_write)
- /executions/{id}/report - Subagent or background process result report (persists after context compaction)
- /executions/{id}/children - List child executions (subagents and background processes launched by this execution)
- /executions/{id}/output - Background process stdout/stderr (with view_range support)
- /executions/{id}/files - List generated files
- /executions/{id}/files/{path} - Read specific file

Use "current" as {id} to access the active execution.
Use view_range: [start, end] to paginate large outputs.
Use action: "kill" with /executions/{id} to terminate a running execution.`,
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
      return this.listExecutions({
        block: input.block,
        timeout: input.timeout,
      });
    }

    const executionId = this.resolveExecutionId(id);

    // Kill action: terminate a running execution
    if (input.action === 'kill') {
      return this.handleKill(executionId);
    }

    // /executions/{id} - execution summary
    if (!resource) {
      return this.showSummary(executionId, {
        block: input.block,
        timeout: input.timeout,
      });
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
        input.view_range ?? undefined,
      );
    }

    throw new ToolError(
      `Unknown path: ${input.path}. Valid: /executions/{id}, /executions/{id}/config, /executions/{id}/conversation, /executions/{id}/todos, /executions/{id}/report, /executions/{id}/children, /executions/{id}/output, /executions/{id}/files`,
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
        `Invalid execution ID format: ${id}. Expected 12-char hex ID or UUID.`,
      );
    }
    return result.data;
  }

  private async listExecutions(options: {
    block: boolean;
    timeout: number;
  }): Promise<ToolResult> {
    // Blocking wait: wait for any active execution to change
    if (options.block) {
      const activeIds = getActiveExecutionIds();
      if (activeIds.length > 0) {
        const timeoutMs = options.timeout * 1000;
        await Promise.race([
          waitForAnyExecutionChange(activeIds),
          new Promise<void>((r) => setTimeout(r, timeoutMs)),
        ]);
      }
    }

    const history = await AgentHistoryManager.getHistory();

    if (history.length === 0) {
      return { output: 'No execution history found.' };
    }

    const lines = history.map(formatHistoryLine);

    // Count active background processes for the header
    const activeIds = getActiveExecutionIds();
    const bgCount = activeIds.filter(
      (id) => getHandle(id)?.category === 'process',
    ).length;
    const header =
      bgCount > 0
        ? `Executions (${history.length} total, ${bgCount} background process${bgCount > 1 ? 'es' : ''} running):`
        : `Executions (${history.length}, most recent first):`;

    return {
      output: `${header}\n\n${lines.join('\n')}`,
    };
  }

  private async showSummary(
    executionId: ExecutionId,
    options: { block: boolean; timeout: number },
  ): Promise<ToolResult> {
    // Blocking wait: if requested and execution is active, wait for a status change
    if (options.block) {
      const info = getExecutionStatusInfo(executionId);
      if (ACTIVE_STATUSES.has(info.status)) {
        const timeoutMs = options.timeout * 1000;
        await Promise.race([
          waitForExecutionChange(executionId),
          new Promise<void>((r) => setTimeout(r, timeoutMs)),
        ]);
      }
    }

    // Parallel fetch all data from KV (each reader has its own fallback)
    const [meta, config, children, todos, report] = await Promise.all([
      readMeta(executionId),
      readConfig(executionId),
      readChildren(executionId),
      readTodos(executionId),
      readReport(executionId),
    ]);

    if (!meta && !config) {
      // Check if flow exists even without metadata
      const store = getExecutionStore(executionId);
      const hasFlow = await store.exists(`flow:${executionId}`);
      if (!hasFlow) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      const info = getExecutionStatusInfo(executionId);
      const lines = [
        `Execution: ${executionId}`,
        `Status: ${formatStatusInfo(info)}`,
      ];
      const progressLine = formatProgressLine(executionId);
      if (progressLine) lines.push(progressLine);
      lines.push(
        `(No metadata available - use /executions/${executionId}/conversation to view messages)`,
      );
      return { output: lines.join('\n') };
    }

    const cfg =
      config && typeof config === 'object'
        ? (config as Record<string, unknown>)
        : null;
    const info = getExecutionStatusInfo(executionId);
    const lines = [
      `Execution: ${executionId}`,
      `Agent: ${(cfg?.agent as string) ?? 'unknown'}`,
      `Model: ${(cfg?.model as string) ?? 'default'}`,
      `Timestamp: ${meta?.timestamp ?? 'unknown'}`,
      `Status: ${formatStatusInfo(info)}`,
    ];

    if (meta?.parentExecutionId) {
      lines.push(`Parent: ${meta.parentExecutionId}`);
    }

    const progressLine = formatProgressLine(executionId);
    if (progressLine) lines.push(progressLine);

    if (children.length > 0) {
      lines.push('', `Children (${children.length}):`);
      for (const child of children) {
        const childInfo = getExecutionStatusInfo(child.id);
        const ts = child.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
        lines.push(
          `  ${child.id}  ${ts}  ${child.agent}  [${formatStatusInfo(childInfo)}]`,
        );
      }
    }

    if (todos.length > 0) {
      lines.push('', ...formatTodoSection(todos));
    }

    if (report) {
      const preview =
        report.length > 500 ? `${report.slice(0, 497)}...` : report;
      lines.push('', 'Report preview:', preview);
    }

    return { output: lines.join('\n') };
  }

  private handleKill(executionId: ExecutionId): ToolResult {
    const success = killExecution(executionId);
    if (success) {
      return { output: `Execution ${executionId} terminated.` };
    }
    return {
      output: `Execution ${executionId} not found or already completed.`,
      isError: true,
    };
  }

  private async readProcessOutput(
    executionId: ExecutionId,
    viewRange?: number[],
  ): Promise<ToolResult> {
    const outputPath = path.join(TASK_RUNS_DIR, executionId, 'output.log');

    if (!(await StorageFS.exists(outputPath))) {
      throw new ToolError(
        `No output found for execution ${executionId}. This path is only available for background bash processes.`,
      );
    }

    const content = await StorageFS.read(outputPath);
    const output = this.applyViewRange(
      `Output for ${executionId}:\n\n${content}`,
      viewRange,
    );

    return { output };
  }

  private async showTodos(executionId: ExecutionId): Promise<ToolResult> {
    const todos = await readTodos(executionId);

    if (todos.length === 0) {
      return { output: `No task list found for execution ${executionId}.` };
    }

    const lines = formatTodoSection(todos);
    const header = formatTodoHeader(executionId, todos);

    return { output: `${header}\n\n${lines.join('\n')}` };
  }

  private async showReport(executionId: ExecutionId): Promise<ToolResult> {
    const report = await readReport(executionId);
    if (!report) {
      return {
        output: `No report found for execution ${executionId}. Reports are persisted when subagents or background processes complete.`,
      };
    }
    return { output: report };
  }

  private async showChildren(executionId: ExecutionId): Promise<ToolResult> {
    const children = await readChildren(executionId);
    if (children.length === 0) {
      return {
        output: `No child executions found for ${executionId}.`,
      };
    }

    const lines = children.map((child) => {
      const info = getExecutionStatusInfo(child.id);
      const ts = child.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
      return `${child.id}  ${ts}  ${child.agent}  [${formatStatusInfo(info)}]`;
    });

    return {
      output: `Children of ${executionId} (${children.length}):\n\n${lines.join('\n')}`,
    };
  }

  private async showConfig(executionId: ExecutionId): Promise<ToolResult> {
    const config = await readConfig(executionId);

    if (!config) {
      throw new ToolError(`Config not found for execution: ${executionId}.`);
    }

    return {
      output: JSON.stringify(config, null, 2),
    };
  }

  private async showConversation(
    executionId: ExecutionId,
    viewRange?: number[],
  ): Promise<ToolResult> {
    const conversation = await readConversation(executionId);

    if (!conversation) {
      // readConversation already checked the flow blob; use lightweight
      // exists checks to distinguish "no execution" from "no messages yet"
      const store = getExecutionStore(executionId);
      const exists =
        (await store.exists('meta')) ||
        (await store.exists(`flow:${executionId}`));
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
    if (typeof content === 'string') {
      return this.truncate(content, 500);
    }
    if (Array.isArray(content)) {
      return content.map((block) => this.formatBlock(block)).join('\n');
    }
    return this.truncate(JSON.stringify(content), 500);
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
          typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        return `[tool_result: ${this.truncate(output, 100)}]`;
      }
      default:
        return this.truncate(JSON.stringify(block), 100);
    }
  }

  private truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
  }

  private async listFiles(executionId: ExecutionId): Promise<ToolResult> {
    const runDir = path.join(TASK_RUNS_DIR, executionId);

    if (!(await StorageFS.exists(runDir))) {
      return { output: 'No files generated for this execution.' };
    }

    const entries = await this.walkDirectory(runDir, '', 2);

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
        const isDir = type === vscode.FileType.Directory;

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
    viewRange?: number[],
  ): Promise<ToolResult> {
    const fullPath = path.join(TASK_RUNS_DIR, executionId, filePath);

    if (!(await StorageFS.exists(fullPath))) {
      throw new ToolError(
        `File not found: /executions/${executionId}/files/${filePath}`,
      );
    }

    const stats = await StorageFS.stat(fullPath);
    if (stats.type === vscode.FileType.Directory) {
      throw new ToolError(
        `Path is a directory: /executions/${executionId}/files/${filePath}. Use without trailing path to list.`,
      );
    }

    const content = await StorageFS.read(fullPath);
    const output = this.applyViewRange(
      `File: /executions/${executionId}/files/${filePath}\n\n${content}`,
      viewRange,
    );

    return { output };
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
