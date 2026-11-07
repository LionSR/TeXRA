/**
 * Codex tool — spin off an OpenAI Codex agent via the @openai/codex-sdk.
 *
 * Mirrors the `agent` model: every call is async, and every call is one
 * turn, run as one child run that ends with its result delivered as a
 * follow-up to the parent. Without a thread_id, a new Codex thread is
 * started. With a thread_id, the prompt continues that thread; a thread
 * whose turn is still running here refuses another until it is delivered.
 *
 * The Codex CLI handles its own auth (~/.codex/auth.json from `codex login`,
 * OPENAI_API_KEY, config files).
 *
 * Requires the Codex CLI binary, gated by the availability check in
 * codexPlugin.ts.
 */

// Third-party imports
import {
  Effect,
  type FileSystem,
  Result,
  Schema,
  type Scope,
  Stream,
} from 'effect';

// Local imports
import {
  defineTool,
  type WorkspaceRoots,
  type ToolResult,
} from '@texra-ai/harness';
import { ChildRuns, ToolContext } from '@texra-ai/harness/plugins';
import { withLogChannel } from '@texra-ai/harness/host';
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
import { buildAgentWorkspaceOptions } from '@texra/tools/agentCli/agentWorkspaceOptions';

// Local file imports
import { getCodexConfig, openCodexClient } from './codexImport';
import { CodexThreads } from './agentCliSessionStores';
import {
  buildAgentCliTurn,
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
import type {
  PluginToolServices,
  ProcessTurn,
} from '@texra-ai/harness/plugins';
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
  thread_id: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      'Continue an existing Codex thread with a follow-up instruction, as its next turn. A thread whose turn is still running refuses another until that turn is delivered.',
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
  const cached = usage.cached_input_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cost: 0,
    ...(cached > 0 && { cachedInputTokens: cached }),
  };
}

/** Run a single streamed turn, logging events to the child stream. The
 * `@openai/codex-sdk` event iterator is this module's foreign edge, consumed
 * as a Stream below. */
function runStreamedTurn(
  thread: Thread,
  prompt: string,
  logger: AgentTrace,
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

    // The SDK's process lives as long as its signal: a stop interrupts this
    // turn, and the scope's close aborts it.
    return Effect.flatMap(Effect.abortSignal, (signal) =>
      Effect.tryPromise({
        try: () => thread.runStreamed(prompt, { signal }),
        catch: ensureError,
      }),
    ).pipe(
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
      Effect.scoped,
    );
  });
}

// ============================================================================
// The child's turn: one Codex turn, delivered to the parent by its end
// ============================================================================

/** The Codex child's one turn: the Codex-specific turn run and result
 *  formatting over the shared agent-CLI turn. */
function buildCodexTurn(params: {
  thread: Thread;
  logger: AgentTrace;
  runId: RunId;
  prompt: string;
  /** The claim on the thread this turn continues, closed as it ends. */
  claim: Scope.Closeable | undefined;
}): ProcessTurn {
  const { thread, logger, runId, prompt } = params;
  return buildAgentCliTurn({
    logger,
    stageLabel: 'Codex session',
    claim: params.claim,
    runProviderTurn: runStreamedTurn(thread, prompt, logger),
    getUsage: codexTurnUsage,
    formatDelivery: (turn, wallTimeMs) =>
      formatDelivery({
        tag: 'codex-result',
        runId,
        prompt,
        attributes: [{ name: 'thread-id', value: thread.id || null }],
        wallTime: `${(wallTimeMs / 1000).toFixed(1)}s`,
        response: turn.finalResponse,
        usage: codexTurnUsage(turn),
      }),
    formatError: (_turn, err) =>
      formatDelivery({
        tag: 'codex-error',
        runId,
        prompt,
        message: toErrorMessage(err),
      }),
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
    // Codex cannot ask through TeXRA: the run's policy decided at launch.
    approvalPolicy: 'never',
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
  | PluginToolServices
  | CodexThreads
  | ChildProcessSpawner
  | FileSystem.FileSystem
> {
  // The workspace when a person approved the launch; everything when the
  // run's work is auto-approved.
  const sandboxMode: SandboxMode = (yield* (yield* ChildRuns).autoApproved)
    ? 'danger-full-access'
    : 'workspace-write';

  return yield* dispatchAgentCliTool({
    agentName: CODEX_AGENT_NAME,
    store: CodexThreads,
    resumeId: input.thread_id ?? undefined,
    threadLabel: 'Codex thread',
    launch: (claim) => launchCodexSession(input, sandboxMode, claim),
  });
});

export const CodexTool = defineTool({
  name: 'codex',
  description:
    'Spin off an OpenAI Codex agent to perform code analysis, generation, or research in a sandboxed environment. ' +
    "The agent runs the Codex CLI locally and can read files, run commands, and make edits within its sandbox, which follows this run's approval policy: workspace-write when the launch was approved, full access under Auto-approve or an all-agent-work grant. " +
    'Requires the Codex CLI to be installed (`npm install -g @openai/codex`). ' +
    'Auth is handled by the CLI itself: use `codex login` (OAuth, recommended) or set OPENAI_API_KEY env var. ' +
    'Always async: returns immediately with a run ID; each turn is delivered back as a follow-up message (including the thread_id). ' +
    'Pass thread_id on a later call to continue that thread with a follow-up instruction, one turn per call. ' +
    'Choose codex for coding tasks that benefit from a separate OpenAI agent. It runs in its own sandbox with independent tool use, async and multi-turn like `agent`. ' +
    'When multiple codex agents must edit the same files, or to isolate experimental changes, use a git worktree (`git worktree add ../worktree-name branch-name`); codex runs in the working directory of the calling agent and takes no directory argument. ' +
    'codex and claude_code are both independent sandboxed coders distinct from the in-process `agent` specialists. Prefer whichever vendor fits the task, and for parallel or isolated edits run them against a git worktree.',
  schema: CodexInputSchema,
  card: (raw) => {
    const input = Schema.decodeUnknownResult(CodexInputSchema)(raw);
    return Result.isSuccess(input) ? codexCallCard(input.success) : undefined;
  },
  guard: {
    command: {
      text: (input: CodexInput) => `[${CODEX_AGENT_NAME}] ${input.prompt}`,
      // A resumed thread keeps its stored workspace: name none, not the wrong one.
      cwd: 'unknown',
    },
  },
  execute: runCodex,
});

const launchCodexSession = Effect.fn('codex.launchCodexSession')(function* (
  input: CodexInput,
  sandboxMode: SandboxMode,
  claim: Scope.Closeable | undefined,
): Effect.fn.Return<
  ToolResult,
  ToolError,
  PluginToolServices | ChildProcessSpawner | FileSystem.FileSystem
> {
  const { roots, workingDirectory } = (yield* ToolContext).env;
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
    agentName: 'codex',
    prompt: input.prompt,
    modelRef: run.ref,
    registerFailedMessage: 'Failed to register Codex run.',
    turn: ({ logger, runId }) =>
      buildCodexTurn({
        thread,
        logger,
        runId,
        prompt: input.prompt,
        claim,
      }),
    summaryLabel: 'Codex',
    launchedLine: `Codex agent launched (model: ${run.ref}, effort: ${run.effort ?? 'none'}, sandbox: ${sandboxMode}).${run.note ? ` ${run.note}` : ''}`,
    followUpLine: `Result will be delivered as a follow-up message when the turn completes. The delivery includes the thread_id. Pass it to codex on a later call to continue the thread.`,
  });
});
