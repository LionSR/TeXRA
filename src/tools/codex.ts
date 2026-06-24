/**
 * Codex tool — spin off an OpenAI Codex agent via the @openai/codex-sdk.
 *
 * Mirrors the `delegate_agent` model: every call is async. Without a
 * thread_id, a new Codex session is launched and the result is delivered
 * as a follow-up to the parent stream. With a thread_id, the prompt is
 * enqueued as a follow-up instruction to an existing session. If a turn is
 * still processing, the prompt waits in that session's queue.
 * Each turn's result is delivered back to the parent via the follow-up
 * queue, so the orchestrator sees responses uniformly whether it or the
 * user drove the turn.
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
import { registerExecution } from '@agent/storage';
import {
  emitToolUseCard,
  endToolUseCard,
  logWebSearch,
  type AgentTrace,
  type ToolUseCardRef,
} from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { getCurrentToolContexts } from '@agent/toolUse/ToolFileInteractionContext';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type {
  StreamTabId,
  ExecutionId,
  TodoItem,
  ToolUseLog,
} from '@shared/schemas';
import { MESSAGE_TYPES } from '@shared/schemas';
import { CodexSandboxModeSchema } from '@shared/schemas/agentCliSettings';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { parseWorkingDirectory } from '@tools/pathResolution';
import {
  requestBashApproval,
  buildBashApprovalRejectedResult,
} from '@tools/approval/bashApproval';
import { generateExecutionId } from '@utils/core/executionId';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { buildAgentWorkspaceOptions } from './agentWorkspaceOptions';
import { importCodexClass, findCodexBinaryPath } from './codexImport';
import { createChildStream, type ChildStream } from './childStream';
import { codexThreads } from './agentCliSessionStores';
import {
  publishAgentCliStreamUsage,
  formatAgentCliDelivery,
  formatAgentCliError,
} from './agentCliShared';
import {
  runAgentCliSession,
  type AgentCliSessionStrategy,
} from './agentCliSessionLoop';
import {
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
  buildCodexMcpToolLog,
  buildCodexTodoToolLog,
  buildCodexUsageStats,
} from './codexShared';

// Type-only imports (kept separate for bundler efficiency)
import type {
  McpToolCallItem,
  RunResult,
  Thread,
  ThreadItem,
  ThreadOptions,
  TodoListItem,
  WebSearchItem,
} from '@openai/codex-sdk';

// ============================================================================
// Codex config
// ============================================================================

// The sandbox-mode schema is imported eagerly from `@shared` (a light,
// dependency-free leaf) since it is used at module level by the input schema.
// All other config (model, reasoning, buildCodexConfig, sandbox getter) is
// lazy-imported from codexConfig.ts at runtime to avoid pulling the heavy
// platform/SDK graph into the tool-registration path.

/** Lazy accessor for codexConfig.ts exports (loaded once, cached). */
let _configModule: typeof import('./codexConfig') | null = null;
async function getCodexConfig(): Promise<typeof import('./codexConfig')> {
  return (_configModule ??= await import('./codexConfig'));
}

// ============================================================================
// Schema
// ============================================================================

const CodexInputSchema = z.strictObject({
  prompt: z
    .string()
    .describe(
      'Instruction for the Codex agent. For a new session, describe the task. For a resume (thread_id set), describe the follow-up.',
    ),
  sandbox_mode: CodexSandboxModeSchema.nullish().describe(
    'File access level for the Codex agent (defaults to user-configured mode, typically workspace-write)',
  ),
  thread_id: z
    .string()
    .nullish()
    .describe(
      'Resume an existing Codex thread with a follow-up instruction. The prompt is enqueued as the next turn; if the thread is currently processing, the prompt waits in its queue.',
    ),
});

export type CodexInput = z.infer<typeof CodexInputSchema>;

// ============================================================================
// Result formatting
// ============================================================================

/** Format a Codex result for delivery as XML on the parent's follow-up queue. */
function formatCodexDelivery(
  executionId: string,
  prompt: string,
  wallTimeMs: number,
  turn: RunResult,
  threadId?: string | null,
): string {
  return formatAgentCliDelivery({
    tag: 'codex-result',
    executionId,
    prompt,
    wallTimeMs,
    response: turn.finalResponse,
    idAttr: { name: 'thread-id', value: threadId },
    usage: turn.usage
      ? { input: turn.usage.input_tokens, output: turn.usage.output_tokens }
      : null,
  });
}

/** Format a Codex error for delivery on the parent's follow-up queue. */
function formatCodexError(
  executionId: string,
  prompt: string,
  err: unknown,
): string {
  return formatAgentCliError('codex-error', executionId, prompt, err);
}

// ============================================================================
// Stream tab helpers
// ============================================================================

type CodexToolLogRef = ToolUseCardRef;
type ToolUseStatus = NonNullable<ToolUseLog['status']>;

export function publishCodexTodos(
  childStreamId: StreamTabId,
  todos: TodoItem[],
  runtimeHost: AgentRuntimeHost,
): void {
  runtimeHost.emit('updateTodos', { streamId: childStreamId, todos });
}

function toProgressTodos(item: TodoListItem): TodoItem[] {
  return item.items.map((t) => ({
    content: t.text,
    status: t.completed ? ('completed' as const) : ('pending' as const),
    activeForm: t.text,
  }));
}

/** Log a completed codex thread item to the child stream's logger. */
function logCodexItem(
  item: ThreadItem,
  childStreamId: StreamTabId,
  logger: AgentTrace,
  runtimeHost: AgentRuntimeHost,
): void {
  switch (item.type) {
    case 'command_execution': {
      emitToolUseCard(logger, buildCodexCommandToolLog(item));
      break;
    }
    case 'file_change': {
      const fileLog = buildCodexFileChangeToolLog(item);
      if (fileLog) emitToolUseCard(logger, fileLog);
      break;
    }
    case 'agent_message':
      logger.info(item.text, { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
      break;
    case 'reasoning':
      logger.info(item.text, { messageType: MESSAGE_TYPES.THINKING });
      break;
    case 'mcp_tool_call': {
      emitToolUseCard(logger, buildCodexMcpToolLog(item as McpToolCallItem));
      break;
    }
    case 'web_search':
      logWebSearch(logger, { query: (item as WebSearchItem).query });
      break;
    case 'todo_list': {
      publishCodexTodos(
        childStreamId,
        toProgressTodos(item as TodoListItem),
        runtimeHost,
      );
      break;
    }
    case 'error':
      logger.error(item.message);
      break;
  }
}

function buildCodexLiveToolLog(
  item: ThreadItem,
  status: ToolUseStatus,
): ToolUseLog | null {
  switch (item.type) {
    case 'command_execution':
      return buildCodexCommandToolLog(item);
    case 'file_change': {
      const fileLog = buildCodexFileChangeToolLog(item);
      return fileLog ? { ...fileLog, status } : null;
    }
    case 'mcp_tool_call':
      return buildCodexMcpToolLog(item as McpToolCallItem);
    case 'todo_list':
      return buildCodexTodoToolLog(item as TodoListItem, status);
    default:
      return null;
  }
}

function updateCodexLiveToolLog(
  logger: AgentTrace,
  refs: Map<string, CodexToolLogRef>,
  item: ThreadItem,
  toolLog: ToolUseLog,
): void {
  const existing = refs.get(item.id);
  if (!existing) {
    refs.set(item.id, emitToolUseCard(logger, toolLog));
    return;
  }

  const { status = 'completed', ...rest } = toolLog;
  endToolUseCard(logger, existing, rest, status);
}

function publishCodexItemProgress(params: {
  item: ThreadItem;
  status: ToolUseStatus;
  childStreamId: StreamTabId;
  logger: AgentTrace;
  refs: Map<string, CodexToolLogRef>;
  runtimeHost: AgentRuntimeHost;
}): boolean {
  const { item, status, childStreamId, logger, refs, runtimeHost } = params;

  if (item.type === 'todo_list') {
    publishCodexTodos(
      childStreamId,
      toProgressTodos(item as TodoListItem),
      runtimeHost,
    );
  }

  const toolLog = buildCodexLiveToolLog(item, status);
  if (!toolLog) return false;

  updateCodexLiveToolLog(logger, refs, item, toolLog);
  return true;
}

// ============================================================================
// Streaming helpers
// ============================================================================

/** Run a single streamed turn, logging events to the child stream. */
export async function runStreamedTurn(
  thread: Thread,
  prompt: string,
  childStreamId: StreamTabId,
  logger: AgentTrace,
  runtimeHost: AgentRuntimeHost,
  signal?: AbortSignal,
): Promise<RunResult> {
  logger.info(prompt, { messageType: MESSAGE_TYPES.USER_MESSAGE });
  const { events } = await thread.runStreamed(prompt, { signal });
  const responseParts: string[] = [];
  let usage: RunResult['usage'] = null;
  const itemLogRefs = new Map<string, CodexToolLogRef>();

  for await (const event of events) {
    switch (event.type) {
      case 'item.started':
      case 'item.updated':
        publishCodexItemProgress({
          item: event.item,
          status: 'in_progress',
          childStreamId,
          logger,
          refs: itemLogRefs,
          runtimeHost,
        });
        break;
      case 'item.completed': {
        const { item } = event;
        const wasRenderedAsProgress = publishCodexItemProgress({
          item,
          status: 'completed',
          childStreamId,
          logger,
          refs: itemLogRefs,
          runtimeHost,
        });
        if (!wasRenderedAsProgress) {
          logCodexItem(item, childStreamId, logger, runtimeHost);
        }
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
// Codex session loop — one turn per enqueued prompt, delivers to parent
// ============================================================================

/**
 * Run the Codex session loop. The shared loop runner processes prompts from the
 * child's follow-up queue one at a time and delivers each turn's result to the
 * parent's follow-up queue; this strategy supplies the Codex-specific turn
 * execution, registry bookkeeping, and result formatting.
 */
function startCodexLoop(params: {
  thread: Thread;
  childStream: ChildStream;
  parentStreamId: StreamTabId;
  executionId: ExecutionId;
  initialPrompt: string;
  runtimeHost: AgentRuntimeHost;
}): void {
  const {
    thread,
    childStream,
    parentStreamId,
    executionId,
    initialPrompt,
    runtimeHost,
  } = params;
  const { childStreamId, logger } = childStream;

  // Fresh threads don't have thread.id yet; they're registered after the first
  // turn completes. Resumed threads are registered up front (onSessionStart) so
  // a second codex call with the same thread_id during the first turn can't
  // bypass the in-memory guard and start a concurrent loop.
  const registerThread = (session: SessionHandle): void => {
    const threadId = thread.id;
    if (threadId && !codexThreads.isActive(threadId)) {
      codexThreads.register(threadId, {
        thread,
        childStreamId,
        parentStreamId,
        executionId,
        interrupts: session.interrupts,
      });
    }
  };

  const strategy: AgentCliSessionStrategy<RunResult> = {
    stageLabel: 'Codex session',
    onSessionStart: registerThread,
    runTurn: (prompt, abortController) =>
      runStreamedTurn(
        thread,
        prompt,
        childStreamId,
        logger,
        runtimeHost,
        abortController.signal,
      ),
    getUsage: (turn) => turn.usage,
    onTurnSuccess: (_turn, session) => registerThread(session),
    publishUsage: (turn) => {
      if (turn.usage) {
        publishAgentCliStreamUsage(
          childStreamId,
          executionId,
          buildCodexUsageStats(turn.usage),
          runtimeHost,
        );
      }
    },
    formatDelivery: (turn, prompt, wallTimeMs) =>
      formatCodexDelivery(executionId, prompt, wallTimeMs, turn, thread.id),
    formatError: (_turn, prompt, err) =>
      formatCodexError(executionId, prompt, err),
    onSessionCleanup: () => {
      const threadId = thread.id;
      if (threadId) codexThreads.release(threadId);
    },
  };

  runAgentCliSession({
    childStream,
    parentStreamId,
    executionId,
    initialPrompt,
    strategy,
  });
}

// ============================================================================
// Thread creation
// ============================================================================

async function createCodexThread(
  input: CodexInput,
  workingDir?: string,
): Promise<Thread> {
  const CodexClass = await importCodexClass();
  const codex = new CodexClass({
    codexPathOverride: await findCodexBinaryPath(),
  });
  const config = await getCodexConfig();
  const sandboxMode = input.sandbox_mode ?? undefined;
  // Resumed threads keep their stored workspace unless explicitly overridden.
  const workspace =
    workingDir || !input.thread_id
      ? buildAgentWorkspaceOptions(workingDir)
      : {};
  const threadOptions: ThreadOptions = {
    ...workspace,
    sandboxMode,
    approvalPolicy: config.getCodexApprovalPolicy(),
    model: config.CODEX_CLI_MODEL,
    modelReasoningEffort: config.getCodexCliReasoningEffort(),
    skipGitRepoCheck: true as const,
  };
  return input.thread_id
    ? codex.resumeThread(input.thread_id, threadOptions)
    : codex.startThread(threadOptions);
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
    'Always async: returns immediately with an execution ID; each turn is delivered back as a follow-up message (including the thread_id). ' +
    'Pass thread_id on a later call to send a follow-up instruction to an existing session — mirrors delegate_agent(execution_id=…).',
  schema: CodexInputSchema,
}) {
  protected async execute(input: CodexInput): Promise<ToolResult> {
    if (!input.sandbox_mode) {
      const config = await getCodexConfig();
      input.sandbox_mode = config.getCodexSandboxMode();
    }

    const approvalLabel = `[codex ${input.sandbox_mode}] ${input.prompt}`;
    const approval = await requestBashApproval({ command: approvalLabel });
    if (!approval.accepted) {
      return buildBashApprovalRejectedResult(
        approvalLabel,
        approval.userMessage,
      );
    }

    const contexts = getCurrentToolContexts();
    const callContext = contexts?.callContext;
    const runContext = contexts?.runContext;
    callContext?.onExecutionReady?.();

    if (input.thread_id && codexThreads.isActive(input.thread_id)) {
      return resumeCodexThread(
        input.thread_id,
        input.prompt,
        runContext?.streamId,
      );
    }
    // Fall through when the thread's in-memory loop is gone (extension
    // reload, crash): createCodexThread resumes via the SDK from disk.
    return launchCodexSession(
      input,
      runContext?.streamId,
      runContext?.executionId,
      runContext?.workingDirectory,
      runContext?.runtimeHost,
    );
  }
}

async function launchCodexSession(
  input: CodexInput,
  parentStreamId: StreamTabId | undefined,
  parentExecutionId: ExecutionId | undefined,
  parentWorkingDirectory: string | undefined,
  runtimeHost: AgentRuntimeHost | undefined,
): Promise<ToolResult> {
  if (!parentStreamId || !runtimeHost) {
    throw new ToolError(
      'Codex requires a parent stream runtime context — it must be called from an active tool-use agent.',
    );
  }

  const workingDir = parseWorkingDirectory(parentWorkingDirectory);
  const thread = await createCodexThread(input, workingDir);

  const executionId = generateExecutionId();
  await ensureRunDir(executionId);

  const codexConfig = await getCodexConfig();
  const config = codexConfig.buildCodexConfig(input.prompt);

  try {
    await registerExecution(executionId, config, 'codex', parentExecutionId);
  } catch {
    throw new ToolError('Failed to register Codex execution.');
  }

  const childStream = createChildStream(executionId, parentStreamId, {
    streamPrefix: 'codex@codex-sdk',
    streamCategory: AgentCategory.ToolUse,
    agentName: 'codex',
    description: input.prompt,
    config,
    toolName: 'codex',
    runtimeHost,
  });

  startCodexLoop({
    thread,
    childStream,
    parentStreamId,
    executionId,
    initialPrompt: input.prompt,
    runtimeHost,
  });

  const { childStreamId } = childStream;
  const preview = truncateWithEllipsis(input.prompt, 60);
  return {
    summary: `Launched Codex: ${preview}`,
    output: [
      `Codex agent launched (sandbox: ${input.sandbox_mode}).`,
      `Execution ID: ${executionId}`,
      `Stream tab: ${childStreamId}`,
      `Result will be delivered as a follow-up message when the turn completes. The delivery includes the thread_id — pass it to codex on a later call to send a follow-up instruction.`,
    ].join('\n'),
  };
}

function resumeCodexThread(
  threadId: string,
  prompt: string,
  callerStreamId: StreamTabId | undefined,
): ToolResult {
  const stored = codexThreads.lookup(threadId);
  if (!stored) {
    throw new ToolError(
      `Codex thread '${threadId}' is not active. It may have completed or been stopped; start a new session without thread_id.`,
    );
  }

  // The turn result is delivered to the stored parent stream, so refuse
  // callers from a different stream — otherwise the sender reports "sent"
  // while the response lands on someone else's orchestrator.
  if (callerStreamId && stored.parentStreamId !== callerStreamId) {
    throw new ToolError(
      `Codex thread '${threadId}' is owned by a different session; start a new session without thread_id to run in this context.`,
    );
  }

  const queue = ToolUseFollowUpQueue.acquire(stored.childStreamId);
  queue.enqueue({ text: prompt });

  const preview = truncateWithEllipsis(prompt, 60);
  return {
    summary: `Follow-up queued for Codex: ${preview}`,
    output: [
      `Follow-up instruction queued for Codex thread '${threadId}'. The agent will process it and deliver a new result automatically.`,
      `Execution ID: ${stored.executionId}`,
    ].join('\n'),
  };
}
