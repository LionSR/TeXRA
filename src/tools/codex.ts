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
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import {
  emitToolUseCard,
  endToolUseCard,
  logWebSearch,
  type AgentTrace,
  type ToolUseCardRef,
} from '@agent/trace';
import type { Runs } from '@agent/runtime/runRegistry';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentResume } from '@platform/interfaces';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  RunId,
  TodoItem,
  ToolResult,
  ToolUseLog,
  ToolCallStatus,
} from '@shared/schemas';
import {
  CodexSandboxModeSchema,
  MESSAGE_TYPES,
  ToolError,
} from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { buildSyntheticToolUseConfig } from '@tools/core/syntheticAgentConfig';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { formatWallTimeSeconds, previewLabel } from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { CODEX_CLI_MODEL } from './codexConfig';
import { defineTool } from './core/define';
import { buildAgentWorkspaceOptions } from './agentWorkspaceOptions';
import {
  codexSandboxMode,
  getCodexConfig,
  importCodexClass,
  findCodexBinaryPath,
} from './codexImport';
import { type ChildRun } from './delegation/childRun';
import { codexThreadsFor } from './agentCliSessionStores';
import {
  agentCliApprovalCommand,
  agentCliCall,
  type AgentCliToolFailure,
  buildAgentCliLaunch,
  dispatchAgentCliTool,
  launchAgentCliSession,
  reraiseAgentCliCallFailure,
} from './agentCliShared';
import { formatDelivery, toDeliveryUsage } from './delegation/deliveryEnvelope';
import {
  CODEX_AGENT_NAME,
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
  buildCodexMcpToolLog,
  buildCodexThreadToolLog,
  buildCodexTodoToolLog,
  buildCodexTurnToolLog,
} from './codexShared';
import type { DetachedChildRunLaunch } from './delegation/detachedChildRun';

// Third-party type imports (import/order places these after local imports)
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
// All other config (model, reasoning, sandbox getter) is lazy-imported from
// codexConfig.ts at runtime to avoid pulling the heavy platform/SDK graph into
// the tool-registration path.

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
// Run fact helpers
// ============================================================================

function toProgressTodos(item: TodoListItem): TodoItem[] {
  return item.items.map((t) => ({
    content: t.text,
    status: t.completed ? ('completed' as const) : ('pending' as const),
    activeForm: t.text,
  }));
}

/**
 * Log a completed codex thread item that has no tool card, straight to the
 * child stream's logger. Every item type `buildCodexLiveToolLog` renders
 * (command_execution, mcp_tool_call, todo_list, and a file_change carrying at
 * least one change) is already on screen by the time an item completes: the
 * `item.completed` handler calls this only when `publishCodexItemProgress`
 * reports that it rendered nothing.
 */
function logCodexItem(item: ThreadItem, logger: AgentTrace): void {
  switch (item.type) {
    case 'agent_message':
      logger.info(item.text, { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
      break;
    case 'reasoning':
      logger.info(item.text, { messageType: MESSAGE_TYPES.THINKING });
      break;
    case 'web_search':
      logWebSearch(logger, { query: item.query });
      break;
    case 'error':
      logger.error(item.message);
      break;
  }
}

function buildCodexLiveToolLog(
  item: ThreadItem,
  status: ToolCallStatus,
): ToolUseLog | null {
  switch (item.type) {
    case 'command_execution':
      return buildCodexCommandToolLog(item);
    case 'file_change': {
      // The builder owns the outcome, like the command and MCP builders: a
      // failed patch stays `failed` even though `item.completed` asks for
      // `completed`. Only the live pass may hold it at `in_progress`.
      const fileLog = buildCodexFileChangeToolLog(item);
      return fileLog
        ? {
            ...fileLog,
            status: fileLog.status === 'failed' ? 'failed' : status,
          }
        : null;
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
  status: ToolCallStatus;
  logger: AgentTrace;
  refs: Map<string, ToolUseCardRef>;
}): boolean {
  const { item, status, logger, refs } = params;

  if (item.type === 'todo_list') {
    const todos = toProgressTodos(item);
    logger.emit({ type: 'run.fact', fact: { key: 'todos', todos } });
  }

  const toolLog = buildCodexLiveToolLog(item, status);
  if (!toolLog) return false;

  updateCodexLiveToolLog(logger, refs, item, toolLog);
  return true;
}

// ============================================================================
// Streaming helpers
// ============================================================================

/** Run a single streamed turn, logging events to the child stream. The
 * `@openai/codex-sdk` stream is this module's foreign edge, so the async drain
 * below is the one place it is wrapped. */
export function runStreamedTurn(
  thread: Thread,
  prompt: string,
  logger: AgentTrace,
  signal?: AbortSignal,
): Effect.Effect<RunResult, Error> {
  return Effect.suspend(() => {
    logger.info(prompt, { messageType: MESSAGE_TYPES.USER_MESSAGE });
    const responseParts: string[] = [];
    let usage: RunResult['usage'] = null;
    const itemLogRefs = new Map<string, ToolUseCardRef>();

    // The live "Codex Turn" card is opened on turn.started and closed on
    // turn.completed / turn.failed with the measured wall time. The
    // `Effect.ensuring` below closes it on any other exit (stream error, abort,
    // or an early stream end) so the progress view never keeps a spinning
    // Running card after the turn is already dead. finalizeTurnCard is a no-op
    // once the card is closed.
    let turnLogRef: ToolUseCardRef | null = null;
    let turnStartedMs = Date.now();
    const finalizeTurnCard = (
      state: 'completed' | 'failed',
      error?: string,
    ) => {
      if (!turnLogRef) return;
      const { status = 'completed', ...rest } = buildCodexTurnToolLog({
        state,
        wallTimeMs: Date.now() - turnStartedMs,
        ...(error != null && { error }),
      });
      endToolUseCard(logger, turnLogRef, rest, status);
      turnLogRef = null;
    };

    const drainTurn = async (): Promise<RunResult> => {
      const { events } = await thread.runStreamed(prompt, { signal });
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
              logger,
              refs: itemLogRefs,
            });
            break;
          case 'item.completed': {
            const { item } = event;
            const wasRenderedAsProgress = publishCodexItemProgress({
              item,
              status: 'completed',
              logger,
              refs: itemLogRefs,
            });
            if (!wasRenderedAsProgress) {
              logCodexItem(item, logger);
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
      return {
        items: [],
        finalResponse: responseParts.join('\n\n'),
        usage,
      };
    };

    return Effect.tryPromise({ try: drainTurn, catch: ensureError }).pipe(
      Effect.ensuring(Effect.sync(() => finalizeTurnCard('failed'))),
    );
  });
}

// ============================================================================
// Codex session loop — one turn per enqueued prompt, delivers to parent
// ============================================================================

/**
 * Build the Codex session loop's strategy. The shared child run loop processes
 * prompts from the child's follow-up queue one at a time and delivers each
 * turn's result to the parent's follow-up queue; this strategy supplies the
 * Codex-specific turn run, registry bookkeeping, and result formatting.
 */
function buildCodexLaunch(params: {
  thread: Thread;
  childRun: ChildRun;
  runId: RunId;
  initialPrompt: string;
  /**
   * The disk-based fallback thread id claimed synchronously in execute(). The
   * loop promotes that reservation after its first turn succeeds.
   */
  resumeThreadId: string | undefined;
  /** Release the fallback claim if the loop exits before promoting it. */
  releaseFallbackClaim: (() => void) | undefined;
}): Effect.Effect<DetachedChildRunLaunch<RunResult>, never, Runs> {
  const {
    thread,
    childRun,
    runId,
    initialPrompt,
    resumeThreadId: fallbackThreadId,
    releaseFallbackClaim,
  } = params;
  const { logger } = childRun;
  return buildAgentCliLaunch({
    childRun,
    runId,
    stageLabel: 'Codex session',
    initialPrompt,
    store: codexThreadsFor,
    releaseFallbackClaim,
    runProviderTurn: (prompt, _ports, signal) =>
      runStreamedTurn(thread, prompt, logger, signal),
    resolveSessionIds: () => [fallbackThreadId, thread.id],
    getUsage: (turn) => turn.usage,
    buildUsageStats: (turn) =>
      turn.usage
        ? {
            inputTokens: turn.usage.input_tokens,
            outputTokens: turn.usage.output_tokens,
            cost: 0,
            ...(turn.usage.cached_input_tokens > 0 && {
              cacheReadInputTokens: turn.usage.cached_input_tokens,
            }),
          }
        : undefined,
    formatDelivery: (turn, wallTimeMs, lastPrompt) =>
      formatDelivery({
        tag: DELIVERY_TAG.codexResult,
        runId,
        prompt: lastPrompt,
        attributes: [{ name: 'thread-id', value: thread.id || null }],
        wallTime: formatWallTimeSeconds(wallTimeMs),
        response: turn.finalResponse,
        usage: toDeliveryUsage(turn.usage),
      }),
    formatError: (_turn, err, lastPrompt) =>
      formatDelivery({
        tag: DELIVERY_TAG.codexError,
        runId,
        prompt: lastPrompt,
        message: toErrorMessage(err),
      }),
    loopFailedMessage: 'Codex run loop failed after launch',
  });
}

// ============================================================================
// Thread creation
// ============================================================================

const createCodexThread = Effect.fn('codex.createCodexThread')(function* (
  input: CodexInput,
  sandboxMode: SandboxMode,
  roots: WorkspaceRoots,
  workingDir?: string,
) {
  const CodexClass = yield* importCodexClass();
  const codexPath = yield* Effect.try({
    try: findCodexBinaryPath,
    catch: ensureError,
  });
  const codex = new CodexClass({ codexPathOverride: codexPath });
  const config = yield* getCodexConfig;
  // Resumed threads keep their stored workspace unless explicitly overridden.
  const workspace =
    workingDir || !input.thread_id
      ? buildAgentWorkspaceOptions(roots.workspace, workingDir)
      : {};
  // Probe Extra High support only when that tier is selected so other
  // efforts do not wait on a slow or hung Codex binary.
  const requestedEffort = yield* config.getCodexCliReasoningEffort(
    roots.workspaceState,
  );
  const threadOptions: ThreadOptions = {
    ...workspace,
    sandboxMode,
    approvalPolicy: yield* config.getCodexApprovalPolicy(roots.workspaceState),
    model: config.CODEX_CLI_MODEL,
    modelReasoningEffort:
      requestedEffort === 'xhigh'
        ? config.toCodexCliReasoningEffort(
            requestedEffort,
            yield* config.codexBinarySupportsXhigh(codexPath),
          )
        : requestedEffort,
    skipGitRepoCheck: true as const,
  };
  // The Codex SDK's own thread constructors, which answer synchronously.
  return yield* Effect.try({
    try: (): Thread =>
      input.thread_id
        ? codex.resumeThread(input.thread_id, threadOptions)
        : codex.startThread(threadOptions),
    catch: ensureError,
  });
});

// ============================================================================
// Tool
// ============================================================================

export class CodexTool extends defineTool({
  name: 'codex',
  requiresApproval: true,
  description:
    'Spin off an OpenAI Codex agent to perform code analysis, generation, or research in a sandboxed environment. ' +
    'The agent runs the Codex CLI locally and can read files, run commands, and make edits within its sandbox. ' +
    'Requires the Codex CLI to be installed (`npm install -g @openai/codex`). ' +
    'Auth is handled by the CLI itself: use `codex login` (OAuth, recommended) or set OPENAI_API_KEY env var. ' +
    'Always async: returns immediately with a run ID; each turn is delivered back as a follow-up message (including the thread_id). ' +
    'Pass thread_id on a later call to send a follow-up instruction to an existing session, like delegate_agent(execution_id=…).',
  schema: CodexInputSchema,
  guard: {
    bash: (input: CodexInput) =>
      agentCliApprovalCommand(CODEX_AGENT_NAME, input.prompt, (state) =>
        codexSandboxMode(input, state),
      ),
    // A resumed thread keeps its stored workspace: name none, not the wrong one.
    cwd: 'unknown',
  },
}) {
  protected execute(input: CodexInput) {
    return Effect.gen({ self: this }, function* () {
      return yield* reraiseAgentCliCallFailure(
        this.run(input, yield* ToolCall),
      );
    });
  }

  private readonly run = Effect.fn('CodexTool.run')(function* (
    this: CodexTool,
    input: CodexInput,
    toolCall: ToolCallShape,
  ): Effect.fn.Return<
    ToolResult,
    AgentCliToolFailure,
    ToolCall | Runs | AgentResume
  > {
    const sandboxMode = yield* codexSandboxMode(
      input,
      toolCall.roots.workspaceState,
    );

    return yield* dispatchAgentCliTool({
      toolCall,
      agentName: CODEX_AGENT_NAME,
      store: codexThreadsFor,
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
          context.parentRunId,
          context.parentWorkingDirectory,
          context.releaseFallbackClaim,
          context.session,
        ),
    });
  });
}

const launchCodexSession = Effect.fn('codex.launchCodexSession')(function* (
  input: CodexInput,
  sandboxMode: SandboxMode,
  parentRunId: RunId,
  parentWorkingDirectory: string | undefined,
  releaseFallbackClaim: (() => void) | undefined,
  session: SessionHandle,
): Effect.fn.Return<
  ToolResult,
  AgentCliToolFailure,
  ToolCall | Runs | AgentResume
> {
  const workingDir = parseWorkingDirectory(parentWorkingDirectory);
  const { roots } = yield* ToolCall;
  const thread = yield* agentCliCall(
    createCodexThread(input, sandboxMode, roots, workingDir),
  );
  // Synthetic run metadata for the child run: Codex runs outside the normal
  // run loop, so the tool-use category and a stable Codex model label are
  // stated here rather than inherited from the generic AgentConfig defaults.
  const config = buildSyntheticToolUseConfig({
    agent: CODEX_AGENT_NAME,
    // Fabricated label, not a routed model: Codex drives its own model.
    model: 'gpt55',
    instruction: input.prompt,
  });
  const preview = previewLabel(input.prompt);

  return yield* launchAgentCliSession({
    session,
    parentRunId,
    agentName: 'codex',
    description: input.prompt,
    config,
    registerFailedMessage: 'Failed to register Codex run.',
    buildLaunch: ({ childRun, runId }) =>
      buildCodexLaunch({
        thread,
        childRun,
        runId,
        initialPrompt: input.prompt,
        resumeThreadId: input.thread_id ?? undefined,
        releaseFallbackClaim,
      }),
    summary: `Launched Codex: ${preview}`,
    launchedLine: `Codex agent launched (sandbox: ${sandboxMode}).`,
    followUpLine: `Result will be delivered as a follow-up message when the turn completes. The delivery includes the thread_id. Pass it to codex on a later call to send a follow-up instruction.`,
  });
});
