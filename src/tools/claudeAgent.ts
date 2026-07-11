/**
 * Claude Code CLI tool — spin off a Claude Code agent via @anthropic-ai/claude-agent-sdk.
 *
 * Mirrors the codex / delegate_agent model: every call is async. Without a
 * session_id, a new Claude Code session is started and the result is delivered
 * as a follow-up to the parent stream. With a session_id, the prompt is
 * enqueued as a follow-up instruction to an existing session via the SDK's
 * `resume:` option (or via streaming-input on the live session). Each turn's
 * result is delivered back to the parent's follow-up queue, so the
 * orchestrator sees responses uniformly whether it or the user drove the turn.
 *
 * Authentication: the SDK spawns the Claude Code CLI as a subprocess, which
 * picks up whichever auth the user has configured:
 *   - ANTHROPIC_API_KEY env var (or stored in TeXRA Settings → API Keys)
 *   - CLAUDE_CODE_OAUTH_TOKEN env var (long-lived OAuth token from
 *     `claude setup-token`)
 *   - OAuth session from `claude login` (Pro/Max subscription)
 *   - Bedrock / Vertex (configured via CLI/env vars)
 *
 * Requires the native `claude` CLI binary — gated by the availability check
 * in externalToolDefs.ts.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import {
  emitToolUseCard,
  endToolUseCard,
  type AgentTrace,
  type ToolUseCardRef,
} from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  startChildRunLoop,
  type ChildRunPorts,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import {
  getRunContextExecutionId,
  getRunContextStreamId,
  getRunContextWorkingDirectory,
} from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import type { StreamTabId, ExecutionId, ToolUseLog } from '@shared/schemas';
import { MESSAGE_TYPES } from '@shared/schemas';
import { type ToolResult } from '@shared/schemas/toolResult';
import { requireRunStream } from '@tools/contextHelpers';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { formatWallTimeSeconds, isNonEmptyString } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { buildAgentWorkspaceOptions } from './agentWorkspaceOptions';
import {
  importClaudeAgentSdk,
  findClaudeBinaryPath,
} from './claudeAgentImport';
import { type ChildStream } from './childStream';
import { ClaudeAgentSessions } from './agentCliSessionStores';
import {
  publishAgentCliStreamUsage,
  launchAgentCliSession,
  resumeAgentCliSession,
  withAgentCliApproval,
} from './agentCliShared';
import {
  formatChildRunDelivery,
  formatChildRunError,
} from './deliveryEnvelope';
import {
  buildClaudeToolUseLog,
  buildClaudeUsageStats,
  CLAUDE_AGENT_EFFORT_LEVELS,
  CLAUDE_AGENT_NAME,
  CLAUDE_AGENT_PERMISSION_MODES,
  modelSupportsAdaptiveThinking,
  type ClaudeAgentEffort,
  type ClaudeAgentPermissionMode,
  type ClaudeMessageBlock,
} from './claudeAgentShared';
import type { Options as ClaudeAgentSdkOptions } from '@anthropic-ai/claude-agent-sdk';

let _configModule: typeof import('./claudeAgentConfig') | null = null;
async function getClaudeAgentConfig(): Promise<
  typeof import('./claudeAgentConfig')
> {
  return (_configModule ??= await import('./claudeAgentConfig'));
}

// ============================================================================
// Schema
// ============================================================================

const ClaudeAgentInputSchema = z.strictObject({
  prompt: z
    .string()
    .describe(
      'Instruction for the Claude Code agent. For a new session, describe the task. For a resume (session_id set), describe the follow-up.',
    ),
  permission_mode: z
    .enum(CLAUDE_AGENT_PERMISSION_MODES)
    .nullish()
    .describe(
      'Permission behavior for the agent (defaults to user-configured mode, typically acceptEdits).',
    ),
  model: z
    .string()
    .nullish()
    .describe(
      "Claude model to use (e.g. 'claude-sonnet-4-6', 'claude-fable-5', 'claude-opus-4-8'). Defaults to user-configured model.",
    ),
  effort: z
    .enum(CLAUDE_AGENT_EFFORT_LEVELS)
    .nullish()
    .describe(
      'Reasoning depth hint passed to the SDK (defaults to user-configured effort, typically high).',
    ),
  session_id: z
    .string()
    .nullish()
    .describe(
      'Resume an existing Claude Code session with a follow-up instruction. The prompt is enqueued as the next turn; if the session is currently processing, the prompt waits in its queue.',
    ),
});

export type ClaudeAgentInput = z.infer<typeof ClaudeAgentInputSchema>;

// ============================================================================
// Result formatting
// ============================================================================

interface TurnResult {
  finalResponse: string;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
  sessionId: string | undefined;
  totalCostUsd?: number;
  isError: boolean;
  errorMessage?: string;
}

function formatClaudeDelivery(
  executionId: string,
  prompt: string,
  wallTimeMs: number,
  turn: TurnResult,
): string {
  const extraLines =
    typeof turn.totalCostUsd === 'number' && turn.totalCostUsd > 0
      ? [`<cost-usd>${turn.totalCostUsd.toFixed(4)}</cost-usd>`]
      : undefined;
  return formatChildRunDelivery(
    {
      tag: DELIVERY_TAG.claudeAgentResult,
      executionId,
      prompt,
      attributes: [{ name: 'session-id', value: turn.sessionId || null }],
    },
    {
      wallTime: formatWallTimeSeconds(wallTimeMs),
      response: turn.finalResponse,
      usage: turn.usage
        ? {
            input: turn.usage.input_tokens ?? 0,
            output: turn.usage.output_tokens ?? 0,
          }
        : null,
      lines: extraLines,
    },
  );
}

// ============================================================================
// Stream tab helpers
// ============================================================================

type ClaudeToolLogRef = ToolUseCardRef & {
  toolLog: ToolUseLog;
};

// ============================================================================
// SDK type aliases — we keep these loose to avoid pulling the SDK's full type
// surface (which depends on a private @anthropic-ai/sdk MessageParam shape)
// into VS Code-free zones.
// ============================================================================

interface SdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ClaudeMessageBlock[] };
  parent_tool_use_id?: string | null;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: TurnResult['usage'];
}

// ============================================================================
// Streamed turn — drains the SDK's async generator into log entries + a
// TurnResult for follow-up delivery.
// ============================================================================

export async function runStreamedTurn(params: {
  prompt: string;
  childStreamId: StreamTabId;
  logger: AgentTrace;
  abortController: AbortController;
  model: string;
  permissionMode: ClaudeAgentPermissionMode;
  effort: ClaudeAgentEffort;
  cwd: string | undefined;
  additionalDirectories: string[] | undefined;
  env: NodeJS.ProcessEnv;
  resumeSessionId: string | undefined;
  pathToClaudeCodeExecutable: string | undefined;
}): Promise<TurnResult> {
  const { logger, prompt } = params;
  logger.info(prompt, { messageType: MESSAGE_TYPES.USER_MESSAGE });

  const query = await importClaudeAgentSdk();

  const sdkOptions: ClaudeAgentSdkOptions = {
    abortController: params.abortController,
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
  if (params.pathToClaudeCodeExecutable) {
    sdkOptions.pathToClaudeCodeExecutable = params.pathToClaudeCodeExecutable;
  }

  const stream = query({ prompt, options: sdkOptions });
  const responseParts: string[] = [];
  const toolLogRefs = new Map<string, ClaudeToolLogRef>();
  let usage: TurnResult['usage'] = null;
  let sessionId: string | undefined;
  let totalCostUsd: number | undefined;
  let isError = false;
  let errorMessage: string | undefined;

  for await (const raw of stream as AsyncIterable<SdkMessage>) {
    if (raw.session_id) sessionId = raw.session_id;

    if (raw.type === 'assistant' && raw.message?.content) {
      handleAssistantBlocks(
        raw.message.content,
        logger,
        toolLogRefs,
        responseParts,
      );
      continue;
    }
    if (raw.type === 'user' && raw.message?.content) {
      handleToolResults(raw.message.content, logger, toolLogRefs);
      continue;
    }
    if (raw.type === 'result') {
      usage = raw.usage ?? null;
      totalCostUsd = raw.total_cost_usd;
      if (raw.subtype === 'success') {
        if (isNonEmptyString(raw.result)) {
          responseParts.push(raw.result);
        }
      } else {
        isError = true;
        errorMessage = raw.result ?? raw.subtype ?? 'Claude Code error';
      }
      continue;
    }
    if (raw.type === 'system' && raw.subtype === 'init' && raw.session_id) {
      logger.info(`Claude session ${raw.session_id} started`);
    }
  }

  return {
    finalResponse: responseParts.join('\n\n'),
    usage,
    sessionId,
    totalCostUsd,
    isError,
    errorMessage,
  };
}

function handleAssistantBlocks(
  blocks: ClaudeMessageBlock[],
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
  blocks: ClaudeMessageBlock[],
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
        isError: true,
      }),
    };
    endToolUseCard(logger, ref, { ...baseLog, ...update });
    refs.delete(id);
  }
}

function extractToolErrorMessage(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block != null && typeof block === 'object' && 'text' in block) {
      const text = (block as { text: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return undefined;
}

// ============================================================================
// Session loop — drains follow-ups, runs turns, delivers results to parent
// ============================================================================

function startClaudeAgentLoop(params: {
  childStream: ChildStream;
  parentStreamId: StreamTabId;
  executionId: ExecutionId;
  initialPrompt: string;
  model: string;
  permissionMode: ClaudeAgentPermissionMode;
  effort: ClaudeAgentEffort;
  cwd: string | undefined;
  additionalDirectories: string[] | undefined;
  env: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable: string | undefined;
  runtimeHost: AgentRuntimeHost;
  /**
   * Set when this launch is the disk-based fallback for a session_id the
   * in-memory registry no longer knows about (extension reload, crash):
   * seeds the first turn's `resume` option so the SDK continues the prior
   * conversation, and is registered up front (onSessionStart) so the
   * in-memory guard picks the id back up as soon as possible. This narrows,
   * but does not fully close, the window for a concurrent call with the same
   * stale session_id to also observe an inactive registry and start its own
   * fallback loop before either one's onSessionStart runs — the same
   * await-before-registration gap codex.ts's registerThread already has.
   */
  resumeSessionId: string | undefined;
}): void {
  const {
    childStream,
    parentStreamId,
    executionId,
    initialPrompt,
    runtimeHost,
  } = params;
  const { childStreamId, logger } = childStream;

  // The SDK needs the prior session id to resume the same conversation across
  // turns; it's threaded forward from each turn's result. Seeded from
  // params.resumeSessionId when this launch is a disk-based fallback resume.
  let resumeSessionId: string | undefined = params.resumeSessionId;
  const fallbackSessionId = params.resumeSessionId;
  const storedSessionIds = new Set<string>();

  const registerSession = (sessionId: string, session: SessionHandle): void => {
    if (ClaudeAgentSessions.isActive(sessionId)) return;
    ClaudeAgentSessions.register(sessionId, {
      childStreamId,
      parentStreamId,
      executionId,
      executions: session.executions,
      model: params.model,
      permissionMode: params.permissionMode,
      effort: params.effort,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories,
    });
    storedSessionIds.add(sessionId);
  };
  // The joined prompt text for whichever turn is currently in flight —
  // captured here (rather than threaded through the loop contract) since
  // `formatDelivery`/`formatError` run strictly after the turn that set it.
  let lastPrompt = initialPrompt;

  const runTurn = async (
    followUps: readonly FollowUpQueueBatchItem[],
    _ports: ChildRunPorts,
    abortController: AbortController,
  ): Promise<TurnResult> => {
    lastPrompt = followUps.map((f) => f.text).join('\n\n');
    const turn = await runStreamedTurn({
      prompt: lastPrompt,
      childStreamId,
      logger,
      abortController,
      model: params.model,
      permissionMode: params.permissionMode,
      effort: params.effort,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories,
      env: params.env,
      resumeSessionId,
      pathToClaudeCodeExecutable: params.pathToClaudeCodeExecutable,
    });
    if (turn.sessionId) resumeSessionId = turn.sessionId;
    return turn;
  };

  const strategy: ChildRunStrategy<TurnResult> = {
    stageLabel: 'Claude Code session',
    onSessionStart: fallbackSessionId
      ? (session) => registerSession(fallbackSessionId, session)
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
    isTurnError: (turn) => turn.isError,
    onTurnError: (turn, log) => {
      if (turn.errorMessage) log.error(turn.errorMessage);
    },
    onTurnSuccess: (turn, session) => {
      if (turn.sessionId) registerSession(turn.sessionId, session);
    },
    publishUsage: (turn) => {
      if (turn.usage) {
        publishAgentCliStreamUsage(
          childStreamId,
          executionId,
          buildClaudeUsageStats(turn.usage),
          logger,
        );
      }
    },
    formatDelivery: (turn, wallTimeMs) =>
      formatClaudeDelivery(executionId, lastPrompt, wallTimeMs, turn),
    formatError: (turn, err) =>
      formatChildRunError(
        { tag: DELIVERY_TAG.claudeAgentError, executionId, prompt: lastPrompt },
        {
          message: toErrorMessage(
            err ?? turn?.errorMessage ?? turn?.finalResponse,
          ),
        },
      ),
    onSessionCleanup: () => {
      ClaudeAgentSessions.releaseMany(storedSessionIds);
    },
  };

  startChildRunLoop({
    childStream,
    childStreamId,
    parentStreamId,
    executionId,
    agentName: CLAUDE_AGENT_NAME,
    strategy,
  });
}

// ============================================================================
// Tool
// ============================================================================

export class ClaudeAgentTool extends defineTool({
  name: CLAUDE_AGENT_NAME,
  description:
    'Spin off a Claude Code agent (via @anthropic-ai/claude-agent-sdk) to perform code analysis, generation, or research. ' +
    'The agent runs the native `claude` binary locally and can read files, run commands, and make edits within its permission mode. ' +
    'Requires the Claude Code CLI (auto-installed with @anthropic-ai/claude-agent-sdk, or via `npm install -g @anthropic-ai/claude-code`). ' +
    'Auth: ANTHROPIC_API_KEY (via TeXRA Settings → API Keys or env var), CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`), or `claude login` OAuth session. ' +
    'Always async: returns immediately with an execution ID; each turn is delivered back as a follow-up message (including the session_id). ' +
    'Pass session_id on a later call to send a follow-up to an existing session — mirrors delegate_agent(execution_id=…).',
  schema: ClaudeAgentInputSchema,
}) {
  protected async execute(input: ClaudeAgentInput): Promise<ToolResult> {
    const config = await getClaudeAgentConfig();
    const permissionMode =
      input.permission_mode ?? config.getClaudeAgentPermissionMode();
    const model = input.model ?? config.getClaudeAgentModel();
    const effort = input.effort ?? config.getClaudeAgentEffort();

    return withAgentCliApproval(
      `[${CLAUDE_AGENT_NAME} ${permissionMode}] ${input.prompt}`,
      (runContext) => {
        if (
          input.session_id &&
          ClaudeAgentSessions.isActive(input.session_id)
        ) {
          return resumeAgentCliSession(ClaudeAgentSessions, {
            id: input.session_id,
            prompt: input.prompt,
            callerStreamId: getRunContextStreamId(runContext),
            labels: {
              notActiveLabel: 'Claude Code CLI session',
              idParamName: 'session_id',
              summaryLabel: 'Claude Code CLI',
              queuedLabel: 'Claude Code session',
            },
          });
        }
        // Fall through when the session's in-memory loop is gone (extension
        // reload, crash): launchClaudeAgentSession resumes via the SDK's
        // `resume` option from disk.
        const { streamId, runtimeHost } = requireRunStream(
          CLAUDE_AGENT_NAME,
          runContext,
        );
        return launchClaudeAgentSession(
          input,
          permissionMode,
          model,
          effort,
          streamId,
          getRunContextExecutionId(runContext),
          getRunContextWorkingDirectory(runContext),
          runtimeHost,
        );
      },
    );
  }
}

async function launchClaudeAgentSession(
  input: ClaudeAgentInput,
  permissionMode: ClaudeAgentPermissionMode,
  model: string,
  effort: ClaudeAgentEffort,
  parentStreamId: StreamTabId,
  parentExecutionId: ExecutionId | undefined,
  parentWorkingDirectory: string | undefined,
  runtimeHost: AgentRuntimeHost,
): Promise<ToolResult> {
  const config = await getClaudeAgentConfig();
  const workingDir = parseWorkingDirectory(parentWorkingDirectory);
  // Mirrors codex behavior so subagents can see the project: when the call
  // is made from inside the workspace, the agent runs in that directory but
  // is also granted read access to the workspace root so it can inspect
  // sibling files. Out-of-workspace cwds run isolated (matches codex). The
  // claude-agent-sdk's `Options` type names these fields `cwd` /
  // `additionalDirectories`, unlike codex's `workingDirectory`.
  const resolvedWorkspace = buildAgentWorkspaceOptions(workingDir);
  const workspace = {
    cwd: resolvedWorkspace.workingDirectory,
    additionalDirectories: resolvedWorkspace.additionalDirectories,
  };
  const env = await config.buildClaudeAgentEnv();
  const agentConfig = config.buildClaudeAgentConfig(input.prompt);
  const preview = truncateWithEllipsis(input.prompt, 60);

  return launchAgentCliSession({
    parentStreamId,
    parentExecutionId,
    runtimeHost,
    agentName: CLAUDE_AGENT_NAME,
    streamPrefix: 'claude@agent-sdk',
    description: input.prompt,
    config: agentConfig,
    registerFailedMessage: 'Failed to register Claude Code CLI execution.',
    startLoop: async ({ childStream, executionId }) =>
      startClaudeAgentLoop({
        childStream,
        parentStreamId,
        executionId,
        initialPrompt: input.prompt,
        model,
        permissionMode,
        effort,
        cwd: workspace.cwd,
        additionalDirectories: workspace.additionalDirectories,
        env,
        pathToClaudeCodeExecutable: await findClaudeBinaryPath(),
        runtimeHost,
        resumeSessionId: input.session_id ?? undefined,
      }),
    summary: `Launched Claude Code CLI: ${preview}`,
    launchedLine: `Claude Code agent launched (model: ${model}, permission: ${permissionMode}).`,
    followUpLine: `Result will be delivered as a follow-up message when the turn completes. The delivery includes the session_id — pass it back on a later call to send a follow-up.`,
  });
}
