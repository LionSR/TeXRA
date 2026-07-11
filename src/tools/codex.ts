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
import {
  emitToolUseCard,
  endToolUseCard,
  logWebSearch,
  type AgentTrace,
  type ToolUseCardRef,
} from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import {
  getRunContextExecutionId,
  getRunContextStreamId,
  getRunContextWorkingDirectory,
} from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  startChildRunLoop,
  type ChildRunPorts,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import type {
  StreamTabId,
  ExecutionId,
  TodoItem,
  ToolUseLog,
} from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { MESSAGE_TYPES } from '@shared/schemas';
import { CodexSandboxModeSchema } from '@shared/schemas/agentCliSettings';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { requireRunStream } from '@tools/contextHelpers';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { formatWallTimeSeconds } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { buildAgentWorkspaceOptions } from './agentWorkspaceOptions';
import { importCodexClass, findCodexBinaryPath } from './codexImport';
import { type ChildStream } from './childStream';
import { CodexThreads } from './agentCliSessionStores';
import {
  publishAgentCliStreamUsage,
  launchAgentCliSession,
  resumeOrLaunchAgentCliSession,
  withAgentCliApproval,
} from './agentCliShared';
import {
  formatChildRunDelivery,
  formatChildRunError,
} from './deliveryEnvelope';
import {
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
  buildCodexMcpToolLog,
  buildCodexTodoToolLog,
  buildCodexUsageStats,
} from './codexShared';

// Type-only imports (kept separate for bundler efficiency)
import type {
  RunResult,
  Thread,
  ThreadItem,
  ThreadOptions,
  TodoListItem,
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
  return formatChildRunDelivery(
    {
      tag: DELIVERY_TAG.codexResult,
      executionId,
      prompt,
      attributes: [{ name: 'thread-id', value: threadId || null }],
    },
    {
      wallTime: formatWallTimeSeconds(wallTimeMs),
      response: turn.finalResponse,
      usage: turn.usage
        ? { input: turn.usage.input_tokens, output: turn.usage.output_tokens }
        : null,
    },
  );
}

// ============================================================================
// Stream tab helpers
// ============================================================================

type CodexToolLogRef = ToolUseCardRef;
type ToolUseStatus = NonNullable<ToolUseLog['status']>;

export function publishCodexTodos(
  childStreamId: StreamTabId,
  todos: TodoItem[],
  logger: AgentTrace,
): void {
  emitRunFact(logger, 'updateTodos', { streamId: childStreamId, todos });
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
      emitToolUseCard(logger, buildCodexMcpToolLog(item));
      break;
    }
    case 'web_search':
      logWebSearch(logger, { query: item.query });
      break;
    case 'todo_list': {
      publishCodexTodos(childStreamId, toProgressTodos(item), logger);
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
      return buildCodexMcpToolLog(item);
    case 'todo_list':
      return buildCodexTodoToolLog(item, status);
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
}): boolean {
  const { item, status, childStreamId, logger, refs } = params;

  if (item.type === 'todo_list') {
    publishCodexTodos(childStreamId, toProgressTodos(item), logger);
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
        });
        if (!wasRenderedAsProgress) {
          logCodexItem(item, childStreamId, logger);
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
  /**
   * The disk-based fallback thread id claimed synchronously in execute(). The
   * loop promotes that reservation before its first turn starts.
   */
  resumeThreadId: string | undefined;
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
  const fallbackThreadId = params.resumeThreadId;

  // Fresh threads don't have thread.id yet; they're registered after the first
  // turn completes. A resumed thread's pre-launch claim is promoted up front.
  const registerThread = (threadId: string, session: SessionHandle): void => {
    if (CodexThreads.lookup(threadId)) return;
    CodexThreads.register(threadId, {
      thread,
      childStreamId,
      parentStreamId,
      executionId,
      executions: session.executions,
    });
  };

  // The joined prompt text for whichever turn is currently in flight —
  // captured here (rather than threaded through the loop contract) since
  // `formatDelivery`/`formatError` run strictly after the turn that set it.
  let lastPrompt = initialPrompt;
  const runTurn = (
    followUps: readonly FollowUpQueueBatchItem[],
    _ports: ChildRunPorts,
    abortController: AbortController,
  ): Promise<RunResult> => {
    lastPrompt = followUps.map((f) => f.text).join('\n\n');
    return runStreamedTurn(
      thread,
      lastPrompt,
      childStreamId,
      logger,
      abortController.signal,
    );
  };

  const strategy: ChildRunStrategy<RunResult> = {
    stageLabel: 'Codex session',
    onSessionStart: fallbackThreadId
      ? (session) => registerThread(fallbackThreadId, session)
      : undefined,
    launch: (ports, abortController) =>
      runTurn(
        [{ text: initialPrompt, origin: 'user' }],
        ports,
        abortController,
      ),
    runTurn,
    isTerminal: () => false,
    getUsage: (turn) => turn.usage,
    onTurnSuccess: (_turn, session) => {
      if (thread.id) registerThread(thread.id, session);
    },
    publishUsage: (turn) => {
      if (turn.usage) {
        publishAgentCliStreamUsage(
          childStreamId,
          executionId,
          buildCodexUsageStats(turn.usage),
          logger,
        );
      }
    },
    formatDelivery: (turn, wallTimeMs) =>
      formatCodexDelivery(executionId, lastPrompt, wallTimeMs, turn, thread.id),
    formatError: (_turn, err) =>
      formatChildRunError(
        { tag: DELIVERY_TAG.codexError, executionId, prompt: lastPrompt },
        { message: toErrorMessage(err) },
      ),
    onSessionCleanup: () => CodexThreads.releaseByExecutionId(executionId),
  };

  startChildRunLoop({
    childStream,
    childStreamId,
    parentStreamId,
    executionId,
    agentName: 'codex',
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

    return withAgentCliApproval(
      `[codex ${input.sandbox_mode}] ${input.prompt}`,
      (runContext) => {
        return resumeOrLaunchAgentCliSession(CodexThreads, {
          id: input.thread_id ?? undefined,
          prompt: input.prompt,
          callerStreamId: getRunContextStreamId(runContext),
          labels: {
            notActiveLabel: 'Codex thread',
            idParamName: 'thread_id',
            summaryLabel: 'Codex',
            queuedLabel: 'Codex thread',
          },
          launch: () => {
            // A missing in-memory entry denotes a disk-based SDK fallback.
            const { streamId, runtimeHost } = requireRunStream(
              'codex',
              runContext,
            );
            return launchCodexSession(
              input,
              streamId,
              getRunContextExecutionId(runContext),
              getRunContextWorkingDirectory(runContext),
              runtimeHost,
            );
          },
        });
      },
    );
  }
}

async function launchCodexSession(
  input: CodexInput,
  parentStreamId: StreamTabId,
  parentExecutionId: ExecutionId | undefined,
  parentWorkingDirectory: string | undefined,
  runtimeHost: AgentRuntimeHost,
): Promise<ToolResult> {
  const workingDir = parseWorkingDirectory(parentWorkingDirectory);
  const thread = await createCodexThread(input, workingDir);
  const config = (await getCodexConfig()).buildCodexConfig(input.prompt);
  const preview = truncateWithEllipsis(input.prompt, 60);

  return launchAgentCliSession({
    parentStreamId,
    parentExecutionId,
    runtimeHost,
    agentName: 'codex',
    streamPrefix: 'codex@codex-sdk',
    description: input.prompt,
    config,
    registerFailedMessage: 'Failed to register Codex execution.',
    startLoop: ({ childStream, executionId }) =>
      startCodexLoop({
        thread,
        childStream,
        parentStreamId,
        executionId,
        initialPrompt: input.prompt,
        runtimeHost,
        resumeThreadId: input.thread_id ?? undefined,
      }),
    summary: `Launched Codex: ${preview}`,
    launchedLine: `Codex agent launched (sandbox: ${input.sandbox_mode}).`,
    followUpLine: `Result will be delivered as a follow-up message when the turn completes. The delivery includes the thread_id — pass it to codex on a later call to send a follow-up instruction.`,
  });
}
