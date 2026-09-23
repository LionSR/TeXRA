/**
 * Claude Code CLI tool — spin off a Claude Code agent via @anthropic-ai/claude-agent-sdk.
 *
 * Mirrors the codex / delegate_agent model: every call is async. Without a
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
 * Requires the native `claude` CLI, checked in externalToolDefs.ts.
 */

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import {
  emitToolUseCard,
  endToolUseCard,
  type AgentTrace,
  type ToolUseCardRef,
} from '@agent/trace';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import type { Runs } from '@agent/runtime/runRegistry';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import type { AgentResume } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import {
  ClaudeAgentEffortSchema,
  ClaudeAgentPermissionModeSchema,
  MESSAGE_TYPES,
} from '@shared/schemas';
import type {
  ClaudeAgentEffort,
  ClaudeAgentPermissionMode,
  RunId,
  ToolResult,
  ToolUseLog,
} from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { buildSyntheticToolUseConfig } from '@tools/core/syntheticAgentConfig';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { linkAbortSignals } from '@utils/core';
import {
  formatWallTimeSeconds,
  isNonEmptyString,
  previewLabel,
} from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { defineTool } from './core/define';
import { buildAgentWorkspaceOptions } from './agentWorkspaceOptions';
import { ClaudeBackgroundTaskTracker } from './claudeAgentBackgroundTasks';
import {
  claudeAgentPermissionMode,
  getClaudeAgentConfig,
  importClaudeAgentSdk,
  findClaudeBinaryPath,
} from './claudeAgentImport';
import { type ChildRun } from './delegation/childRun';
import { claudeAgentSessionsFor } from './agentCliSessionStores';
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
  aggregateClaudeModelUsage,
  buildClaudeToolUseLog,
  CLAUDE_AGENT_NAME,
  modelSupportsAdaptiveThinking,
  type ClaudeTurnUsage,
} from './claudeAgentShared';
import type { DetachedChildRunLaunch } from './delegation/detachedChildRun';

// Third-party type imports (import/order places these after local imports)
import type {
  Options as ClaudeAgentSdkOptions,
  SDKAssistantMessage,
  SDKUserMessage,
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
        "Claude model to use (e.g. 'claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5-5'). Defaults to user-configured model.",
      ),
    effort: ClaudeAgentEffortSchema.nullish().describe(
      'Reasoning depth hint passed to the SDK (defaults to user-configured effort, typically high).',
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

export type ClaudeAgentInput = z.infer<typeof ClaudeAgentInputSchema>;

// ============================================================================
// Result formatting
// ============================================================================

interface TurnResult {
  finalResponse: string;
  usage: ClaudeTurnUsage | null;
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
// Tool log helpers
// ============================================================================

type ClaudeToolLogRef = ToolUseCardRef & {
  toolLog: ToolUseLog;
};

// ============================================================================
// Streamed turn — drains the SDK's async generator into log entries + a
// TurnResult for follow-up delivery.
// ============================================================================

export function runStreamedTurn(params: {
  prompt: string;
  logger: AgentTrace;
  signal: AbortSignal;
  model: string;
  permissionMode: ClaudeAgentPermissionMode;
  effort: ClaudeAgentEffort;
  cwd: string | undefined;
  additionalDirectories: string[] | undefined;
  env: NodeJS.ProcessEnv;
  resumeSessionId: string | undefined;
  forkSession?: boolean;
  pathToClaudeCodeExecutable: string | undefined;
}): Effect.Effect<TurnResult, Error> {
  // Draining `query()` is this module's foreign edge: the whole drain is
  // wrapped here exactly once, and the abort link that follows the turn's
  // signal lives inside it. Loading the SDK is the importer's own edge.
  return Effect.gen(function* () {
    const { logger, prompt } = params;
    logger.info(prompt, { messageType: MESSAGE_TYPES.USER_MESSAGE });

    const query = yield* importClaudeAgentSdk();

    return yield* Effect.tryPromise({
      try: async (): Promise<TurnResult> => {
        // The SDK takes a controller, not a signal: this one exists only at that
        // boundary and follows the turn's signal until the stream is drained.
        const abortController = new AbortController();
        const detachAbort = linkAbortSignals([params.signal], abortController);
        const sdkOptions: ClaudeAgentSdkOptions = {
          abortController,
          model: params.model,
          permissionMode: params.permissionMode,
          effort: params.effort,
          env: params.env,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project', 'local'],
        };
        if (modelSupportsAdaptiveThinking(params.model)) {
          sdkOptions.thinking = { type: 'adaptive' };
        }
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
          sdkOptions.pathToClaudeCodeExecutable =
            params.pathToClaudeCodeExecutable;
        }

        const responseParts: string[] = [];
        const toolLogRefs = new Map<string, ClaudeToolLogRef>();
        const backgroundTasks = new ClaudeBackgroundTaskTracker(logger);
        let usage: TurnResult['usage'] = null;
        let sessionId: string | undefined;
        let totalCostUsd: number | undefined;
        let isError = false;
        let errorMessage: string | undefined;

        try {
          const stream = query({ prompt, options: sdkOptions });
          for await (const raw of stream) {
            if ('session_id' in raw && raw.session_id)
              sessionId = raw.session_id;

            switch (raw.type) {
              case 'assistant':
                handleAssistantBlocks(
                  raw.message.content,
                  logger,
                  toolLogRefs,
                  responseParts,
                );
                break;
              case 'user':
                if (Array.isArray(raw.message.content)) {
                  handleToolResults(raw.message.content, logger, toolLogRefs);
                }
                break;
              case 'result':
                usage =
                  raw.modelUsage == null
                    ? (raw.usage ?? null)
                    : aggregateClaudeModelUsage(raw.modelUsage);
                totalCostUsd = raw.total_cost_usd;
                if (raw.subtype === 'success') {
                  if (isNonEmptyString(raw.result)) {
                    responseParts.push(raw.result);
                  }
                } else {
                  isError = true;
                  errorMessage =
                    raw.errors?.join('\n') ||
                    raw.subtype ||
                    'Claude Code error';
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
          }
        } finally {
          detachAbort();
          backgroundTasks.finish();
        }

        if (
          params.forkSession &&
          (!sessionId || sessionId === params.resumeSessionId)
        ) {
          isError = true;
          errorMessage = [
            errorMessage,
            'Claude Code fork did not create a distinct session',
          ]
            .filter(isNonEmptyString)
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
      },
      catch: ensureError,
    });
  });
}

function handleAssistantBlocks(
  blocks: SDKAssistantMessage['message']['content'],
  logger: AgentTrace,
  refs: Map<string, ClaudeToolLogRef>,
  responseParts: string[],
): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (isNonEmptyString(block.text)) {
          logger.info(block.text, {
            messageType: MESSAGE_TYPES.MODEL_RESPONSE,
          });
          responseParts.push(block.text);
        }
        break;
      case 'thinking':
        if (isNonEmptyString(block.thinking)) {
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
        });
        refs.set(block.id, { ...emitToolUseCard(logger, toolLog), toolLog });
        break;
      }
    }
  }
}

function handleToolResults(
  blocks: Exclude<SDKUserMessage['message']['content'], string>,
  logger: AgentTrace,
  refs: Map<string, ClaudeToolLogRef>,
): void {
  for (const block of blocks) {
    if (block.type !== 'tool_result') continue;
    const id = block.tool_use_id;
    if (typeof id !== 'string') continue;
    const ref = refs.get(id);
    if (!ref) continue;

    const isError = block.is_error === true;
    const { status: _status, ...baseLog } = ref.toolLog;
    const update: Partial<ToolUseLog> = {
      ...(block.content !== undefined && {
        output: block.content as ToolUseLog['output'],
      }),
      ...(isError && {
        error: extractToolErrorMessage(block.content) ?? 'Tool error',
      }),
    };
    endToolUseCard(
      logger,
      ref,
      { ...baseLog, ...update },
      isError ? 'failed' : 'completed',
    );
    refs.delete(id);
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
  childRun: ChildRun;
  runId: RunId;
  initialPrompt: string;
  model: string;
  permissionMode: ClaudeAgentPermissionMode;
  effort: ClaudeAgentEffort;
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
}): Effect.Effect<DetachedChildRunLaunch<TurnResult>, never, Runs> {
  const { childRun, runId, initialPrompt } = params;
  const { logger } = childRun;

  // The SDK needs the prior session id to resume the same conversation across
  // turns; it's threaded forward from each turn's result. Seeded from
  // params.resumeSessionId when this launch is a disk-based fallback resume.
  let resumeSessionId: string | undefined = params.resumeSessionId;
  let isFirstTurn = true;
  const fallbackSessionId = params.forkSession
    ? undefined
    : params.resumeSessionId;

  return buildAgentCliLaunch({
    childRun,
    runId,
    stageLabel: 'Claude Code session',
    initialPrompt,
    store: claudeAgentSessionsFor,
    releaseFallbackClaim: params.releaseFallbackClaim,
    // The shared loop calls this inside its own `Effect.suspend`, so the
    // reads below happen per turn, as the awaited closure they replace did.
    runProviderTurn: (prompt, _ports, signal) => {
      const forkSession = isFirstTurn && params.forkSession;
      return runStreamedTurn({
        prompt,
        logger,
        signal,
        model: params.model,
        permissionMode: params.permissionMode,
        effort: params.effort,
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
    buildUsageStats: (turn) =>
      turn.usage
        ? {
            inputTokens: turn.usage.input_tokens ?? 0,
            outputTokens: turn.usage.output_tokens ?? 0,
            cost: turn.usage.cost_usd ?? 0,
            ...(turn.usage.cache_read_input_tokens != null &&
              turn.usage.cache_read_input_tokens > 0 && {
                cacheReadInputTokens: turn.usage.cache_read_input_tokens,
              }),
            ...(turn.usage.cache_creation_input_tokens != null &&
              turn.usage.cache_creation_input_tokens > 0 && {
                cacheCreationInputTokens:
                  turn.usage.cache_creation_input_tokens,
              }),
          }
        : undefined,
    isTurnError: (turn) => turn.isError,
    turnErrorMessage: (turn) => turn.errorMessage || undefined,
    formatDelivery: (turn, wallTimeMs, lastPrompt) =>
      formatDelivery({
        tag: DELIVERY_TAG.claudeAgentResult,
        runId,
        prompt: lastPrompt,
        attributes: [{ name: 'session-id', value: turn.sessionId || null }],
        wallTime: formatWallTimeSeconds(wallTimeMs),
        response: turn.finalResponse,
        usage: toDeliveryUsage(turn.usage),
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
    loopFailedMessage: 'Claude Agent run loop failed after launch',
  });
}

// ============================================================================
// Tool
// ============================================================================

function executeClaudeAgentTool(input: ClaudeAgentInput) {
  return Effect.gen(function* () {
    return yield* reraiseAgentCliCallFailure(run(input, yield* ToolCall));
  });
}

const run = Effect.fn('ClaudeAgentTool.run')(function* (
  input: ClaudeAgentInput,
  toolCall: ToolCallShape,
): Effect.fn.Return<
  ToolResult,
  AgentCliToolFailure,
  Secrets | ToolCall | Runs | AgentResume
> {
  const config = yield* getClaudeAgentConfig;
  const { workspaceState } = toolCall.roots;
  const permissionMode = yield* claudeAgentPermissionMode(
    input,
    workspaceState,
  );
  const model =
    input.model ?? (yield* config.getClaudeAgentModel(workspaceState));
  const effort =
    input.effort ?? (yield* config.getClaudeAgentEffort(workspaceState));
  const sessionId = input.session_id ?? undefined;
  const isFork = input.fork_session === true;

  return yield* dispatchAgentCliTool({
    toolCall,
    agentName: CLAUDE_AGENT_NAME,
    store: claudeAgentSessionsFor,
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
      launchClaudeAgentSession(
        input,
        permissionMode,
        model,
        effort,
        context.parentRunId,
        context.parentWorkingDirectory,
        context.releaseFallbackClaim,
        context.session,
      ),
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
    'Pass session_id on a later call to send a follow-up to an existing session, like delegate_agent(execution_id=…). ' +
    'Set fork_session to branch from that session while leaving the original unchanged.',
  schema: ClaudeAgentInputSchema,
  guard: {
    bash: (input: ClaudeAgentInput) =>
      agentCliApprovalCommand(CLAUDE_AGENT_NAME, input.prompt, (state) =>
        claudeAgentPermissionMode(input, state),
      ),
  },
  execute: executeClaudeAgentTool,
});

const launchClaudeAgentSession = Effect.fn(
  'claudeAgent.launchClaudeAgentSession',
)(function* (
  input: ClaudeAgentInput,
  permissionMode: ClaudeAgentPermissionMode,
  model: string,
  effort: ClaudeAgentEffort,
  parentRunId: RunId,
  parentWorkingDirectory: string | undefined,
  releaseFallbackClaim: (() => void) | undefined,
  session: SessionHandle,
): Effect.fn.Return<
  ToolResult,
  AgentCliToolFailure,
  Secrets | ToolCall | Runs | AgentResume
> {
  const config = yield* getClaudeAgentConfig;
  const { roots } = yield* ToolCall;
  const workingDir = parseWorkingDirectory(parentWorkingDirectory);
  // Mirrors codex behavior so subagents can see the project: when the call
  // is made from inside the workspace, the agent runs in that directory but
  // is also granted read access to the workspace root so it can inspect
  // sibling files. Out-of-workspace cwds run isolated (matches codex). The
  // claude-agent-sdk's `Options` type names these fields `cwd` /
  // `additionalDirectories`, unlike codex's `workingDirectory`.
  const { workingDirectory, additionalDirectories } =
    buildAgentWorkspaceOptions(roots.workspace, workingDir);
  // The env block reads only the process environment and the `Secrets`
  // service, neither of which is workspace-scoped.
  const env = yield* config.buildClaudeAgentEnv();
  const pathToClaudeCodeExecutable = yield* agentCliCall(
    Effect.try({ try: findClaudeBinaryPath, catch: ensureError }),
  );
  // Synthetic run metadata for the child run: the Claude Code CLI runs outside
  // the normal run loop, so the tool-use category and a stable model label are
  // stated here rather than inherited from the generic AgentConfig defaults.
  const agentConfig = buildSyntheticToolUseConfig({
    agent: CLAUDE_AGENT_NAME,
    // Fabricated label, not a routed model: Claude Code drives its own model.
    model: 'claude',
    instruction: input.prompt,
  });
  const preview = previewLabel(input.prompt);

  return yield* launchAgentCliSession({
    session,
    parentRunId,
    agentName: CLAUDE_AGENT_NAME,
    description: input.prompt,
    config: agentConfig,
    registerFailedMessage: 'Failed to register Claude Code CLI run.',
    buildLaunch: ({ childRun, runId }) =>
      buildClaudeAgentLaunch({
        childRun,
        runId,
        initialPrompt: input.prompt,
        model,
        permissionMode,
        effort,
        cwd: workingDirectory,
        additionalDirectories,
        env,
        pathToClaudeCodeExecutable,
        resumeSessionId: input.session_id ?? undefined,
        forkSession: input.fork_session === true,
        releaseFallbackClaim,
      }),
    summary: `Launched Claude Code CLI: ${preview}`,
    launchedLine: `Claude Code agent launched (model: ${model}, permission: ${permissionMode}).`,
    followUpLine: `Result will be delivered as a follow-up message when the turn completes. The delivery includes the session_id. Pass it back on a later call to send a follow-up.`,
  });
});
