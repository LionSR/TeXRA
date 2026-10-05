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
import { Effect, Stream, type FileSystem } from 'effect';
import { z } from 'zod';

// Local imports
import { ToolContext, type WorkspaceRoots } from '@texra-ai/harness';
import {
  emitToolUseCard,
  endOpenToolUseCards,
  endToolUseCard,
  logWebSearch,
  type AgentTrace,
  type OpenToolUseCard,
  type ToolUseCardRef,
} from '@agent/trace';
import type { Runs } from '@agent/runtime/runRegistry';
import type { ChildRunPort } from '@agent/runtime/childRunLoop';
import type { RunCall } from '@agent/runtime/RunCall';
import { formatDelivery } from '@agent/runtime/deliveryEnvelope';
import { withLogChannel } from '@logger/effectLog';
import type {
  CodexApprovalPolicy,
  RunId,
  TokenUsageStats,
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
import { CodexStateKey } from '@texra/shared/settingsView/integrationSettings';
import { buildSyntheticToolUseConfig } from '@texra/tools/core/syntheticAgentConfig';
import { buildAgentWorkspaceOptions } from '@texra/tools/agentWorkspaceOptions';
import { defineTool } from '@tools/core/define';
import type { DetachedChildRunLaunch } from '@tools/delegation/detachedChildRun';
import { readSettingFrom } from '@utils/config/platformSettings';
import { formatWallTimeSeconds, previewLabel } from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  codexSandboxMode,
  getCodexConfig,
  openCodexClient,
} from './codexImport';
import { CodexThreads } from './agentCliSessionStores';
import {
  agentCliApprovalCommand,
  type AgentCliLaunchContext,
  buildAgentCliLaunch,
  dispatchAgentCliTool,
  launchAgentCliSession,
} from './agentCliShared';
import {
  CODEX_AGENT_NAME,
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
  buildCodexMcpToolLog,
  buildCodexThreadToolLog,
  buildCodexTurnToolLog,
} from './codexShared';
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
      logWebSearch(logger, { query: item.query });
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

function updateCodexLiveToolLog(
  logger: AgentTrace,
  refs: Map<string, OpenToolUseCard>,
  item: ThreadItem,
  toolLog: ToolUseLog,
): void {
  const existing = refs.get(item.id);
  const { status = 'completed', ...rest } = toolLog;
  if (existing) endToolUseCard(logger, existing, rest, status);
  // The ref stays after the card closes (re-ending is idempotent); its last
  // log tells the turn's finalizer whether the card is still open.
  const card = existing ?? emitToolUseCard(logger, toolLog);
  refs.set(item.id, { ...card, toolLog });
}

function publishCodexItemProgress(params: {
  item: ThreadItem;
  status: ToolCallStatus;
  logger: AgentTrace;
  refs: Map<string, OpenToolUseCard>;
}): boolean {
  const { item, status, logger, refs } = params;

  const toolLog = buildCodexLiveToolLog(item, status);
  if (!toolLog) return false;

  updateCodexLiveToolLog(logger, refs, item, toolLog);
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
    const itemLogRefs = new Map<string, OpenToolUseCard>();

    // The live "Codex Turn" card is opened on turn.started and closed on
    // turn.completed / turn.failed with the measured wall time. The
    // `Effect.ensuring` below closes it and every open item card on any other
    // exit (stream error, abort, early end), so no dead turn keeps a Running
    // card. finalizeTurnCard is a no-op once the card is closed.
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

    const onEvent = (event: ThreadEvent): void => {
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
          throw new ToolError(event.error.message ?? 'Codex turn failed');
        case 'error':
          finalizeTurnCard('failed', event.message);
          throw new ToolError(event.message ?? 'Codex stream error');
      }
    };

    return Effect.tryPromise({
      try: () => thread.runStreamed(prompt, { signal }),
      catch: ensureError,
    }).pipe(
      Effect.flatMap(({ events }) =>
        Stream.runForEach(Stream.fromAsyncIterable(events, ensureError), (e) =>
          Effect.try({ try: () => onEvent(e), catch: ensureError }),
        ),
      ),
      Effect.map((): RunResult => {
        const finalResponse = responseParts.join('\n\n');
        return { items: [], finalResponse, usage };
      }),
      Effect.ensuring(
        Effect.sync(() => {
          endOpenToolUseCards(logger, itemLogRefs);
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
  childRun: ChildRunPort;
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
    registry: params.registry,
    releaseFallbackClaim,
    runProviderTurn: (prompt, _ports, signal) =>
      runStreamedTurn(thread, prompt, logger, signal),
    resolveSessionIds: () => [fallbackThreadId, thread.id],
    getUsage: codexTurnUsage,
    formatDelivery: (turn, wallTimeMs, lastPrompt) =>
      formatDelivery({
        tag: DELIVERY_TAG.codexResult,
        runId,
        prompt: lastPrompt,
        attributes: [{ name: 'thread-id', value: thread.id || null }],
        wallTime: formatWallTimeSeconds(wallTimeMs),
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
    loopFailedMessage: 'Codex run loop failed after launch',
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
    approvalPolicy: yield* readSettingFrom<CodexApprovalPolicy>(
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
  | ToolContext
  | RunCall
  | Runs
  | CodexThreads
  | ChildProcessSpawner
  | FileSystem.FileSystem
> {
  const toolCall = yield* ToolContext;
  const sandboxMode = yield* codexSandboxMode(input, toolCall.env.roots);

  return yield* dispatchAgentCliTool({
    toolCall,
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
    launch: (context) => launchCodexSession(input, sandboxMode, context),
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
  guard: {
    bash: (input: CodexInput) =>
      agentCliApprovalCommand(CODEX_AGENT_NAME, input.prompt, (stores) =>
        codexSandboxMode(input, stores),
      ),
    // A resumed thread keeps its stored workspace: name none, not the wrong one.
    cwd: 'unknown',
  },
  execute: (input) => runCodex(input),
});

const launchCodexSession = Effect.fn('codex.launchCodexSession')(function* (
  input: CodexInput,
  sandboxMode: SandboxMode,
  context: AgentCliLaunchContext,
): Effect.fn.Return<
  ToolResult,
  ToolError,
  ToolContext | RunCall | Runs | ChildProcessSpawner | FileSystem.FileSystem
> {
  const { roots } = (yield* ToolContext).env;
  const { thread, run } = yield* createCodexThread(
    input,
    sandboxMode,
    roots,
    context.parentWorkingDirectory,
  ).pipe(
    Effect.catch((error) =>
      error instanceof ToolError ? Effect.fail(error) : Effect.die(error),
    ),
  );
  // Synthetic run metadata for the child run: Codex runs outside the normal
  // run loop, so the tool-use category and the model's reference are stated
  // here rather than inherited from the generic AgentConfig defaults.
  const config = buildSyntheticToolUseConfig({
    agent: CODEX_AGENT_NAME,
    model: run.ref,
    instruction: input.prompt,
  });
  const preview = previewLabel(input.prompt);

  return yield* launchAgentCliSession({
    session: context.session,
    parentRunId: context.parentRunId,
    resumeId: input.thread_id ?? undefined,
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
        releaseFallbackClaim: context.releaseFallbackClaim,
        registry: context.registry,
      }),
    summary: `Launched Codex: ${preview}`,
    launchedLine: `Codex agent launched (model: ${run.ref}, effort: ${run.effort ?? 'none'}, sandbox: ${sandboxMode}).${run.note ? ` ${run.note}` : ''}`,
    followUpLine: `Result will be delivered as a follow-up message when the turn completes. The delivery includes the thread_id. Pass it to codex on a later call to send a follow-up instruction.`,
  });
});
