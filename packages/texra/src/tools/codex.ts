/**
 * Codex tool — spin off an OpenAI Codex agent via the @openai/codex-sdk.
 *
 * Mirrors the `agent` model: every call is async. Without a
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
 * pluginAvailability.ts.
 */

// Third-party imports
import { Effect, type FileSystem, Result, Schema, Stream } from 'effect';

// Local imports
import {
  defineTool,
  ToolContext,
  withLogChannel,
  type WorkspaceRoots,
  type ToolResult,
  Settings,
} from '@texra-ai/harness';
import {
  ensureError,
  toErrorMessage,
  type RunId,
  type TokenUsageStats,
  type ToolUseLog,
  type ToolCallStatus,
  MESSAGE_TYPES,
} from '@texra-ai/harness/schemas';
import {
  ToolError,
  formatDelivery,
  type AgentTrace,
  type ToolCardHandle,
} from '@texra-ai/harness/plugins';
import { DELIVERY_TAG } from '@texra-ai/harness/transcript';
import type { CodexApprovalPolicy } from '@texra/shared/agentCliSettings';
import { CodexSandboxModeSchema } from '@texra/shared/agentCliSettings';
import { CodexStateKey } from '@texra/shared/settingsView/integrationSettings';
import { buildAgentWorkspaceOptions } from '@texra/tools/agentWorkspaceOptions';

// Local file imports
import {
  codexSandboxMode,
  getCodexConfig,
  openCodexClient,
} from './codexImport';
import { CodexThreads } from './agentCliSessionStores';
import {
  agentCliApprovalCommand,
  buildAgentCliLaunch,
  dispatchAgentCliTool,
  launchAgentCliSession,
  StreamedToolCards,
} from './agentCliShared';
import {
  CODEX_AGENT_NAME,
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
  buildCodexMcpToolLog,
  buildCodexThreadToolLog,
  buildCodexTurnToolLog,
  codexCallCard,
} from './codexShared';
import type { ProcessChildStrategy } from '@texra-ai/harness/plugins';
import type { AgentCliSessionRegistry } from './agentCliSessionRegistry';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

// Third-party type imports (import/order places these after local imports)
import type {
  RunResult,
  SandboxMode,
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
} from '@openai/codex-sdk';

// The sandbox-mode schema is imported eagerly from `@shared` (a light,
// dependency-free leaf) since it is used at module level by the input schema.
// The model and reasoning config are lazy-imported from codexConfig.ts at
// runtime, off the tool-registration path. Setting reads are schema-typed and
// land in SDK-typed fields, so a value the Codex union rejects fails to compile.

// ============================================================================
// Schema
// ============================================================================

const CodexInputSchema = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      'Instruction for the Codex agent. For a new session, describe the task. For a resume (thread_id set), describe the follow-up.',
  }),
  sandbox_mode: Schema.optional(Schema.NullOr(CodexSandboxModeSchema)).annotate(
    {
      description:
        'File access level for the Codex agent (defaults to user-configured mode, typically workspace-write)',
    },
  ),
  thread_id: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      'Resume an existing Codex thread with a follow-up instruction. The prompt is enqueued as the next turn; if the thread is currently processing, the prompt waits in its queue.',
  }),
});

type CodexInput = typeof CodexInputSchema.Type;

/**
 * Log a completed codex thread item that has no tool card, straight to the
 * child stream's logger. Every item type `buildCodexLiveToolLog` renders
 * (command_execution, mcp_tool_call, and a file_change carrying at
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
      logger.info('', {
        messageType: MESSAGE_TYPES.WEB_SEARCH,
        data: { query: item.query },
      });
      break;
    case 'error':
      logger.error(item.message);
      break;
    case 'todo_list':
      // Deliberately not projected: Codex's own task list has no TeXRA
      // surface since the todo tool and its UI were removed.
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
    default:
      return null;
  }
}

function publishCodexItemProgress(params: {
  item: ThreadItem;
  status: ToolCallStatus;
  cards: StreamedToolCards;
}): boolean {
  const { item, status, cards } = params;

  const toolLog = buildCodexLiveToolLog(item, status);
  if (!toolLog) return false;

  cards.openOrUpdate(item.id, toolLog);
  return true;
}

/** A Codex turn's spend in the one usage shape. The SDK reports no cost. */
function codexTurnUsage({ usage }: RunResult): TokenUsageStats | null {
  if (!usage) return null;
  const cacheRead = usage.cached_input_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cost: 0,
    ...(cacheRead > 0 && { cacheReadInputTokens: cacheRead }),
  };
}

/** Run a single streamed turn, logging events to the child stream. The
 * `@openai/codex-sdk` event iterator is this module's foreign edge, consumed
 * as a Stream below. */
function runStreamedTurn(
  thread: Thread,
  prompt: string,
  logger: AgentTrace,
  signal?: AbortSignal,
): Effect.Effect<RunResult, Error> {
  return Effect.clockWith((clock) => {
    logger.info(prompt, { messageType: MESSAGE_TYPES.USER_MESSAGE });
    const responseParts: string[] = [];
    let usage: RunResult['usage'] = null;
    const itemCards = new StreamedToolCards(logger);

    // The live "Codex Turn" card is opened on turn.started and closed on
    // turn.completed / turn.failed with the measured wall time. The
    // `Effect.ensuring` below closes it and every open item card on any other
    // exit (stream error, abort, early end), so no dead turn keeps a Running
    // card. finalizeTurnCard is a no-op once the card is closed.
    let turnCard: ToolCardHandle | null = null;
    let turnStartedMs = clock.currentTimeMillisUnsafe();
    const finalizeTurnCard = (
      state: 'completed' | 'failed',
      error?: string,
    ) => {
      if (!turnCard) return;
      turnCard.update(
        buildCodexTurnToolLog({
          state,
          wallTimeMs: clock.currentTimeMillisUnsafe() - turnStartedMs,
          ...(error != null && { error }),
        }),
      );
      turnCard = null;
    };

    // A failed turn or stream error ends the run as a ToolError.
    const onEvent = (event: ThreadEvent): Effect.Effect<void, ToolError> => {
      switch (event.type) {
        case 'thread.started':
          logger.openToolCard(buildCodexThreadToolLog(event));
          break;
        case 'turn.started':
          turnStartedMs = clock.currentTimeMillisUnsafe();
          turnCard = logger.openToolCard(
            buildCodexTurnToolLog({ state: 'running' }),
          );
          break;
        case 'item.started':
        case 'item.updated':
          publishCodexItemProgress({
            item: event.item,
            status: 'in_progress',
            cards: itemCards,
          });
          break;
        case 'item.completed': {
          const { item } = event;
          const wasRenderedAsProgress = publishCodexItemProgress({
            item,
            status: 'completed',
            cards: itemCards,
          });
          if (!wasRenderedAsProgress) logCodexItem(item, logger);
          if (item.type === 'agent_message') responseParts.push(item.text);
          break;
        }
        case 'turn.completed':
          usage = event.usage ?? null;
          finalizeTurnCard('completed');
          break;
        case 'turn.failed':
          finalizeTurnCard('failed', event.error.message);
          return Effect.fail(
            new ToolError(event.error.message ?? 'Codex turn failed'),
          );
        case 'error':
          finalizeTurnCard('failed', event.message);
          return Effect.fail(
            new ToolError(event.message ?? 'Codex stream error'),
          );
      }
      return Effect.void;
    };

    return Effect.tryPromise({
      try: () => thread.runStreamed(prompt, { signal }),
      catch: ensureError,
    }).pipe(
      Effect.flatMap(({ events }) =>
        Stream.runForEach(Stream.fromAsyncIterable(events, ensureError), (e) =>
          Effect.suspend(() => onEvent(e)),
        ),
      ),
      Effect.map((): RunResult => {
        const finalResponse = responseParts.join('\n\n');
        return { items: [], finalResponse, usage };
      }),
      Effect.ensuring(
        Effect.sync(() => {
          itemCards.failOpen();
          finalizeTurnCard('failed');
        }),
      ),
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
  logger: AgentTrace;
  runId: RunId;
  initialPrompt: string;
  /**
   * The disk-based fallback thread id claimed synchronously in execute(). The
   * loop promotes that reservation after its first turn succeeds.
   */
  resumeThreadId: string | undefined;
  /** Release the fallback claim if the loop exits before promoting it. */
  releaseFallbackClaim: (() => void) | undefined;
  registry: AgentCliSessionRegistry;
}): Effect.Effect<ProcessChildStrategy<RunResult>> {
  const {
    thread,
    logger,
    runId,
    initialPrompt,
    resumeThreadId: fallbackThreadId,
    releaseFallbackClaim,
  } = params;
  return buildAgentCliLaunch({
    logger,
    runId,
    stageLabel: 'Codex session',
    initialPrompt,
    registry: params.registry,
    releaseFallbackClaim,
    runProviderTurn: (prompt, signal) =>
      runStreamedTurn(thread, prompt, logger, signal),
    resolveSessionIds: () => [fallbackThreadId, thread.id],
    getUsage: codexTurnUsage,
    formatDelivery: (turn, wallTimeMs, lastPrompt) =>
      formatDelivery({
        tag: DELIVERY_TAG.codexResult,
        runId,
        prompt: lastPrompt,
        attributes: [{ name: 'thread-id', value: thread.id || null }],
        wallTime: `${(wallTimeMs / 1000).toFixed(1)}s`,
        response: turn.finalResponse,
        usage: codexTurnUsage(turn),
      }),
    formatError: (_turn, err, lastPrompt) =>
      formatDelivery({
        tag: DELIVERY_TAG.codexError,
        runId,
        prompt: lastPrompt,
        message: toErrorMessage(err),
      }),
    continueWith: ['codex', 'thread_id', fallbackThreadId],
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
  const { codex, codexPath } = yield* openCodexClient();
  const config = yield* getCodexConfig;
  // Resumed threads keep their stored workspace unless explicitly overridden.
  const workspace =
    workingDir || !input.thread_id
      ? buildAgentWorkspaceOptions(roots.workspace, workingDir)
      : {};
  const run = yield* config.codexRun(roots, codexPath);
  if (run.note) {
    yield* Effect.logInfo(run.note).pipe(withLogChannel(CODEX_AGENT_NAME));
  }
  const threadOptions: ThreadOptions = {
    ...workspace,
    sandboxMode,
    approvalPolicy: yield* Settings.get<CodexApprovalPolicy>(
      roots,
      CodexStateKey.APPROVAL_POLICY,
    ),
    model: run.slug,
    ...(run.effort && { modelReasoningEffort: run.effort }),
    skipGitRepoCheck: true as const,
  };
  // The Codex SDK's own thread constructors, which answer synchronously.
  const thread = yield* Effect.try({
    try: (): Thread =>
      input.thread_id
        ? codex.resumeThread(input.thread_id, threadOptions)
        : codex.startThread(threadOptions),
    catch: ensureError,
  });
  return { thread, run };
});

// ============================================================================
// Tool
// ============================================================================

const runCodex = Effect.fn('CodexTool.run')(function* (
  input: CodexInput,
): Effect.fn.Return<
  ToolResult,
  ToolError,
  ToolContext | CodexThreads | ChildProcessSpawner | FileSystem.FileSystem
> {
  const sandboxMode = yield* codexSandboxMode(
    input,
    (yield* ToolContext).env.roots,
  );

  return yield* dispatchAgentCliTool({
    agentName: CODEX_AGENT_NAME,
    store: CodexThreads,
    resumeId: input.thread_id ?? undefined,
    prompt: input.prompt,
    labels: {
      notActiveLabel: 'Codex thread',
      idParamName: 'thread_id',
      summaryLabel: 'Codex',
      queuedLabel: 'Codex thread',
    },
    launch: (releaseFallbackClaim) =>
      launchCodexSession(input, sandboxMode, releaseFallbackClaim),
  });
});

export const CodexTool = defineTool({
  name: 'codex',
  requiresApproval: true,
  description:
    'Spin off an OpenAI Codex agent to perform code analysis, generation, or research in a sandboxed environment. ' +
    'The agent runs the Codex CLI locally and can read files, run commands, and make edits within its sandbox. ' +
    'Requires the Codex CLI to be installed (`npm install -g @openai/codex`). ' +
    'Auth is handled by the CLI itself: use `codex login` (OAuth, recommended) or set OPENAI_API_KEY env var. ' +
    'Always async: returns immediately with a run ID; each turn is delivered back as a follow-up message (including the thread_id). ' +
    'Pass thread_id on a later call to send a follow-up instruction to an existing session, like executions send to an `agent` subagent. ' +
    'Choose codex for coding tasks that benefit from a separate OpenAI agent. It runs in its own sandbox with independent tool use, async and multi-turn like `agent`. ' +
    'When multiple codex agents must edit the same files, or to isolate experimental changes, use a git worktree (`git worktree add ../worktree-name branch-name`); codex runs in the working directory of the calling agent and takes no directory argument. ' +
    'codex and claude_code are both independent sandboxed coders distinct from the in-process `agent` specialists. Prefer whichever vendor fits the task, and for parallel or isolated edits run them against a git worktree.',
  schema: CodexInputSchema,
  card: (raw) => {
    const input = Schema.decodeUnknownResult(CodexInputSchema)(raw);
    return Result.isSuccess(input) ? codexCallCard(input.success) : undefined;
  },
  guard: {
    bash: (input: CodexInput) =>
      agentCliApprovalCommand(CODEX_AGENT_NAME, input.prompt, (stores) =>
        codexSandboxMode(input, stores),
      ),
    // A resumed thread keeps its stored workspace: name none, not the wrong one.
    cwd: 'unknown',
  },
  execute: runCodex,
});

const launchCodexSession = Effect.fn('codex.launchCodexSession')(function* (
  input: CodexInput,
  sandboxMode: SandboxMode,
  releaseFallbackClaim: (() => void) | undefined,
): Effect.fn.Return<
  ToolResult,
  ToolError,
  ToolContext | CodexThreads | ChildProcessSpawner | FileSystem.FileSystem
> {
  const { roots, workingDirectory } = (yield* ToolContext).env;
  const registry = yield* CodexThreads;
  const { thread, run } = yield* createCodexThread(
    input,
    sandboxMode,
    roots,
    workingDirectory,
  ).pipe(
    Effect.catch((error) =>
      error instanceof ToolError ? Effect.fail(error) : Effect.die(error),
    ),
  );
  return yield* launchAgentCliSession({
    resumeId: input.thread_id ?? undefined,
    agentName: 'codex',
    prompt: input.prompt,
    modelRef: run.ref,
    registerFailedMessage: 'Failed to register Codex run.',
    buildLaunch: ({ logger, runId }) =>
      buildCodexLaunch({
        thread,
        logger,
        runId,
        initialPrompt: input.prompt,
        resumeThreadId: input.thread_id ?? undefined,
        releaseFallbackClaim,
        registry,
      }),
    summaryLabel: 'Codex',
    launchedLine: `Codex agent launched (model: ${run.ref}, effort: ${run.effort ?? 'none'}, sandbox: ${sandboxMode}).${run.note ? ` ${run.note}` : ''}`,
    followUpLine: `Result will be delivered as a follow-up message when the turn completes. The delivery includes the thread_id. Pass it to codex on a later call to send a follow-up instruction.`,
  });
});
