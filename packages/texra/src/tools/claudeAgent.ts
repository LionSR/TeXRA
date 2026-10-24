/**
 * Claude Code CLI tool — spin off a Claude Code agent via @anthropic-ai/claude-agent-sdk.
 *
 * Mirrors the codex / `agent` model: every call is async. Without a
 * session_id, a new Claude Code session is started and the result is delivered
 * as a follow-up to the parent stream. With a session_id, the prompt is
 * enqueued as a follow-up instruction to an existing session via the SDK's
 * `resume:` option (or via streaming-input on the live session). With
 * fork_session, it instead starts a new session from the selected session's
 * state. Each turn's result is delivered back to the parent's follow-up
 * queue for both orchestrator-initiated and user-initiated turns.
 *
 * Authentication: the SDK spawns the Claude Code CLI as a subprocess, which
 * picks up whichever auth the user has configured:
 *   - ANTHROPIC_API_KEY env var (or stored in TeXRA Settings → API Keys)
 *   - CLAUDE_CODE_OAUTH_TOKEN env var (long-lived OAuth token from
 *     `claude setup-token`)
 *   - OAuth session from `claude login` (Pro/Max subscription)
 *   - Bedrock / Vertex (configured via CLI/env vars)
 *
 * Requires the native `claude` CLI, checked in pluginAvailability.ts.
 */

// Third-party imports
import { Effect, Stream, type FileSystem } from 'effect';
import { z } from 'zod';
import {
  defineTool,
  Secrets,
  ToolContext,
  type ToolResult,
} from '@texra-ai/harness';

// Local imports
import {
  ensureError,
  toErrorMessage,
  MESSAGE_TYPES,
  type RunId,
  type TokenUsageStats,
  type ToolUseLog,
} from '@texra-ai/harness/schemas';
import { DELIVERY_TAG } from '@texra-ai/harness/transcript';
import {
  formatDelivery,
  type AgentTrace,
  type ToolCardHandle,
} from '@texra-ai/harness/plugins';
import {
  ToolError,
  type ProcessChildStrategy,
} from '@texra-ai/harness/plugins';
import {
  AgentCliEffortSchema,
  ClaudeAgentModelSchema,
  ClaudeAgentPermissionModeSchema,
} from '@texra/shared/agentCliSettings';
import type { ClaudeAgentPermissionMode } from '@texra/shared/agentCliSettings';
import { buildAgentWorkspaceOptions } from '@texra/tools/agentWorkspaceOptions';

// Local file imports
import { ClaudeBackgroundTaskTracker } from './claudeAgentBackgroundTasks';
import {
  claudeAgentPermissionMode,
  getClaudeAgentConfig,
  importClaudeAgentSdk,
  findClaudeBinaryPath,
} from './claudeAgentImport';
import { ClaudeAgentSessions } from './agentCliSessionStores';
import {
  agentCliApprovalCommand,
  type AgentCliLaunchContext,
  buildAgentCliLaunch,
  dispatchAgentCliTool,
  launchAgentCliSession,
} from './agentCliShared';
import {
  buildClaudeToolUseLog,
  claudeResultUsage,
  CLAUDE_AGENT_NAME,
  readClaudeCodeRun,
  type ClaudeCodeRun,
} from './claudeAgentShared';
import type { AgentCliSessionRegistry } from './agentCliSessionRegistry';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

// Third-party type imports (import/order places these after local imports)
import type {
  EffortLevel,
  Options as ClaudeAgentSdkOptions,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';

// ============================================================================
// Schema
// ============================================================================

const ClaudeAgentInputSchema = z
  .strictObject({
    prompt: z
      .string()
      .describe(
        'Instruction for the Claude Code agent. For a new session, describe the task. For a resume (session_id set), describe the follow-up.',
      ),
    // A subset of the SDK's `PermissionMode`: 'dontAsk' and 'auto' are internal
    // to the SDK and never offered here.
    permission_mode: ClaudeAgentPermissionModeSchema.nullish().describe(
      'Permission behavior for the agent: acceptEdits auto-applies file edits, plan keeps the agent read-only (defaults to user-configured mode, typically acceptEdits).',
    ),
    model: z
      .string()
      .nullish()
      .describe(
        `Claude model reference, optionally with an effort suffix (e.g. 'anthropic/claude-opus-5-5' or 'anthropic/claude-opus-5-5@high'). Any non-retired Anthropic model; current ones: ${ClaudeAgentModelSchema.options.join(', ')}. Defaults to the user-configured model.`,
      ),
    effort: AgentCliEffortSchema.nullish().describe(
      "Reasoning effort; overrides the model's @effort suffix. Defaults to the user-configured effort (medium unless changed). A level the model lacks becomes the nearest one it has.",
    ),
    session_id: z
      .string()
      .min(1)
      .nullish()
      .describe(
        'Resume an existing Claude Code session with a follow-up instruction. The prompt is enqueued as the next turn; if the session is currently processing, the prompt waits in its queue.',
      ),
    fork_session: z
      .boolean()
      .nullish()
      .describe(
        'When true, branch from session_id into a new Claude session and leave the original session unchanged. Defaults to false.',
      ),
  })
  .refine((input) => input.fork_session !== true || input.session_id != null, {
    message: 'fork_session requires session_id',
    path: ['fork_session'],
  });

type ClaudeAgentInput = z.infer<typeof ClaudeAgentInputSchema>;

// ============================================================================
// Result formatting
// ============================================================================

interface TurnResult {
  finalResponse: string;
  usage: TokenUsageStats | null;
  sessionId: string | undefined;
  totalCostUsd?: number;
  isError: boolean;
  errorMessage?: string;
}

function claudeCostLines(turn: TurnResult): string[] | undefined {
  return typeof turn.totalCostUsd === 'number' && turn.totalCostUsd > 0
    ? [`<cost-usd>${turn.totalCostUsd.toFixed(4)}</cost-usd>`]
    : undefined;
}

// ============================================================================
// Streamed turn — drains the SDK's async generator into log entries + a
// TurnResult for follow-up delivery.
// ============================================================================

export function runStreamedTurn(params: {
  prompt: string;
  logger: AgentTrace;
  signal: AbortSignal;
  /** The API model ID. */
  model: string;
  permissionMode: ClaudeAgentPermissionMode;
  effort: EffortLevel | undefined;
  thinking: ThinkingConfig | undefined;
  cwd: string | undefined;
  additionalDirectories: string[] | undefined;
  env: NodeJS.ProcessEnv;
  resumeSessionId: string | undefined;
  forkSession?: boolean;
  pathToClaudeCodeExecutable: string | undefined;
}): Effect.Effect<TurnResult, Error> {
  // Draining `query()` is this module's foreign edge: its iterator is
  // consumed as a Stream whose finalizer unlinks the abort and ends every
  // tool card still open. Loading the SDK is the importer's own edge.
  return Effect.gen(function* () {
    const { logger, prompt } = params;
    logger.info(prompt, { messageType: MESSAGE_TYPES.USER_MESSAGE });

    const query = yield* importClaudeAgentSdk();

    // The SDK takes a controller, not a signal: this one exists only at that
    // boundary and follows the turn's signal until the stream is drained.
    const abortController = new AbortController();
    const forwardAbort = () => abortController.abort(params.signal.reason);
    if (params.signal.aborted) forwardAbort();
    else params.signal.addEventListener('abort', forwardAbort, { once: true });
    const sdkOptions: ClaudeAgentSdkOptions = {
      abortController,
      model: params.model,
      permissionMode: params.permissionMode,
      env: params.env,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
    };
    if (params.effort) sdkOptions.effort = params.effort;
    if (params.thinking) sdkOptions.thinking = params.thinking;
    if (params.permissionMode === 'bypassPermissions') {
      sdkOptions.allowDangerouslySkipPermissions = true;
    }
    if (params.cwd) sdkOptions.cwd = params.cwd;
    if (params.additionalDirectories?.length) {
      sdkOptions.additionalDirectories = params.additionalDirectories;
    }
    if (params.resumeSessionId) sdkOptions.resume = params.resumeSessionId;
    if (params.forkSession) sdkOptions.forkSession = true;
    if (params.pathToClaudeCodeExecutable) {
      sdkOptions.pathToClaudeCodeExecutable = params.pathToClaudeCodeExecutable;
    }

    const responseParts: string[] = [];
    const toolCards = new Map<string, ToolCardHandle>();
    const backgroundTasks = new ClaudeBackgroundTaskTracker(logger);
    let usage: TurnResult['usage'] = null;
    let sessionId: string | undefined;
    let totalCostUsd: number | undefined;
    let isError = false;
    let errorMessage: string | undefined;

    const onMessage = (raw: SDKMessage): void => {
      if ('session_id' in raw && raw.session_id) sessionId = raw.session_id;
      switch (raw.type) {
        case 'assistant':
          handleAssistantBlocks(
            raw.message.content,
            logger,
            toolCards,
            responseParts,
          );
          break;
        case 'user':
          if (Array.isArray(raw.message.content)) {
            handleToolResults(raw.message.content, toolCards);
          }
          break;
        case 'result':
          usage = claudeResultUsage(raw);
          totalCostUsd = raw.total_cost_usd;
          if (raw.subtype === 'success') {
            if (typeof raw.result === 'string' && raw.result.trim() !== '')
              responseParts.push(raw.result);
          } else {
            isError = true;
            errorMessage =
              raw.errors?.join('\n') || raw.subtype || 'Claude Code error';
          }
          break;
        case 'system':
          switch (raw.subtype) {
            case 'init':
              logger.info(`Claude session ${raw.session_id} started`);
              break;
            case 'background_tasks_changed':
              backgroundTasks.replace(raw.tasks);
              break;
          }
          break;
      }
    };
    yield* Stream.unwrap(
      Effect.try({
        try: () =>
          Stream.fromAsyncIterable(
            query({ prompt, options: sdkOptions }),
            ensureError,
          ),
        catch: ensureError,
      }),
    ).pipe(
      Stream.runForEach((raw) =>
        Effect.try({ try: () => onMessage(raw), catch: ensureError }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          params.signal.removeEventListener('abort', forwardAbort);
          backgroundTasks.finish();
          for (const card of toolCards.values()) card.failIfOpen();
          toolCards.clear();
        }),
      ),
    );

    if (
      params.forkSession &&
      (!sessionId || sessionId === params.resumeSessionId)
    ) {
      isError = true;
      errorMessage = [
        errorMessage,
        'Claude Code fork did not create a distinct session',
      ]
        .filter(
          (part): part is string =>
            typeof part === 'string' && part.trim() !== '',
        )
        .join('\n');
    }

    return {
      finalResponse: responseParts.join('\n\n'),
      usage,
      sessionId,
      totalCostUsd,
      isError,
      errorMessage,
    };
  });
}

function handleAssistantBlocks(
  blocks: SDKAssistantMessage['message']['content'],
  logger: AgentTrace,
  cards: Map<string, ToolCardHandle>,
  responseParts: string[],
): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.trim() !== '') {
          logger.info(block.text, {
            messageType: MESSAGE_TYPES.MODEL_RESPONSE,
          });
          responseParts.push(block.text);
        }
        break;
      case 'thinking':
        if (
          typeof block.thinking === 'string' &&
          block.thinking.trim() !== ''
        ) {
          logger.info(block.thinking, { messageType: MESSAGE_TYPES.THINKING });
        }
        break;
      case 'tool_use': {
        if (typeof block.name !== 'string') break;
        if (typeof block.id !== 'string' || block.id.length === 0) break;
        const toolLog = buildClaudeToolUseLog({
          toolName: block.name,
          input: block.input,
          status: 'in_progress',
          trace: logger,
        });
        cards.set(block.id, logger.openToolCard(toolLog));
        break;
      }
    }
  }
}

function handleToolResults(
  blocks: Exclude<SDKUserMessage['message']['content'], string>,
  cards: Map<string, ToolCardHandle>,
): void {
  for (const block of blocks) {
    if (block.type !== 'tool_result') continue;
    const id = block.tool_use_id;
    if (typeof id !== 'string') continue;
    const card = cards.get(id);
    if (!card) continue;

    const isError = block.is_error === true;
    const update: Partial<ToolUseLog> = {
      ...(block.content !== undefined && {
        output: block.content as ToolUseLog['output'],
      }),
      ...(isError && {
        error: extractToolErrorMessage(block.content) ?? 'Tool error',
      }),
    };
    card.update({
      ...card.log,
      ...update,
      status: isError ? 'failed' : 'completed',
    });
    cards.delete(id);
  }
}

function extractToolErrorMessage(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block != null && typeof block === 'object' && 'text' in block) {
      const { text } = block;
      if (typeof text === 'string') return text;
    }
  }
  return undefined;
}

// ============================================================================
// Session loop — drains follow-ups, runs turns, delivers results to parent
// ============================================================================

function buildClaudeAgentLaunch(params: {
  logger: AgentTrace;
  runId: RunId;
  initialPrompt: string;
  run: ClaudeCodeRun;
  permissionMode: ClaudeAgentPermissionMode;
  cwd: string | undefined;
  additionalDirectories: string[] | undefined;
  env: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable: string | undefined;
  forkSession: boolean;
  /**
   * Set when this launch is the disk-based fallback for a session_id the
   * in-memory registry no longer knows about (extension reload or crash). The
   * id is claimed synchronously before fallback setup begins, seeds the first
   * turn's `resume` option, and is promoted after that turn succeeds.
   */
  resumeSessionId: string | undefined;
  /** Release the fallback claim if the loop exits before promoting it. */
  releaseFallbackClaim: (() => void) | undefined;
  registry: AgentCliSessionRegistry;
}): Effect.Effect<ProcessChildStrategy<TurnResult>> {
  const { logger, runId, initialPrompt } = params;

  // The SDK needs the prior session id to resume the same conversation across
  // turns; it's threaded forward from each turn's result. Seeded from
  // params.resumeSessionId when this launch is a disk-based fallback resume.
  let resumeSessionId: string | undefined = params.resumeSessionId;
  let isFirstTurn = true;
  const fallbackSessionId = params.forkSession
    ? undefined
    : params.resumeSessionId;

  return buildAgentCliLaunch({
    logger,
    runId,
    stageLabel: 'Claude Code session',
    initialPrompt,
    registry: params.registry,
    releaseFallbackClaim: params.releaseFallbackClaim,
    // The shared loop calls this inside its own `Effect.suspend`, so the
    // reads below happen per turn, as the awaited closure they replace did.
    runProviderTurn: (prompt, signal) => {
      const forkSession = isFirstTurn && params.forkSession;
      return runStreamedTurn({
        prompt,
        logger,
        signal,
        model: params.run.model,
        permissionMode: params.permissionMode,
        effort: params.run.effort,
        thinking: params.run.thinking,
        cwd: params.cwd,
        additionalDirectories: params.additionalDirectories,
        env: params.env,
        resumeSessionId,
        forkSession,
        pathToClaudeCodeExecutable: params.pathToClaudeCodeExecutable,
      }).pipe(
        Effect.map((turn) => {
          isFirstTurn = false;
          if (forkSession && turn.isError) {
            resumeSessionId = undefined;
          } else if (turn.sessionId) {
            resumeSessionId = turn.sessionId;
          }
          return turn;
        }),
      );
    },
    resolveSessionIds: (turn) => [fallbackSessionId, turn.sessionId],
    getUsage: (turn) => turn.usage,
    isTurnError: (turn) => turn.isError,
    turnErrorMessage: (turn) => turn.errorMessage || undefined,
    formatDelivery: (turn, wallTimeMs, lastPrompt) =>
      formatDelivery({
        tag: DELIVERY_TAG.claudeAgentResult,
        runId,
        prompt: lastPrompt,
        attributes: [{ name: 'session-id', value: turn.sessionId || null }],
        wallTime: `${(wallTimeMs / 1000).toFixed(1)}s`,
        response: turn.finalResponse,
        usage: turn.usage,
        lines: claudeCostLines(turn),
      }),
    formatError: (turn, err, lastPrompt) =>
      formatDelivery({
        tag: DELIVERY_TAG.claudeAgentError,
        runId,
        prompt: lastPrompt,
        lines: turn ? claudeCostLines(turn) : undefined,
        message: toErrorMessage(
          err ?? turn?.errorMessage ?? turn?.finalResponse,
        ),
      }),
    continueWith: [CLAUDE_AGENT_NAME, 'session_id', fallbackSessionId],
  });
}

// ============================================================================
// Tool
// ============================================================================

const run = Effect.fn('ClaudeAgentTool.run')(function* (
  input: ClaudeAgentInput,
): Effect.fn.Return<
  ToolResult,
  ToolError,
  | Secrets
  | ToolContext
  | ClaudeAgentSessions
  | ChildProcessSpawner
  | FileSystem.FileSystem
> {
  const toolCall = yield* ToolContext;
  const { roots } = toolCall.env;
  const permissionMode = yield* claudeAgentPermissionMode(input, roots);
  const claudeRun = yield* readClaudeCodeRun(roots, input);
  const sessionId = input.session_id ?? undefined;
  const isFork = input.fork_session === true;

  return yield* dispatchAgentCliTool({
    toolCall,
    agentName: CLAUDE_AGENT_NAME,
    store: ClaudeAgentSessions,
    // A fork always launches a distinct TeXRA child. Queueing onto the
    // source session would mutate the original instead of branching it.
    resumeId: isFork ? undefined : sessionId,
    sourceId: isFork ? sessionId : undefined,
    prompt: input.prompt,
    labels: {
      notActiveLabel: 'Claude Code CLI session',
      idParamName: 'session_id',
      summaryLabel: 'Claude Code CLI',
      queuedLabel: 'Claude Code session',
    },
    launch: (context) =>
      launchClaudeAgentSession(input, permissionMode, claudeRun, context),
  });
});

export const ClaudeAgentTool = defineTool({
  name: CLAUDE_AGENT_NAME,
  requiresApproval: true,
  description:
    'Spin off a Claude Code agent (via @anthropic-ai/claude-agent-sdk) to perform code analysis, generation, or research. ' +
    'The agent runs the native `claude` binary locally and can read files, run commands, and make edits within its permission mode. ' +
    'Requires the Claude Code CLI (auto-installed with @anthropic-ai/claude-agent-sdk, or via `npm install -g @anthropic-ai/claude-code`). ' +
    'Auth: ANTHROPIC_API_KEY (via TeXRA Settings → API Keys or env var), CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`), or `claude login` OAuth session. ' +
    'Always async: returns immediately with a run ID; each turn is delivered back as a follow-up message (including the session_id). ' +
    'Pass session_id on a later call to send a follow-up to an existing session, like executions send to an `agent` subagent. ' +
    'Set fork_session to branch from that session while leaving the original unchanged. Choose claude_code for coding tasks that benefit from a separate Anthropic Claude Code agent. It runs in its own workspace with independent file editing, search, and shell access, async and multi-turn like `agent`. codex and claude_code are both independent sandboxed coders distinct from the in-process `agent` specialists. Prefer whichever vendor fits the task, and for parallel or isolated edits run them against a git worktree.',
  schema: ClaudeAgentInputSchema,
  guard: {
    bash: (input: ClaudeAgentInput) =>
      agentCliApprovalCommand(CLAUDE_AGENT_NAME, input.prompt, (stores) =>
        claudeAgentPermissionMode(input, stores),
      ),
  },
  execute: run,
});

const launchClaudeAgentSession = Effect.fn(
  'claudeAgent.launchClaudeAgentSession',
)(function* (
  input: ClaudeAgentInput,
  permissionMode: ClaudeAgentPermissionMode,
  claudeRun: ClaudeCodeRun,
  context: AgentCliLaunchContext,
): Effect.fn.Return<
  ToolResult,
  ToolError,
  Secrets | ToolContext | ChildProcessSpawner | FileSystem.FileSystem
> {
  const config = yield* getClaudeAgentConfig;
  const { roots } = (yield* ToolContext).env;
  // Mirrors codex so subagents can see the project: a call from inside the
  // workspace runs in that directory with read access to the workspace root
  // for sibling files; an out-of-workspace cwd runs isolated. The SDK's
  // `Options` names these `cwd` / `additionalDirectories`, unlike codex.
  const { workingDirectory, additionalDirectories } =
    buildAgentWorkspaceOptions(roots.workspace, context.parentWorkingDirectory);
  // The env block reads the process environment and `Secrets`: no workspace.
  const env = yield* config
    .buildClaudeAgentEnv()
    .pipe(
      Effect.mapError(
        (failure) =>
          new ToolError(
            `Could not read the managed Anthropic API key: ${failure.message}`,
            { cause: failure },
          ),
      ),
    );
  const pathToClaudeCodeExecutable = yield* findClaudeBinaryPath().pipe(
    Effect.orDie,
  );
  return yield* launchAgentCliSession({
    resumeId: input.fork_session ? undefined : (input.session_id ?? undefined),
    agentName: CLAUDE_AGENT_NAME,
    prompt: input.prompt,
    modelRef: claudeRun.ref,
    registerFailedMessage: 'Failed to register Claude Code CLI run.',
    buildLaunch: ({ logger, runId }) =>
      buildClaudeAgentLaunch({
        logger,
        runId,
        initialPrompt: input.prompt,
        run: claudeRun,
        permissionMode,
        cwd: workingDirectory,
        additionalDirectories,
        env,
        pathToClaudeCodeExecutable,
        resumeSessionId: input.session_id ?? undefined,
        forkSession: input.fork_session === true,
        releaseFallbackClaim: context.releaseFallbackClaim,
        registry: context.registry,
      }),
    summaryLabel: 'Claude Code CLI',
    launchedLine: `Claude Code agent launched (model: ${claudeRun.ref}, effort: ${claudeRun.effort ?? 'none'}, permission: ${permissionMode}).${claudeRun.note ? ` ${claudeRun.note}` : ''}`,
    followUpLine: `Result will be delivered as a follow-up message when the turn completes. The delivery includes the session_id. Pass it back on a later call to send a follow-up.`,
  });
});
