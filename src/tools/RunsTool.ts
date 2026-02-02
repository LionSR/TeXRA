/**
 * Tool for viewing execution history and generated files.
 * Read-only access to past runs - agents can learn from history.
 */

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';

// Local imports - common
import { AgentHistoryManager } from '@common/history/AgentHistoryManager';

// Local imports - tools

// Local imports - utils
import { StorageFS } from '@utils/files';
import { TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { getPathSegments } from '@utils/core/pathCore';
import { ToolError, type ToolResult } from './result';
import { defineTool } from './core/define';
import type { ExecutionId } from '@shared/schemas';

// ============================================================================
// Schema
// ============================================================================

const RunsToolInputSchema = z.strictObject({
  /** Virtual path: /runs, /runs/{id}, /runs/{id}/files, /runs/{id}/files/{path} */
  path: z.string().describe('Path starting with /runs'),

  /** Optional line range [start, end] for large outputs */
  view_range: z
    .array(z.int().min(1))
    .length(2)
    .refine(([start, end]) => end >= start, {
      error: 'view_range[1] must be >= view_range[0]',
    })
    .nullish(),
});

export type RunsToolInput = z.infer<typeof RunsToolInputSchema>;

// ============================================================================
// Tool Implementation
// ============================================================================

/**
 * Read-only tool for viewing execution history and generated files.
 *
 * Paths:
 * - /runs - List all past executions
 * - /runs/{id} - Execution summary
 * - /runs/{id}/config - Agent configuration (JSON)
 * - /runs/{id}/conversation - Message history
 * - /runs/{id}/files - List generated files
 * - /runs/{id}/files/{path} - Read specific file
 */
export class RunsTool extends defineTool({
  name: 'runs',
  description: `View execution history and generated files (read-only).

Paths:
- /runs - List all past executions
- /runs/{id} - Execution summary (agent, model, timestamp)
- /runs/{id}/config - Agent configuration JSON (for propose_workflow/propose_agent)
- /runs/{id}/conversation - Full message history
- /runs/{id}/files - List generated files
- /runs/{id}/files/{path} - Read specific file

Use "current" as {id} to access the active execution.
Use view_range: [start, end] to paginate large outputs.`,
  schema: RunsToolInputSchema,
}) {
  protected async execute(input: RunsToolInput): Promise<ToolResult> {
    const segments = getPathSegments(input.path);
    const [namespace, id, resource, ...rest] = segments;

    if (namespace !== 'runs') {
      throw new ToolError(`Path must start with /runs. Got: ${input.path}`);
    }

    // /runs - list all executions
    if (!id) {
      return this.listRuns();
    }

    const executionId = this.resolveExecutionId(id);

    // /runs/{id} - execution summary
    if (!resource) {
      return this.showSummary(executionId);
    }

    // /runs/{id}/config - agent configuration
    if (resource === 'config') {
      return this.showConfig(executionId);
    }

    // /runs/{id}/conversation - message history
    if (resource === 'conversation') {
      return this.showConversation(executionId, input.view_range ?? undefined);
    }

    // /runs/{id}/files or /runs/{id}/files/{path}
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
      `Unknown path: ${input.path}. Valid: /runs/{id}, /runs/{id}/config, /runs/{id}/conversation, /runs/{id}/files`,
    );
  }

  /**
   * Resolve "current" to active execution ID, or return as-is.
   */
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
    return id as ExecutionId;
  }

  /**
   * List all executions from history (most recent first).
   */
  private async listRuns(): Promise<ToolResult> {
    const history = await AgentHistoryManager.getHistory();

    if (history.length === 0) {
      return { output: 'No execution history found.' };
    }

    const lines = history.map((item) => {
      const agent = item.agentConfig.agent;
      const model = item.agentConfig.model ?? 'unknown';
      // Format timestamp: extract date and time
      const ts = item.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
      return `${item.id}  ${ts}  ${agent}  ${model}`;
    });

    return {
      output: `Executions (${history.length}, most recent first):\n\n${lines.join('\n')}`,
    };
  }

  /**
   * Show execution summary (brief metadata).
   */
  private async showSummary(executionId: ExecutionId): Promise<ToolResult> {
    const historyItem =
      await AgentHistoryManager.getHistoryItemById(executionId);

    if (!historyItem) {
      // Check if flow exists even without history entry
      const store = getExecutionStore(executionId);
      const flow = await store.read(`flow:${executionId}`);
      if (!flow) {
        throw new ToolError(`Execution not found: ${executionId}`);
      }
      return {
        output: `Execution: ${executionId}\n(No metadata available - use /runs/${executionId}/conversation to view messages)`,
      };
    }

    const config = historyItem.agentConfig;
    const lines = [
      `Execution: ${executionId}`,
      `Agent: ${config.agent}`,
      `Model: ${config.model ?? 'default'}`,
      `Timestamp: ${historyItem.timestamp}`,
    ];

    lines.push('');
    lines.push('Available paths:');
    lines.push(`  /runs/${executionId}/config - Agent configuration (JSON)`);
    lines.push(`  /runs/${executionId}/conversation - Message history`);
    lines.push(`  /runs/${executionId}/files - Generated files`);

    return { output: lines.join('\n') };
  }

  /**
   * Show agent configuration as JSON.
   */
  private async showConfig(executionId: ExecutionId): Promise<ToolResult> {
    const historyItem =
      await AgentHistoryManager.getHistoryItemById(executionId);

    if (!historyItem) {
      throw new ToolError(
        `Config not found for execution: ${executionId}. Config is only available for executions in history.`,
      );
    }

    const config = historyItem.agentConfig;
    return {
      output: JSON.stringify(config, null, 2),
    };
  }

  /**
   * Show conversation/message history.
   */
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

    const conversation = flow?.shared?.conversation;
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

  /**
   * Format message content for display.
   */
  private formatMessageContent(content: unknown): string {
    if (typeof content === 'string') {
      return this.truncate(content, 500);
    }
    if (Array.isArray(content)) {
      return content.map((block) => this.formatBlock(block)).join('\n');
    }
    return this.truncate(JSON.stringify(content), 500);
  }

  /**
   * Format a single content block.
   */
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

  /**
   * Truncate string with ellipsis if too long.
   */
  private truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
  }

  /**
   * List files in task run directory.
   */
  private async listFiles(executionId: ExecutionId): Promise<ToolResult> {
    const runDir = `${TASK_RUNS_DIR}/${executionId}`;

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
      output: `Files in /runs/${executionId}/files:\n\n${lines.join('\n')}`,
    };
  }

  /**
   * Walk directory up to maxDepth levels.
   */
  private async walkDirectory(
    basePath: string,
    relativePath: string,
    maxDepth: number,
  ): Promise<Array<{ path: string; size: number; isDir: boolean }>> {
    const results: Array<{ path: string; size: number; isDir: boolean }> = [];
    const fullPath = relativePath ? `${basePath}/${relativePath}` : basePath;

    try {
      const entries = await StorageFS.readDir(fullPath);

      for (const [name, type] of entries) {
        const entryRelative = relativePath ? `${relativePath}/${name}` : name;
        const entryFull = `${basePath}/${entryRelative}`;
        const isDir = type === vscode.FileType.Directory;

        try {
          const stats = await StorageFS.stat(entryFull);
          results.push({ path: entryRelative, size: stats.size, isDir });

          if (isDir && maxDepth > 1) {
            const children = await this.walkDirectory(
              basePath,
              entryRelative,
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

  /**
   * Read a specific file from task run storage.
   */
  private async readFile(
    executionId: ExecutionId,
    filePath: string,
    viewRange?: number[],
  ): Promise<ToolResult> {
    const fullPath = `${TASK_RUNS_DIR}/${executionId}/${filePath}`;

    if (!(await StorageFS.exists(fullPath))) {
      throw new ToolError(
        `File not found: /runs/${executionId}/files/${filePath}`,
      );
    }

    const stats = await StorageFS.stat(fullPath);
    if (stats.type === vscode.FileType.Directory) {
      throw new ToolError(
        `Path is a directory: /runs/${executionId}/files/${filePath}. Use without trailing path to list.`,
      );
    }

    const content = await StorageFS.read(fullPath);
    const output = this.applyViewRange(
      `File: /runs/${executionId}/files/${filePath}\n\n${content}`,
      viewRange,
    );

    return { output };
  }

  /**
   * Format bytes to human-readable size.
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  }

  /**
   * Apply view_range to output string (line-based pagination).
   */
  private applyViewRange(output: string, viewRange?: number[]): string {
    if (!viewRange || viewRange.length < 2) return output;
    const lines = output.split('\n');
    const [start, end] = viewRange;
    return lines
      .slice(Math.max(start - 1, 0), Math.min(end, lines.length))
      .join('\n');
  }
}
