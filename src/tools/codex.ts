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
import { emitRunFact } from '@agent/runtime/runFactEvents';
import type {
  ExecutionId,
  StreamTabId,
  TodoItem,
  ToolResult,
  ToolUseLog,
  ToolUseStatus,
} from '@shared/schemas';
import {
  CodexSandboxModeSchema,
  MESSAGE_TYPES,
  ToolError,
} from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { formatWallTimeSeconds } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { defineTool } from './core/define';
import { buildAgentWorkspaceOptions } from './agentWorkspaceOptions';
import { importCodexClass, findCodexBinaryPath } from './codexImport';
import { type ChildStream } from './delegation/childStream';
import { CodexThreads } from './agentCliSessionStores';
import {
  dispatchAgentCliTool,
  launchAgentCliSession,
  startAgentCliLoop,
} from './agentCliShared';
import {
  formatChildRunDelivery,
  formatChildRunError,
} from './delegation/deliveryEnvelope';
import {
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
  buildCodexMcpToolLog,
  buildCodexThreadToolLog,
  buildCodexTodoToolLog,
  buildCodexTurnToolLog,
  buildCodexUsageStats,
} from './codexShared';

// Third-party imports
import type {
  RunResult,
  SandboxMode,
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
let _configModule: typeof import('./codexConfig.js') | null = null;
async function getCodexConfig(): Promise<typeof import('./codexConfig.js')> {
  return (_configModule ??= await import('./codexConfig.js'));
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
  refs: Map<string, ToolUseCardRef>,
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
  refs: Map<string, ToolUseCardRef>;
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
  const itemLogRefs = new Map<string, ToolUseCardRef>();

  // The live "Codex Turn" card is opened on turn.started and closed on
  // turn.completed / turn.failed with the measured wall time. The finally
  // below closes it on any other exit (stream error, abort, or an early stream
  // end) so the progress view never keeps a spinning Running card after the
  // turn is already dead. finalizeTurnCard is a no-op once the card is closed.
  let turnLogRef: ToolUseCardRef | null = null;
  let turnStartedMs = Date.now();
  const finalizeTurnCard = (state: 'completed' | 'failed', error?: string) => {
    if (!turnLogRef) return;
    const { status = 'completed', ...rest } = buildCodexTurnToolLog({
      state,
      wallTimeMs: Date.now() - turnStartedMs,
      ...(error != null && { error }),
    });
    endToolUseCard(logger, turnLogRef, rest, status);
    turnLogRef = null;
  };

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'thread.started':
          emitToolUseCard(logger, buildCodexThreadToolLog(event));
          break;
        case 'turn.started':
          turnStartedMs = Date.now();
          turnLogRef = emitToolUseCard(
            logger,
            buildCodexTurnToolLog({ state: 'running' }),
          );
          break;
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
          finalizeTurnCard('completed');
          break;
        case 'turn.failed':
          finalizeTurnCard('failed', event.error.message);
          throw new ToolError(event.error.message ?? 'Codex turn failed');
        case 'error':
          finalizeTurnCard('failed', event.message);
          throw new ToolError(event.message ?? 'Codex stream error');
      }
    }
  } finally {
    finalizeTurnCard('failed');
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
  /**
   * The disk-based fallback thread id claimed synchronously in execute(). The
   * loop promotes that reservation after its first turn succeeds.
   */
  resumeThreadId: string | undefined;
  /** Release the fallback claim if the loop exits before promoting it. */
  releaseFallbackClaim: (() => void) | undefined;
}): void {
  const { thread, childStream, parentStreamId, executionId, initialPrompt } =
    params;
  const { childStreamId, logger } = childStream;
  const fallbackThreadId = params.resumeThreadId;

  startAgentCliLoop({
    childStream,
    parentStreamId,
    executionId,
    agentName: 'codex',
    stageLabel: 'Codex session',
    initialPrompt,
    store: CodexThreads,
    releaseFallbackClaim: params.releaseFallbackClaim,
    runProviderTurn: (prompt, _ports, abortController) =>
      runStreamedTurn(
        thread,
        prompt,
        childStreamId,
        logger,
        abortController.signal,
      ),
    buildEntry: (session) => ({
      childStreamId,
      executionId,
      executions: session.executions,
    }),
    resolveSessionIds: () => [fallbackThreadId, thread.id],
    getUsage: (turn) => turn.usage,
    buildUsageStats: (turn) =>
      turn.usage ? buildCodexUsageStats(turn.usage) : undefined,
    formatDelivery: (turn, wallTimeMs, lastPrompt) =>
      formatCodexDelivery(executionId, lastPrompt, wallTimeMs, turn, thread.id),
    formatError: (_turn, err, lastPrompt) =>
      formatChildRunError(
        { tag: DELIVERY_TAG.codexError, executionId, prompt: lastPrompt },
        { message: toErrorMessage(err) },
      ),
    loopFailedMessage: 'Codex run loop failed after launch',
  });
}

// ============================================================================
// Thread creation
// ============================================================================

async function createCodexThread(
  input: CodexInput,
  sandboxMode: SandboxMode,
  workingDir?: string,
): Promise<Thread> {
  const CodexClass = await importCodexClass();
  const codex = new CodexClass({
    codexPathOverride: await findCodexBinaryPath(),
  });
  const config = await getCodexConfig();
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
  requiresApproval: true,
  deferLogUntilApproval: true,
  description:
    'Spin off an OpenAI Codex agent to perform code analysis, generation, or research in a sandboxed environment. ' +
    'The agent runs the Codex CLI locally and can read files, run commands, and make edits within its sandbox. ' +
    'Requires the Codex CLI to be installed (`npm install -g @openai/codex`). ' +
    'Auth is handled by the CLI itself: use `codex login` (OAuth, recommended) or set OPENAI_API_KEY env var. ' +
    'Always async: returns immediately with an execution ID; each turn is delivered back as a follow-up message (including the thread_id). ' +
    'Pass thread_id on a later call to send a follow-up instruction to an existing session, like delegate_agent(execution_id=…).',
  schema: CodexInputSchema,
}) {
  protected async execute(input: CodexInput): Promise<ToolResult> {
    // Resolve the effective sandbox mode once (per-call override, else the
    // user-configured default) rather than mutating the parsed input object.
    const sandboxMode =
      input.sandbox_mode ?? (await getCodexConfig()).getCodexSandboxMode();

    return dispatchAgentCliTool({
      agentName: 'codex',
      approvalLabel: `[codex ${sandboxMode}] ${input.prompt}`,
      store: CodexThreads,
      resumeId: input.thread_id ?? undefined,
      prompt: input.prompt,
      labels: {
        notActiveLabel: 'Codex thread',
        idParamName: 'thread_id',
        summaryLabel: 'Codex',
        queuedLabel: 'Codex thread',
      },
      launch: (context) =>
        launchCodexSession(
          input,
          sandboxMode,
          context.parentStreamId,
          context.parentExecutionId,
          context.parentWorkingDirectory,
          context.releaseFallbackClaim,
        ),
    });
  }
}

async function launchCodexSession(
  input: CodexInput,
  sandboxMode: SandboxMode,
  parentStreamId: StreamTabId,
  parentExecutionId: ExecutionId | undefined,
  parentWorkingDirectory: string | undefined,
  releaseFallbackClaim: (() => void) | undefined,
): Promise<ToolResult> {
  const workingDir = parseWorkingDirectory(parentWorkingDirectory);
  const thread = await createCodexThread(input, sandboxMode, workingDir);
  const config = (await getCodexConfig()).buildCodexConfig(input.prompt);
  const preview = truncateWithEllipsis(input.prompt, 60);

  return launchAgentCliSession({
    parentStreamId,
    parentExecutionId,
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
        resumeThreadId: input.thread_id ?? undefined,
        releaseFallbackClaim,
      }),
    summary: `Launched Codex: ${preview}`,
    launchedLine: `Codex agent launched (sandbox: ${sandboxMode}).`,
    followUpLine: `Result will be delivered as a follow-up message when the turn completes. The delivery includes the thread_id. Pass it to codex on a later call to send a follow-up instruction.`,
  });
}
