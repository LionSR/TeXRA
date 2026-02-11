/**
 * Tool for viewing execution history and generated files.
 * Read-only access to past executions - agents can learn from history.
 */

// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  getStreamIdForExecution,
  getExecutionStartedAt,
  getExecutionProgress,
  waitForExecutionChange,
} from '@agent/runtime/executionRegistry';
import {
  getActiveSubagent,
  getSubagentStartedAt,
} from '@agent/runtime/subagentLineage';

// Local imports - common
import { AgentHistoryManager } from '@common/history/AgentHistoryManager';

// Local imports - utils
import { StorageFS } from '@utils/files';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { getPathSegments } from '@utils/core/pathCore';
import { formatDuration } from '@utils/core';
import { ToolError, type ToolResult } from './result';
import { defineTool } from './core/define';
import {
  STREAM_STATUS,
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

  /** Optional line range [start, end] for large outputs */
  view_range: z
    .array(z.int().min(1))
    .length(2)
    .refine(([start, end]) => end >= start, {
      error: 'view_range[1] must be >= view_range[0]',
    })
    .nullish(),

  /** Block on /executions/{id} until next status change instead of polling. */
  block: z
    .boolean()
    .prefault(false)
    .describe(
      'On /executions/{id}: wait for status change (round completed, execution finished) instead of polling. Workflow subagents take 10-30+ min; use block=true to wait efficiently.',
    ),

  /** Max seconds to wait when block=true. */
  timeout: z
    .number()
    .min(1)
    .max(1800)
    .prefault(300)
    .describe('Max seconds to wait when block=true. Default: 300, max: 1800.'),
});

export type ExecutionsToolInput = z.infer<typeof ExecutionsToolInputSchema>;

// ============================================================================
// Tool Implementation
// ============================================================================

/**
 * Read-only tool for viewing execution history and generated files.
 *
 * Paths:
 * - /executions - List all past executions
 * - /executions/{id} - Execution summary
 * - /executions/{id}/config - Agent configuration (JSON)
 * - /executions/{id}/conversation - Message history
 * - /executions/{id}/files - List generated files
 * - /executions/{id}/files/{path} - Read specific file
 */
interface ExecutionStatusInfo {
  status: string;
  elapsed: string | null;
}

/** Format status info as a display string. */
function formatStatusInfo(info: ExecutionStatusInfo): string {
  return info.elapsed
    ? `${info.status} (${info.elapsed} elapsed)`
    : info.status;
}

/** Statuses that represent an actively running execution. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.INITIALIZING,
  STREAM_STATUS.RESUMING,
]);

/** Resolve start time from registry, subagent lineage, or history timestamp. */
function resolveStartedAt(
  executionId: string,
  historyTimestamp?: string,
): number | undefined {
  return (
    getExecutionStartedAt(executionId) ??
    getSubagentStartedAt(executionId) ??
    (historyTimestamp ? new Date(historyTimestamp).getTime() : undefined)
  );
}

/**
 * Resolve the runtime status for an execution ID.
 * Returns stream status + elapsed time for active executions.
 */
function getExecutionStatusInfo(
  executionId: string,
  historyTimestamp?: string,
): ExecutionStatusInfo {
  let status: string;

  // Check execution registry first (covers all executions)
  const streamId = getStreamIdForExecution(executionId);
  if (streamId) {
    status = StreamStatusService.get(streamId) ?? STREAM_STATUS.RUNNING;
  } else {
    // Check subagent lineage (covers async subagents whose stream may have settled)
    const entry = getActiveSubagent(executionId);
    if (entry) {
      status =
        StreamStatusService.get(entry.childStreamId) ?? STREAM_STATUS.RUNNING;
    } else {
      return { status: EXECUTION_STATUS.COMPLETED, elapsed: null };
    }
  }

  // Only show elapsed time for actively running executions
  if (!ACTIVE_STATUSES.has(status)) {
    return { status, elapsed: null };
  }

  const startedAt = resolveStartedAt(executionId, historyTimestamp);
  return {
    status,
    elapsed: startedAt ? formatDuration(Date.now() - startedAt) : null,
  };
}

export class ExecutionsTool extends defineTool({
  name: 'executions',
  description: `View execution history and generated files (read-only).

Paths:
- /executions - List all past executions (with status and elapsed time)
- /executions/{id} - Execution summary (agent, model, timestamp, status, elapsed, progress)
- /executions/{id}/config - Agent configuration JSON (for delegate_workflow/delegate_agent)
- /executions/{id}/conversation - Full message history
- /executions/{id}/files - List generated files
- /executions/{id}/files/{path} - Read specific file

Use "current" as {id} to access the active execution.
Use view_range: [start, end] to paginate large outputs.`,
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
      return this.listExecutions();
    }

    const executionId = this.resolveExecutionId(id);

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
      `Unknown path: ${input.path}. Valid: /executions/{id}, /executions/{id}/config, /executions/{id}/conversation, /executions/{id}/files`,
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
    return result.data as ExecutionId;
  }

  private async listExecutions(): Promise<ToolResult> {
    const history = await AgentHistoryManager.getHistory();

    if (history.length === 0) {
      return { output: 'No execution history found.' };
    }

    const lines = history.map((item) => {
      const agent = item.agentConfig.agent;
      const model = item.agentConfig.model ?? 'unknown';
      const ts = item.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
      const info = getExecutionStatusInfo(item.id, item.timestamp);
      return `${item.id}  ${ts}  ${agent}  ${model}  [${formatStatusInfo(info)}]`;
    });

    return {
      output: `Executions (${history.length}, most recent first):\n\n${lines.join('\n')}`,
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

    const historyItem =
      await AgentHistoryManager.getHistoryItemById(executionId);

    if (!historyItem) {
      // Check if flow exists even without history entry
      const store = getExecutionStore(executionId);
      const flow = await store.read(`flow:${executionId}`);
      if (!flow) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      const info = getExecutionStatusInfo(executionId);
      const lines = [
        `Execution: ${executionId}`,
        `Status: ${formatStatusInfo(info)}`,
      ];
      const progress = getExecutionProgress(executionId);
      if (progress?.currentRound != null && progress.totalRounds != null) {
        lines.push(
          `Progress: round ${progress.currentRound + 1}/${progress.totalRounds}`,
        );
      }
      lines.push(
        `(No metadata available - use /executions/${executionId}/conversation to view messages)`,
      );
      return { output: lines.join('\n') };
    }

    const config = historyItem.agentConfig;
    const info = getExecutionStatusInfo(executionId, historyItem.timestamp);
    const lines = [
      `Execution: ${executionId}`,
      `Agent: ${config.agent}`,
      `Model: ${config.model ?? 'default'}`,
      `Timestamp: ${historyItem.timestamp}`,
      `Status: ${formatStatusInfo(info)}`,
    ];

    const progress = getExecutionProgress(executionId);
    if (progress?.currentRound != null && progress.totalRounds != null) {
      lines.push(
        `Progress: round ${progress.currentRound + 1}/${progress.totalRounds}`,
      );
    }

    lines.push('');
    lines.push('Available paths:');
    lines.push(
      `  /executions/${executionId}/config - Agent configuration (JSON)`,
    );
    lines.push(`  /executions/${executionId}/conversation - Message history`);
    lines.push(`  /executions/${executionId}/files - Generated files`);

    return { output: lines.join('\n') };
  }

  private async showConfig(executionId: ExecutionId): Promise<ToolResult> {
    const historyItem =
      await AgentHistoryManager.getHistoryItemById(executionId);

    if (!historyItem) {
      throw new ToolError(
        `Config not found for execution: ${executionId}. Config is only available for executions in history.`,
      );
    }

    return {
      output: JSON.stringify(historyItem.agentConfig, null, 2),
    };
  }

  private async showConversation(
    executionId: ExecutionId,
    viewRange?: number[],
  ): Promise<ToolResult> {
    const store = getExecutionStore(executionId);
    const flow = await store.read<{ shared?: { conversation?: unknown[] } }>(
      `flow:${executionId}`,
    );

    if (!flow) {
      throw new ToolError(`Execution not found: ${executionId}`);
    }

    const conversation = flow.shared?.conversation;
    if (!Array.isArray(conversation) || conversation.length === 0) {
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
