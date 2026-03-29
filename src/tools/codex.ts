/**
 * Codex tool — spin off an OpenAI Codex agent via the @openai/codex-sdk.
 *
 * Supports foreground (blocking) and background (async follow-up) modes.
 * Threads are multi-turn: after the first turn, the child stream enters
 * WAITING state and accepts follow-ups from the user (via the stream tab's
 * follow-up input) or from the orchestrator (via the `thread_id` parameter).
 *
 * The Codex CLI handles its own auth (~/.codex/auth.json from `codex login`,
 * OPENAI_API_KEY, config files).
 *
 * Requires the Codex CLI binary — gated by the availability check in
 * externalToolDefs.ts.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import {
  getExecutionStore,
  registerExecution,
  writeTerminalStatus,
} from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  trackExecution,
  untrackExecution,
  AgentExecutionHandle,
} from '@agent/runtime/executionRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import {
  registerInterruptible,
  unregisterInterruptible,
  type IInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { FollowUpQueue } from '@agent/toolUse/FollowUpQueue';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import type { StreamTabId, ExecutionId } from '@shared/schemas';
import { MESSAGE_TYPES, STREAM_STATUS } from '@shared/schemas';
import { ToolError, type ToolResult } from '@tools/result';
import { escapeAttr, escapeText } from '@tools/subagentResults';
import {
  requestBashApproval,
  buildBashApprovalRejectedResult,
} from '@tools/approval/bashApproval';
import { formatDuration } from '@utils/core';
import { generateExecutionId } from '@utils/core/executionId';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { importCodexClass, findCodexBinaryPath } from './codexImport';

// Type-only imports (kept separate for bundler efficiency)
import type {
  RunResult,
  SandboxMode,
  Thread,
  ThreadItem,
} from '@openai/codex-sdk';

// ============================================================================
// Schema
// ============================================================================

/** All sandbox modes from the SDK, exposed to the LLM. */
const SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const satisfies readonly SandboxMode[];

const CodexInputSchema = z.strictObject({
  prompt: z.string().describe('Instruction for the Codex agent'),
  working_directory: z
    .string()
    .optional()
    .describe('Directory to run in (defaults to workspace root)'),
  sandbox_mode: z
    .enum(SANDBOX_MODES)
    .prefault('read-only')
    .describe('File access level for the Codex agent'),
  run_in_background: z
    .boolean()
    .prefault(false)
    .describe(
      'Run asynchronously. Returns immediately with execution ID. Result delivered as follow-up when complete.',
    ),
  thread_id: z
    .string()
    .optional()
    .describe(
      'Resume an existing Codex thread by its ID. ' +
        'When provided, continues the conversation from where it left off instead of starting a new one. ' +
        'Get the thread_id from the result of a previous codex call.',
    ),
});

export type CodexInput = z.infer<typeof CodexInputSchema>;

// ============================================================================
// Thread registry — keeps threads alive between turns for follow-ups
// ============================================================================

interface ActiveThread {
  thread: Thread;
  childStreamId: StreamTabId;
  logger: AgentLogger;
  executionId: string;
}

const threadRegistry = new Map<string, ActiveThread>();

function storeThread(threadId: string, entry: ActiveThread): void {
  threadRegistry.set(threadId, entry);
}

function getStoredThread(threadId: string): ActiveThread | undefined {
  return threadRegistry.get(threadId);
}

function removeThread(threadId: string): void {
  threadRegistry.delete(threadId);
}

// ============================================================================
// Codex follow-up session — duck-types as IInterruptible with a session
// ============================================================================

/**
 * Lightweight session that registers with the ToolUseAgentRegistry so
 * the follow-up input in the child stream tab can deliver messages.
 * Uses duck typing: `sendFollowUp()` checks for `session.appendFollowUp()`.
 */
class CodexFollowUpSession implements IInterruptible {
  private readonly queue = new FollowUpQueue();
  private interrupted = false;

  /** Duck-typed session interface expected by `isToolUseFlowContext()`. */
  readonly session = {
    appendFollowUp: (text: string): void => this.queue.enqueue(text),
    hasQueuedFollowUp: (): boolean => !this.queue.isEmpty(),
  };

  interrupt(): void {
    this.interrupted = true;
    this.queue.cancelWait();
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }

  async waitForFollowUp(): Promise<string[] | null> {
    return this.queue.waitAndDrainAll(() => this.interrupted);
  }

  dispose(): void {
    this.queue.dispose();
  }
}

// ============================================================================
// Result formatting
// ============================================================================

/**
 * Format a completed Codex turn for the tool result returned to the LLM.
 *
 * Only includes the final model response (what the LLM needs to act on) plus
 * a compact usage note. Intermediate details (commands run, files changed) are
 * streamed to the child stream tab and don't need to be in the result.
 */
function formatTurnResult(turn: RunResult, threadId?: string | null): string {
  const parts: string[] = [turn.finalResponse || '(no response)'];

  if (turn.usage) {
    parts.push(
      `[Tokens: ${turn.usage.input_tokens} in / ${turn.usage.output_tokens} out]`,
    );
  }

  if (threadId) {
    parts.push(`[Thread ID: ${threadId} — use thread_id to continue this session]`);
  }

  return parts.join('\n\n');
}

/** Format a Codex result for background delivery as XML. */
function formatCodexDelivery(
  executionId: string,
  prompt: string,
  wallTimeMs: number,
  turn: RunResult,
  threadId?: string | null,
): string {
  const durationSec = (wallTimeMs / 1000).toFixed(1);
  const response = turn.finalResponse || '(no response)';
  const lines = [
    `<codex-result id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, 200))}"${threadId ? ` thread-id="${escapeAttr(threadId)}"` : ''}>`,
    `<wall-time>${durationSec}s</wall-time>`,
    `<response>${escapeText(response)}</response>`,
  ];

  if (turn.usage) {
    lines.push(
      `<usage input="${turn.usage.input_tokens}" output="${turn.usage.output_tokens}" />`,
    );
  }

  lines.push('</codex-result>');
  return lines.join('\n');
}

/** Format a Codex error for background delivery. */
function formatCodexError(
  executionId: string,
  prompt: string,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `<codex-error id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, 200))}">`,
    `<message>${escapeText(message)}</message>`,
    '</codex-error>',
  ].join('\n');
}

// ============================================================================
// Stream tab helpers
// ============================================================================

/** Create a child stream tab for a codex execution and return its logger. */
function createCodexStream(
  executionId: string,
  parentStreamId: StreamTabId,
  prompt: string,
): { childStreamId: StreamTabId; logger: AgentLogger } {
  const childStreamId = `codex@codex-sdk#${executionId}` as StreamTabId;

  StreamStatusService.set(childStreamId, STREAM_STATUS.RUNNING);
  bus.emit('setActiveStream', {
    streamId: childStreamId,
    agentCategory: AgentCategory.ToolUse,
  });
  bus.emit('updateStreamDescription', {
    streamId: childStreamId,
    description: truncateWithEllipsis(prompt, 80),
  });

  const logger = new AgentLogger(childStreamId, true);
  const handle = new AgentExecutionHandle(
    executionId,
    parentStreamId,
    childStreamId,
    'codex',
    'toolUse',
  );
  trackExecution(handle);

  return { childStreamId, logger };
}

/** Log a completed codex thread item to the child stream's logger. */
function logCodexItem(
  item: ThreadItem,
  childStreamId: StreamTabId,
  logger: AgentLogger,
): void {
  switch (item.type) {
    case 'command_execution': {
      const exitInfo =
        item.exit_code === undefined
          ? item.status
          : item.exit_code === 0
            ? 'ok'
            : `exit ${item.exit_code}`;
      logger.logToolUse({
        toolName: 'bash',
        input: { command: item.command },
        output: `(${exitInfo})`,
        status: 'completed',
      });
      break;
    }
    case 'file_change': {
      const changes = item.changes.map((c: { kind: string; path: string }) => `${c.kind} ${c.path}`);
      if (changes.length > 0) {
        logger.info(`Files: ${changes.join(', ')}`);
      }
      break;
    }
    case 'agent_message':
      logger.info(item.text, { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
      break;
    case 'reasoning':
      logger.info(item.text, { messageType: MESSAGE_TYPES.THINKING });
      break;
    case 'mcp_tool_call': {
      const mcpItem = item as {
        server: string;
        tool: string;
        arguments: unknown;
        result?: { content: unknown[]; structured_content: unknown };
        error?: { message: string };
        status: string;
      };
      const output = mcpItem.error
        ? `Error: ${mcpItem.error.message}`
        : mcpItem.result?.structured_content
          ? JSON.stringify(mcpItem.result.structured_content, null, 2)
          : `(${mcpItem.status})`;
      logger.logToolUse({
        toolName: `mcp:${mcpItem.server}/${mcpItem.tool}`,
        input: mcpItem.arguments,
        output,
        status: 'completed',
      });
      break;
    }
    case 'web_search': {
      const searchItem = item as { query: string };
      logger.logWebSearch({ query: searchItem.query });
      break;
    }
    case 'todo_list': {
      const todoItem = item as { items: { text: string; completed: boolean }[] };
      // Map SDK todo items to TeXRA's native todo format and emit to the UI
      const todos = todoItem.items.map((t) => ({
        content: t.text,
        status: t.completed
          ? ('completed' as const)
          : ('pending' as const),
        activeForm: t.text,
      }));
      bus.emit('updateTodos', { streamId: childStreamId, todos });
      break;
    }
    case 'error':
      logger.error(item.message);
      break;
  }
}

/** Log a turn summary to the child stream. */
function logTurnSummary(
  logger: AgentLogger,
  wallTimeMs: number,
  usage: RunResult['usage'],
): void {
  logger.info(`Turn completed in ${formatDuration(wallTimeMs)}`);
  if (usage) {
    logger.info(
      `Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out`,
    );
  }
}

/** Finalize a codex child stream (mark completed/error, log summary). */
function finalizeCodexStream(
  childStreamId: StreamTabId,
  executionId: string,
  logger: AgentLogger,
  options?: { wallTimeMs?: number; usage?: RunResult['usage']; error?: unknown },
): void {
  if (options?.error) {
    const msg =
      options.error instanceof Error
        ? options.error.message
        : String(options.error);
    logger.error(msg);
  }
  if (options?.wallTimeMs != null) {
    logger.info(`Completed in ${formatDuration(options.wallTimeMs)}`);
  }
  if (options?.usage) {
    logger.info(
      `Tokens: ${options.usage.input_tokens} in / ${options.usage.output_tokens} out`,
    );
  }
  StreamStatusService.set(
    childStreamId,
    options?.error ? STREAM_STATUS.ERROR : STREAM_STATUS.READY,
  );
  untrackExecution(executionId);
}

// ============================================================================
// Follow-up loop — runs additional turns when user sends follow-ups
// ============================================================================

/**
 * After the initial turn, enter a loop that waits for user follow-ups
 * in the child stream tab and runs them on the same Codex thread.
 * The loop runs until interrupted or the session is disposed.
 */
function startFollowUpLoop(
  thread: Thread,
  childStreamId: StreamTabId,
  logger: AgentLogger,
): void {
  const followUpSession = new CodexFollowUpSession();
  registerInterruptible(childStreamId, followUpSession);

  StreamStatusService.set(childStreamId, STREAM_STATUS.WAITING);

  void (async () => {
    try {
      while (!followUpSession.isInterrupted()) {
        const messages = await followUpSession.waitForFollowUp();
        if (!messages || followUpSession.isInterrupted()) break;

        const userMessage = messages.join('\n\n');
        logger.info(userMessage, { messageType: MESSAGE_TYPES.USER_MESSAGE });

        StreamStatusService.set(childStreamId, STREAM_STATUS.RUNNING);
        const startedAt = Date.now();

        try {
          const turn = await runStreamedTurn(thread, userMessage, childStreamId, logger);
          logTurnSummary(logger, Date.now() - startedAt, turn.usage);
          StreamStatusService.set(childStreamId, STREAM_STATUS.WAITING);
        } catch (err) {
          logger.error(err instanceof Error ? err.message : String(err));
          StreamStatusService.set(childStreamId, STREAM_STATUS.WAITING);
        }
      }
    } finally {
      followUpSession.dispose();
      unregisterInterruptible(childStreamId);

      // Clean up thread from registry
      const threadId = thread.id;
      if (threadId) removeThread(threadId);

      // If still in WAITING, mark as READY (session ended)
      if (StreamStatusService.get(childStreamId) === STREAM_STATUS.WAITING) {
        StreamStatusService.set(childStreamId, STREAM_STATUS.READY);
      }
    }
  })();
}

// ============================================================================
// Streaming helpers
// ============================================================================

/** Run a single streamed turn, logging events to the child stream. */
async function runStreamedTurn(
  thread: Thread,
  prompt: string,
  childStreamId: StreamTabId,
  logger: AgentLogger,
): Promise<RunResult> {
  const { events } = await thread.runStreamed(prompt);
  const responseParts: string[] = [];
  let usage: RunResult['usage'] = null;

  for await (const event of events) {
    switch (event.type) {
      case 'item.completed': {
        const { item } = event;
        logCodexItem(item, childStreamId, logger);
        if (item.type === 'agent_message') {
          responseParts.push(item.text);
        }
        break;
      }
      case 'turn.completed':
        usage = event.usage ?? null;
        break;
      case 'turn.failed':
        throw new ToolError(event.error.message ?? 'Codex turn failed');
      case 'error':
        throw new ToolError(event.message ?? 'Codex stream error');
    }
  }

  return {
    items: [],
    finalResponse: responseParts.join('\n\n'),
    usage,
  };
}

// ============================================================================
// Tool
// ============================================================================

export class CodexTool extends defineTool({
  name: 'codex',
  description:
    'Spin off an OpenAI Codex agent to perform code analysis, generation, or research in a sandboxed environment. ' +
    'The agent runs the Codex CLI locally and can read files, run commands, and make edits within its sandbox. ' +
    'Requires the Codex CLI to be installed (`npm install -g @openai/codex`). ' +
    'Auth is handled by the CLI itself — use `codex login` (OAuth, recommended) or set OPENAI_API_KEY env var. ' +
    'Returns a thread_id that can be passed back to continue the conversation in subsequent calls.',
  schema: CodexInputSchema,
}) {
  protected async execute(input: CodexInput): Promise<ToolResult> {
    // Request approval — same pattern as BashTool
    const approvalLabel = `[codex ${input.sandbox_mode}] ${input.prompt}`;
    const approval = await requestBashApproval({ command: approvalLabel });
    if (!approval.accepted) {
      return buildBashApprovalRejectedResult(
        approvalLabel,
        approval.userMessage,
      );
    }

    // Signal execution starting
    const ctx = getCurrentToolFileInteractionContext();
    ctx?.onExecutionReady?.();

    const thread = await this.resolveThread(input);

    if (input.run_in_background) {
      return this.executeBackground(
        thread,
        input,
        ctx?.streamId,
        ctx?.executionId,
      );
    }

    return this.executeForeground(thread, input, ctx?.streamId);
  }

  /** Resolve thread — resume existing or start new. */
  private async resolveThread(input: CodexInput): Promise<Thread> {
    // If thread_id provided, try to reuse the in-memory thread first
    if (input.thread_id) {
      const stored = getStoredThread(input.thread_id);
      if (stored) return stored.thread;
    }

    const CodexClass = await importCodexClass();
    const codexPathOverride = findCodexBinaryPath();
    const codex = new CodexClass({ codexPathOverride });

    if (input.thread_id) {
      // Resume from disk (~/.codex/sessions)
      return codex.resumeThread(input.thread_id, {
        workingDirectory: input.working_directory,
        sandboxMode: input.sandbox_mode,
        skipGitRepoCheck: true,
      });
    }

    return codex.startThread({
      workingDirectory: input.working_directory,
      sandboxMode: input.sandbox_mode,
      skipGitRepoCheck: true,
    });
  }

  private async executeForeground(
    thread: Thread,
    input: CodexInput,
    parentStreamId?: StreamTabId,
  ): Promise<ToolResult> {
    const executionId = generateExecutionId();
    const preview = truncateWithEllipsis(input.prompt, 60);
    const startedAt = Date.now();

    const stream = parentStreamId
      ? createCodexStream(executionId, parentStreamId, input.prompt)
      : undefined;

    try {
      const turn = await runStreamedTurn(
        thread,
        input.prompt,
        stream?.childStreamId ?? ('' as StreamTabId),
        stream?.logger ?? new AgentLogger('codex-fg'),
      );

      const threadId = thread.id;
      const wallTimeMs = Date.now() - startedAt;

      if (stream) {
        logTurnSummary(stream.logger, wallTimeMs, turn.usage);

        // Store thread and start follow-up loop for user interaction
        if (threadId) {
          storeThread(threadId, {
            thread,
            childStreamId: stream.childStreamId,
            logger: stream.logger,
            executionId,
          });
          startFollowUpLoop(thread, stream.childStreamId, stream.logger);
        } else {
          finalizeCodexStream(stream.childStreamId, executionId, stream.logger, {
            wallTimeMs,
            usage: turn.usage,
          });
        }
      }

      return {
        summary: `Codex: ${preview}`,
        output: formatTurnResult(turn, threadId),
      };
    } catch (err) {
      if (stream) {
        finalizeCodexStream(stream.childStreamId, executionId, stream.logger, {
          error: err,
        });
      }
      throw err;
    }
  }

  private async executeBackground(
    thread: Thread,
    input: CodexInput,
    parentStreamId: StreamTabId | undefined,
    parentExecutionId: ExecutionId | undefined,
  ): Promise<ToolResult> {
    if (!parentStreamId) {
      throw new ToolError(
        'Background execution requires a parent stream context.',
      );
    }

    const executionId = generateExecutionId();
    await ensureRunDir(executionId);

    const preview = truncateWithEllipsis(input.prompt, 60);

    const syntheticConfig = AgentConfigSchema.parse({
      agent: 'codex',
      instruction: input.prompt,
    });

    try {
      await registerExecution(
        executionId,
        syntheticConfig,
        'codex',
        parentExecutionId,
      );
    } catch {
      throw new ToolError('Failed to register background Codex execution.');
    }

    const { childStreamId, logger } = createCodexStream(
      executionId,
      parentStreamId,
      input.prompt,
    );

    const startedAt = Date.now();

    void (async () => {
      try {
        const turn = await runStreamedTurn(thread, input.prompt, childStreamId, logger);
        const wallTimeMs = Date.now() - startedAt;
        const threadId = thread.id;
        const store = getExecutionStore(executionId);

        await writeTerminalStatus(executionId, 'completed').catch(() => {});
        logTurnSummary(logger, wallTimeMs, turn.usage);

        const msg = formatCodexDelivery(
          executionId,
          input.prompt,
          wallTimeMs,
          turn,
          threadId,
        );
        await store.writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);

        // Keep thread alive for follow-ups
        if (threadId) {
          storeThread(threadId, { thread, childStreamId, logger, executionId });
          startFollowUpLoop(thread, childStreamId, logger);
        } else {
          finalizeCodexStream(childStreamId, executionId, logger, {
            wallTimeMs,
            usage: turn.usage,
          });
        }
      } catch (err: unknown) {
        await writeTerminalStatus(executionId, 'error').catch(() => {});
        finalizeCodexStream(childStreamId, executionId, logger, { error: err });

        const msg = formatCodexError(executionId, input.prompt, err);
        await getExecutionStore(executionId).writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
      }
    })();

    return {
      summary: `Launched Codex: ${preview}`,
      output: [
        `Codex agent launched in background (${input.sandbox_mode}).`,
        `Execution ID: ${executionId}`,
        `Stream tab: ${childStreamId}`,
        'Result will be delivered as a follow-up message when complete.',
      ].join('\n'),
    };
  }
}
