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
import { type AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  trackExecution,
  untrackExecution,
  AgentExecutionHandle,
} from '@agent/runtime/executionRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import {
  getInterruptible,
  registerInterruptible,
  unregisterInterruptible,
  type IInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { FollowUpQueue } from '@agent/toolUse/FollowUpQueue';
import { toErrorMessage } from '@common/errors';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import { AgentUsageReporter } from '@logger/AgentUsageReporter';
import type {
  StreamTabId,
  ExecutionId,
  StorageKey,
  ToolUseLog,
} from '@shared/schemas';
import { MESSAGE_TYPES, STREAM_STATUS } from '@shared/schemas';
import { ToolError, type ToolResult } from '@tools/result';
import { escapeAttr, escapeText } from '@tools/subagentResults';
import {
  requestBashApproval,
  buildBashApprovalRejectedResult,
} from '@tools/approval/bashApproval';
import { agentConfigToTaskState } from '@utils/config/configConversion';
import { generateExecutionId } from '@utils/core/executionId';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import {
  buildCodexConfig,
  buildCodexWorkspaceOptions,
  getCodexSandboxMode,
} from './codexConfig';
import { importCodexClass, findCodexBinaryPath } from './codexImport';
import {
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
  buildCodexMcpToolLog,
  buildCodexThreadToolLog,
  buildCodexTodoToolLog,
  buildCodexTurnToolLog,
  buildCodexUsageStats,
  CODEX_AGENT_NAME,
} from './codexShared';

// Type-only imports (kept separate for bundler efficiency)
import type {
  RunResult,
  SandboxMode,
  Thread,
  ThreadEvent,
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
    .nullish()
    .describe(
      'Directory to run in. Defaults to the workspace root. Accepts relative workspace paths or absolute paths such as a separate git worktree.',
    ),
  sandbox_mode: z
    .enum(SANDBOX_MODES)
    .nullish()
    .describe(
      'File access level for the Codex agent. Defaults to the user-configured sandbox mode (usually workspace-write).',
    ),
  run_in_background: z
    .boolean()
    .prefault(false)
    .describe(
      'Run asynchronously. Returns immediately with execution ID. Result delivered as follow-up when complete.',
    ),
  thread_id: z
    .string()
    .nullish()
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
  executionId: ExecutionId;
}

const threadRegistry = new Map<string, ActiveThread>();

interface TrackedToolUseLog {
  logId: string;
  groupId: string | undefined;
}

interface ActiveTrackedToolUseLog extends TrackedToolUseLog {
  latestToolLog: ToolUseLog;
}

interface ActiveCodexTurnLog extends TrackedToolUseLog {
  startedAt: number;
}

/** Store a thread for multi-turn reuse and persist thread ID to disk. */
function storeThread(threadId: string, entry: ActiveThread): void {
  threadRegistry.set(threadId, entry);
  // Extension reload clears memory but SDK stores sessions on disk —
  // persist the ID so resumeThread() can reconstruct the conversation.
  void getExecutionStore(entry.executionId)
    .write('codex_thread_id', threadId)
    .catch(() => {});
}

/** Prevents codex streams from remaining in stale WAITING state during reload. */
export function interruptAllCodexSessions(): void {
  for (const { childStreamId } of [...threadRegistry.values()]) {
    getInterruptible(childStreamId)?.interrupt();
  }
}

// ============================================================================
// Codex follow-up session — IInterruptible only (no ToolUseFlowContext)
// ============================================================================

/**
 * Lightweight interruptible registered with the ToolUseAgentRegistry so the
 * stop button works on codex child streams.
 *
 * Does NOT implement the session duck-type (no `session.appendFollowUp`),
 * which prevents `getToolUseFlowContext()` from matching it — commands like
 * `compactResponse` that access `flowContext.modelHandler` won't crash.
 *
 * Follow-ups route through the WAITING state queue path instead:
 * `sendFollowUp()` → stream is WAITING → `ToolUseFollowUpQueue.enqueue()`.
 */
class CodexFollowUpSession implements IInterruptible {
  private interrupted = false;
  private queue: FollowUpQueue | null = null;

  interrupt(): void {
    this.interrupted = true;
    this.queue?.cancelWait();
  }

  constructor() {}

  setQueue(q: FollowUpQueue): void {
    this.queue = q;
  }

  isInterrupted(): boolean {
    return this.interrupted;
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
    parts.push(
      `[Thread ID: ${threadId} — use thread_id to continue this session]`,
    );
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
  return [
    `<codex-error id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, 200))}">`,
    `<message>${escapeText(toErrorMessage(err))}</message>`,
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
  config: AgentConfig,
): { childStreamId: StreamTabId; logger: AgentLogger } {
  const childStreamId = `codex@codex-sdk#${executionId}` as StreamTabId;

  StreamStatusService.set(childStreamId, STREAM_STATUS.RUNNING);
  bus.emit('setActiveStream', {
    streamId: childStreamId,
    agentCategory: AgentCategory.ToolUse,
  });
  bus.emit('setTaskState', {
    streamId: childStreamId,
    executionId,
    taskState: agentConfigToTaskState(config),
    storageKey: executionId as StorageKey,
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
    CODEX_AGENT_NAME,
    'toolUse',
  );
  trackExecution(handle);

  return { childStreamId, logger };
}

function syncCodexTodoState(
  item: Extract<ThreadItem, { type: 'todo_list' }>,
  childStreamId: StreamTabId,
): void {
  const todos = item.items.map((t) => ({
    content: t.text,
    status: t.completed ? ('completed' as const) : ('pending' as const),
    activeForm: t.text,
  }));
  bus.emit('updateTodos', { streamId: childStreamId, todos });
}

function updateTrackedToolUseLog(
  logger: AgentLogger,
  trackedLog: TrackedToolUseLog,
  toolLog: ToolUseLog,
): void {
  const { status = 'completed', ...toolLogData } = toolLog;
  logger.updateToolUse(
    trackedLog.logId,
    toolLogData,
    trackedLog.groupId,
    status,
  );
}

function upsertTrackedToolUseLog(
  trackedLogs: Map<string, ActiveTrackedToolUseLog>,
  itemId: string,
  toolLog: ToolUseLog,
  logger: AgentLogger,
): void {
  const trackedLog = trackedLogs.get(itemId);
  if (trackedLog) {
    trackedLog.latestToolLog = toolLog;
    updateTrackedToolUseLog(logger, trackedLog, toolLog);
  } else {
    trackedLogs.set(itemId, {
      ...logger.emitToolUse(toolLog),
      latestToolLog: toolLog,
    });
  }

  if (toolLog.status !== 'in_progress') {
    trackedLogs.delete(itemId);
  }
}

function finalizeTrackedCodexItemLog(
  toolLog: ToolUseLog,
  errorMessage: string,
): ToolUseLog {
  const output =
    toolLog.toolName?.startsWith('mcp:') &&
    toolLog.output != null &&
    typeof toolLog.output === 'object' &&
    !Array.isArray(toolLog.output)
      ? {
          ...(toolLog.output as Record<string, unknown>),
          status: 'failed',
        }
      : toolLog.output;

  return {
    ...toolLog,
    ...(output !== undefined && { output }),
    ...(toolLog.error ? {} : { error: errorMessage }),
    isError: true,
    status: 'completed',
  };
}

function finalizeTrackedCodexItemLogs(
  trackedLogs: Map<string, ActiveTrackedToolUseLog>,
  logger: AgentLogger,
  errorMessage: string,
): void {
  for (const [itemId, trackedLog] of trackedLogs) {
    updateTrackedToolUseLog(
      logger,
      trackedLog,
      finalizeTrackedCodexItemLog(trackedLog.latestToolLog, errorMessage),
    );
    trackedLogs.delete(itemId);
  }
}

function handleTrackedCodexItemEvent(
  item: Extract<
    ThreadItem,
    | { type: 'command_execution' }
    | { type: 'mcp_tool_call' }
    | { type: 'todo_list' }
  >,
  phase: 'started' | 'updated' | 'completed',
  childStreamId: StreamTabId,
  logger: AgentLogger,
  trackedLogs: Map<string, ActiveTrackedToolUseLog>,
): void {
  if (item.type === 'todo_list') {
    syncCodexTodoState(item, childStreamId);
  }

  const toolLog =
    item.type === 'command_execution'
      ? buildCodexCommandToolLog(item)
      : item.type === 'mcp_tool_call'
        ? buildCodexMcpToolLog(item)
        : buildCodexTodoToolLog(
            item,
            phase === 'completed' ? 'completed' : 'in_progress',
          );

  upsertTrackedToolUseLog(trackedLogs, item.id, toolLog, logger);
}

/** Log a completed codex thread item that does not participate in live updates. */
function logCompletedCodexItem(
  item: Exclude<
    ThreadItem,
    | { type: 'command_execution' }
    | { type: 'mcp_tool_call' }
    | { type: 'todo_list' }
  >,
  logger: AgentLogger,
): void {
  switch (item.type) {
    case 'file_change': {
      const fileChangeLog = buildCodexFileChangeToolLog(item);
      if (fileChangeLog) {
        logger.logToolUse(fileChangeLog);
      }
      break;
    }
    case 'agent_message':
      logger.info(item.text, { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
      break;
    case 'reasoning':
      logger.info(item.text, { messageType: MESSAGE_TYPES.THINKING });
      break;
    case 'web_search':
      logger.logWebSearch({ query: item.query });
      break;
    case 'error':
      logger.error(item.message);
      break;
  }
}

/** Finalize a codex child stream (mark completed/error). */
function finalizeCodexStream(
  childStreamId: StreamTabId,
  executionId: string,
  logger: AgentLogger,
  options?: {
    error?: unknown;
  },
): void {
  if (options?.error) {
    logger.error(toErrorMessage(options.error));
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
  executionId: string,
  logger: AgentLogger,
): void {
  const session = new CodexFollowUpSession();
  const queue = ToolUseFollowUpQueue.acquire(childStreamId);
  session.setQueue(queue);
  registerInterruptible(childStreamId, session);

  // Start a log group so endRunningGroups() marks it as errored on reload,
  // giving the user a visual cue that the session was interrupted.
  const groupId = logger.startGroup('Codex session');

  StreamStatusService.set(childStreamId, STREAM_STATUS.WAITING);

  void (async () => {
    try {
      while (!session.isInterrupted()) {
        const messages = await queue.waitAndDrainAll(() =>
          session.isInterrupted(),
        );
        if (!messages || session.isInterrupted()) break;

        const userMessage = messages.join('\n\n');

        StreamStatusService.set(childStreamId, STREAM_STATUS.RUNNING);

        try {
          await runStreamedTurn(
            thread,
            userMessage,
            childStreamId,
            logger,
            executionId,
          );
        } catch (err) {
          logger.error(toErrorMessage(err));
        }

        // Don't override STOPPED — the user pressed the stop button
        if (!session.isInterrupted()) {
          StreamStatusService.set(childStreamId, STREAM_STATUS.WAITING);
        }
      }
    } finally {
      logger.endGroup(groupId, 'stopped');
      unregisterInterruptible(childStreamId);
      ToolUseFollowUpQueue.release(childStreamId);
      // Persist terminal status before untracking — untrackExecution fires
      // notifyWaiters, so consumers must see the final status on disk.
      await writeTerminalStatus(executionId, 'completed').catch(() => {});
      untrackExecution(executionId);

      const threadId = thread.id;
      if (threadId) threadRegistry.delete(threadId);

      if (StreamStatusService.get(childStreamId) === STREAM_STATUS.WAITING) {
        StreamStatusService.set(childStreamId, STREAM_STATUS.READY);
      }
    }
  })();
}

/**
 * After a successful turn, either start a follow-up loop (if the SDK
 * assigned a thread ID) or finalize the stream.
 */
function handleTurnSuccess(
  thread: Thread,
  childStreamId: StreamTabId,
  executionId: ExecutionId,
  logger: AgentLogger,
): void {
  const threadId = thread.id;
  if (threadId) {
    storeThread(threadId, { thread, childStreamId, logger, executionId });
    startFollowUpLoop(thread, childStreamId, executionId, logger);
  } else {
    finalizeCodexStream(childStreamId, executionId, logger);
  }
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
  executionId: ExecutionId,
): Promise<RunResult> {
  logger.info(prompt, { messageType: MESSAGE_TYPES.USER_MESSAGE });
  const { events } = await thread.runStreamed(prompt);
  const responseParts: string[] = [];
  let usage: RunResult['usage'] = null;
  const trackedLogs = new Map<string, ActiveTrackedToolUseLog>();
  let activeTurnLog: ActiveCodexTurnLog | null = null;
  const usageReporter = new AgentUsageReporter(
    logger,
    childStreamId,
    AgentCategory.ToolUse,
  );

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'thread.started':
          logger.logToolUse(buildCodexThreadToolLog(event));
          break;
        case 'turn.started':
          activeTurnLog = {
            ...logger.emitToolUse(buildCodexTurnToolLog({ state: 'running' })),
            startedAt: Date.now(),
          };
          break;
        case 'item.started':
        case 'item.updated':
          if (
            event.item.type === 'command_execution' ||
            event.item.type === 'mcp_tool_call' ||
            event.item.type === 'todo_list'
          ) {
            handleTrackedCodexItemEvent(
              event.item,
              event.type === 'item.started' ? 'started' : 'updated',
              childStreamId,
              logger,
              trackedLogs,
            );
          }
          break;
        case 'item.completed': {
          const { item } = event;
          if (
            item.type === 'command_execution' ||
            item.type === 'mcp_tool_call' ||
            item.type === 'todo_list'
          ) {
            handleTrackedCodexItemEvent(
              item,
              'completed',
              childStreamId,
              logger,
              trackedLogs,
            );
          } else {
            logCompletedCodexItem(item, logger);
          }
          if (item.type === 'agent_message') {
            responseParts.push(item.text);
          }
          break;
        }
        case 'turn.completed':
          usage = event.usage ?? null;
          if (usage) {
            usageReporter.report(
              buildCodexUsageStats(usage),
              executionId as StorageKey,
            );
          }
          if (activeTurnLog) {
            updateTrackedToolUseLog(
              logger,
              activeTurnLog,
              buildCodexTurnToolLog({
                state: 'completed',
                wallTimeMs: Date.now() - activeTurnLog.startedAt,
              }),
            );
            activeTurnLog = null;
          } else {
            logger.logToolUse(
              buildCodexTurnToolLog({
                state: 'completed',
              }),
            );
          }
          break;
        case 'turn.failed':
          throw new ToolError(event.error.message ?? 'Codex turn failed');
        case 'error':
          throw new ToolError(event.message ?? 'Codex stream error');
      }
    }
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    if (activeTurnLog) {
      updateTrackedToolUseLog(
        logger,
        activeTurnLog,
        buildCodexTurnToolLog({
          state: 'failed',
          wallTimeMs: Date.now() - activeTurnLog.startedAt,
          error: errorMessage,
        }),
      );
      activeTurnLog = null;
    }
    finalizeTrackedCodexItemLogs(trackedLogs, logger, errorMessage);
    throw error;
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
    'Set working_directory to a workspace subdirectory or an absolute path, including a separate git worktree; an orchestrator can prepare that worktree first when isolated changes help. ' +
    'Requires the Codex CLI to be installed (`npm install -g @openai/codex`). ' +
    'Auth is handled by the CLI itself — use `codex login` (OAuth, recommended) or set OPENAI_API_KEY env var. ' +
    'Returns a thread_id that can be passed back to continue the conversation in subsequent calls.',
  schema: CodexInputSchema,
}) {
  protected async execute(input: CodexInput): Promise<ToolResult> {
    // Apply user-configured default sandbox mode
    const sandboxMode = input.sandbox_mode ?? getCodexSandboxMode();

    // Request approval — same pattern as BashTool
    const approvalLabel = `[codex ${sandboxMode}] ${input.prompt}`;
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
    if (input.thread_id) {
      const stored = threadRegistry.get(input.thread_id);
      if (stored) {
        // Always interrupt the old follow-up loop. If it's WAITING, the
        // interrupt is clean. If RUNNING, the in-progress turn will error
        // out — but this prevents orphaned loops and concurrent turns on
        // the same Thread object.
        getInterruptible(stored.childStreamId)?.interrupt();
        threadRegistry.delete(input.thread_id);
        return stored.thread;
      }
    }

    const CodexClass = await importCodexClass();
    const codex = new CodexClass({ codexPathOverride: findCodexBinaryPath() });
    const workspaceOptions =
      input.thread_id && input.working_directory == null
        ? {}
        : buildCodexWorkspaceOptions(input.working_directory);
    const threadOptions = {
      model: 'gpt-5.4',
      modelReasoningEffort: 'high' as const,
      sandboxMode: input.sandbox_mode ?? getCodexSandboxMode(),
      skipGitRepoCheck: true as const,
      ...workspaceOptions,
    };

    return input.thread_id
      ? codex.resumeThread(input.thread_id, threadOptions)
      : codex.startThread(threadOptions);
  }

  private async executeForeground(
    thread: Thread,
    input: CodexInput,
    parentStreamId?: StreamTabId,
  ): Promise<ToolResult> {
    const executionId = generateExecutionId();
    const preview = truncateWithEllipsis(input.prompt, 60);
    const config = buildCodexConfig(input.prompt);

    if (parentStreamId) {
      await ensureRunDir(executionId);
      const parentExecutionId =
        getCurrentToolFileInteractionContext()?.executionId;
      await registerExecution(
        executionId,
        config,
        CODEX_AGENT_NAME,
        parentExecutionId,
      ).catch(() => {});
    }

    const stream = parentStreamId
      ? createCodexStream(executionId, parentStreamId, input.prompt, config)
      : undefined;

    try {
      const turn = stream
        ? await runStreamedTurn(
            thread,
            input.prompt,
            stream.childStreamId,
            stream.logger,
            executionId,
          )
        : await thread.run(input.prompt);

      const threadId = thread.id;

      if (stream) {
        handleTurnSuccess(
          thread,
          stream.childStreamId,
          executionId,
          stream.logger,
        );
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
    const config = buildCodexConfig(input.prompt);

    try {
      await registerExecution(
        executionId,
        config,
        CODEX_AGENT_NAME,
        parentExecutionId,
      );
    } catch {
      throw new ToolError('Failed to register background Codex execution.');
    }

    const { childStreamId, logger } = createCodexStream(
      executionId,
      parentStreamId,
      input.prompt,
      config,
    );

    const startedAt = Date.now();

    void (async () => {
      try {
        const turn = await runStreamedTurn(
          thread,
          input.prompt,
          childStreamId,
          logger,
          executionId,
        );
        const wallTimeMs = Date.now() - startedAt;
        const threadId = thread.id;
        const store = getExecutionStore(executionId);

        const msg = formatCodexDelivery(
          executionId,
          input.prompt,
          wallTimeMs,
          turn,
          threadId,
        );
        await store.writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);

        // Write terminal status before handleTurnSuccess, which may call
        // finalizeCodexStream → untrackExecution → notifyWaiters.
        // When a follow-up loop starts, the loop's finally writes its own status.
        if (!threadId) {
          await writeTerminalStatus(executionId, 'completed').catch(() => {});
        }
        handleTurnSuccess(thread, childStreamId, executionId, logger);
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
        `Codex agent launched in background (${input.sandbox_mode ?? getCodexSandboxMode()}).`,
        `Execution ID: ${executionId}`,
        `Stream tab: ${childStreamId}`,
        'Result will be delivered as a follow-up message when complete.',
      ].join('\n'),
    };
  }
}
