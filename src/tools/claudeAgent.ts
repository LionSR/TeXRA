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
  getExecutionStore,
  registerExecution,
  writeTerminalStatus,
} from '@agent/storage';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { untrackExecution } from '@agent/runtime/executionRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { getCurrentToolContexts } from '@agent/toolUse/ToolFileInteractionContext';
import {
  getInterruptible,
  registerInterruptible,
  unregisterInterruptible,
  type IInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { FollowUpQueue } from '@agent/toolUse/FollowUpQueue';
import { toErrorMessage } from '@common/errors';
import { AgentLogger } from '@logger/AgentLogger';
import type {
  StreamTabId,
  ExecutionId,
  StorageKey,
  StreamStatus,
  TokenUsageStats,
  ToolUseLog,
} from '@shared/schemas';
import { MESSAGE_TYPES, STREAM_STATUS } from '@shared/schemas';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { ToolError, type ToolResult } from '@tools/result';
import { parseWorkingDirectory } from '@tools/pathResolution';
import {
  requestBashApproval,
  buildBashApprovalRejectedResult,
} from '@tools/approval/bashApproval';
import { formatDuration } from '@utils/core';
import { generateExecutionId } from '@utils/core/executionId';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import {
  importClaudeAgentSdk,
  findClaudeBinaryPath,
} from './claudeAgentImport';
import { createChildStream } from './childStream';
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
      "Claude model to use (e.g. 'claude-sonnet-4-6', 'claude-opus-4-7'). Defaults to user-configured model.",
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
// Session registry — keeps sessions alive between turns for follow-ups
// ============================================================================

interface ActiveSession {
  childStreamId: StreamTabId;
  parentStreamId: StreamTabId;
  executionId: ExecutionId;
  model: string;
  permissionMode: ClaudeAgentPermissionMode;
  effort: ClaudeAgentEffort;
  cwd?: string;
  additionalDirectories?: string[];
}

const sessionRegistry = new Map<string, ActiveSession>();

function storeSession(sessionId: string, entry: ActiveSession): void {
  sessionRegistry.set(sessionId, entry);
  void getExecutionStore(entry.executionId)
    .write('claude_code_session_id', sessionId)
    .catch(() => {});
}

export function interruptAllClaudeAgentSessions(): void {
  for (const { childStreamId } of [...sessionRegistry.values()]) {
    getInterruptible(childStreamId)?.interrupt();
  }
}

// ============================================================================
// Interruptible session — runs the SDK query loop and accepts follow-ups
// ============================================================================

class ClaudeAgentSession implements IInterruptible {
  private interrupted = false;
  private queue: FollowUpQueue | null = null;
  private turnAbortController: AbortController | null = null;

  interrupt(): void {
    this.interrupted = true;
    this.queue?.cancelWait();
    this.turnAbortController?.abort();
  }

  setQueue(q: FollowUpQueue): void {
    this.queue = q;
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }

  startTurn(): AbortController {
    this.turnAbortController = new AbortController();
    return this.turnAbortController;
  }

  finishTurn(): void {
    this.turnAbortController = null;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function isCleanInterruption(
  err: unknown,
  signal: AbortSignal,
  session: ClaudeAgentSession,
): boolean {
  return signal.aborted || session.isInterrupted() || isAbortError(err);
}

function isLoopOwnedStatus(status: StreamStatus | undefined): boolean {
  return status === STREAM_STATUS.WAITING || status === STREAM_STATUS.RUNNING;
}

function finalizeClaudeAgentLoopStatus(
  childStreamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
): void {
  if (isLoopOwnedStatus(StreamStatusService.get(childStreamId))) {
    StreamStatusService.set(childStreamId, STREAM_STATUS.READY, {
      runtimeHost,
    });
  }
}

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
  const durationSec = (wallTimeMs / 1000).toFixed(1);
  const response = turn.finalResponse || '(no response)';
  const lines = [
    `<claude-agent-result id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, 200))}"${turn.sessionId ? ` session-id="${escapeAttr(turn.sessionId)}"` : ''}>`,
    `<wall-time>${durationSec}s</wall-time>`,
    `<response>${escapeText(response)}</response>`,
  ];

  if (turn.usage) {
    lines.push(
      `<usage input="${turn.usage.input_tokens ?? 0}" output="${turn.usage.output_tokens ?? 0}" />`,
    );
  }
  if (typeof turn.totalCostUsd === 'number' && turn.totalCostUsd > 0) {
    lines.push(`<cost-usd>${turn.totalCostUsd.toFixed(4)}</cost-usd>`);
  }

  lines.push('</claude-agent-result>');
  return lines.join('\n');
}

function formatClaudeError(
  executionId: string,
  prompt: string,
  err: unknown,
): string {
  return [
    `<claude-agent-error id="${escapeAttr(executionId)}" prompt="${escapeAttr(prompt.slice(0, 200))}">`,
    `<message>${escapeText(toErrorMessage(err))}</message>`,
    '</claude-agent-error>',
  ].join('\n');
}

// ============================================================================
// Stream tab helpers
// ============================================================================

type ClaudeToolLogRef = ReturnType<AgentLogger['emitToolUse']> & {
  toolLog: ToolUseLog;
};

function publishClaudeAgentStreamUsage(
  childStreamId: StreamTabId,
  executionId: ExecutionId,
  usage: TokenUsageStats,
  runtimeHost: AgentRuntimeHost,
): void {
  runtimeHost.emit('updateStreamUsage', {
    streamId: childStreamId,
    storageKey: executionId as StorageKey,
    executionId,
    usage,
  });
}

function logTurnSummary(
  logger: AgentLogger,
  wallTimeMs: number,
  usage: TurnResult['usage'],
): void {
  logger.info(`Turn completed in ${formatDuration(wallTimeMs)}`);
  if (usage) {
    logger.info(
      `Tokens: ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`,
    );
  }
}

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
  logger: AgentLogger;
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

  const sdkOptions: Record<string, unknown> = {
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
        if (typeof raw.result === 'string' && raw.result.length > 0) {
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
  logger: AgentLogger,
  refs: Map<string, ClaudeToolLogRef>,
  responseParts: string[],
): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) {
          logger.info(block.text, {
            messageType: MESSAGE_TYPES.MODEL_RESPONSE,
          });
          responseParts.push(block.text);
        }
        break;
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking.length > 0) {
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
        refs.set(block.id, { ...logger.emitToolUse(toolLog), toolLog });
        break;
      }
    }
  }
}

function handleToolResults(
  blocks: ClaudeMessageBlock[],
  logger: AgentLogger,
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
    logger.updateToolUse(ref.logId, { ...baseLog, ...update }, ref.groupId);
    refs.delete(id);
  }
}

function extractToolErrorMessage(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      block != null &&
      typeof block === 'object' &&
      'text' in block &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return undefined;
}

// ============================================================================
// Session loop — drains follow-ups, runs turns, delivers results to parent
// ============================================================================

function startClaudeAgentLoop(params: {
  childStreamId: StreamTabId;
  parentStreamId: StreamTabId;
  executionId: ExecutionId;
  logger: AgentLogger;
  initialPrompt: string;
  model: string;
  permissionMode: ClaudeAgentPermissionMode;
  effort: ClaudeAgentEffort;
  cwd: string | undefined;
  additionalDirectories: string[] | undefined;
  env: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable: string | undefined;
  runtimeHost: AgentRuntimeHost;
}): void {
  const {
    childStreamId,
    parentStreamId,
    executionId,
    logger,
    initialPrompt,
    runtimeHost,
  } = params;

  const session = new ClaudeAgentSession();
  const queue = ToolUseFollowUpQueue.acquire(childStreamId);
  session.setQueue(queue);
  registerInterruptible(childStreamId, session);

  const groupId = logger.startGroup('Claude Code session');

  queue.enqueue(initialPrompt);
  StreamStatusService.set(childStreamId, STREAM_STATUS.WAITING, {
    runtimeHost,
  });

  let resumeSessionId: string | undefined;
  const storedSessionIds = new Set<string>();

  void (async () => {
    try {
      while (!session.isInterrupted()) {
        const messages = await queue.waitAndDrainAll(() =>
          session.isInterrupted(),
        );
        if (!messages || session.isInterrupted()) break;

        const prompt = messages.items.join('\n\n');
        StreamStatusService.set(childStreamId, STREAM_STATUS.RUNNING, {
          runtimeHost,
        });
        const startedAt = Date.now();
        const ac = session.startTurn();

        let turn: TurnResult | null = null;
        let err: unknown = null;
        try {
          turn = await runStreamedTurn({
            prompt,
            childStreamId,
            logger,
            abortController: ac,
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
          logTurnSummary(logger, Date.now() - startedAt, turn.usage);
          if (turn.isError && turn.errorMessage) {
            logger.error(turn.errorMessage);
          }
        } catch (caught) {
          if (isCleanInterruption(caught, ac.signal, session)) break;
          err = caught;
          logger.error(toErrorMessage(caught));
        } finally {
          session.finishTurn();
        }

        const wallTimeMs = Date.now() - startedAt;
        if (turn?.sessionId && !sessionRegistry.has(turn.sessionId)) {
          storeSession(turn.sessionId, {
            childStreamId,
            parentStreamId,
            executionId,
            model: params.model,
            permissionMode: params.permissionMode,
            effort: params.effort,
            cwd: params.cwd,
            additionalDirectories: params.additionalDirectories,
          });
          storedSessionIds.add(turn.sessionId);
        }

        if (turn?.usage) {
          publishClaudeAgentStreamUsage(
            childStreamId,
            executionId,
            buildClaudeUsageStats(turn.usage),
            runtimeHost,
          );
        }

        const msg =
          turn && !err
            ? formatClaudeDelivery(executionId, prompt, wallTimeMs, turn)
            : formatClaudeError(executionId, prompt, err);
        try {
          await getExecutionStore(executionId).writeReport(msg);
        } catch {
          // Best-effort; delivery must not block on storage.
        }
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);

        if (!session.isInterrupted()) {
          StreamStatusService.set(childStreamId, STREAM_STATUS.WAITING, {
            runtimeHost,
          });
        }
      }
    } finally {
      logger.endGroup(groupId, 'stopped');
      for (const sessionId of storedSessionIds) {
        sessionRegistry.delete(sessionId);
      }
      unregisterInterruptible(childStreamId);
      ToolUseFollowUpQueue.release(childStreamId);
      await writeTerminalStatus(executionId, 'completed').catch(() => {});
      untrackExecution(executionId);
      finalizeClaudeAgentLoopStatus(childStreamId, runtimeHost);
    }
  })();
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

    const approvalLabel = `[${CLAUDE_AGENT_NAME} ${permissionMode}] ${input.prompt}`;
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

    if (input.session_id) {
      return resumeClaudeAgentSession(
        input.session_id,
        input.prompt,
        runContext?.streamId,
      );
    }
    return launchClaudeAgentSession(
      input,
      permissionMode,
      model,
      effort,
      runContext?.streamId,
      runContext?.executionId,
      runContext?.workingDirectory,
      runContext?.runtimeHost,
    );
  }
}

async function launchClaudeAgentSession(
  input: ClaudeAgentInput,
  permissionMode: ClaudeAgentPermissionMode,
  model: string,
  effort: ClaudeAgentEffort,
  parentStreamId: StreamTabId | undefined,
  parentExecutionId: ExecutionId | undefined,
  parentWorkingDirectory: string | undefined,
  runtimeHost: AgentRuntimeHost | undefined,
): Promise<ToolResult> {
  if (!parentStreamId || !runtimeHost) {
    throw new ToolError(
      'Claude Code CLI requires a parent stream runtime context — it must be called from an active tool-use agent.',
    );
  }

  const config = await getClaudeAgentConfig();
  const workingDir = parseWorkingDirectory(parentWorkingDirectory);
  const workspace = config.buildClaudeAgentWorkspaceOptions(workingDir);
  const env = await config.buildClaudeAgentEnv();

  const executionId = generateExecutionId();
  await ensureRunDir(executionId);

  const agentConfig = config.buildClaudeAgentConfig(input.prompt);

  try {
    await registerExecution(
      executionId,
      agentConfig,
      CLAUDE_AGENT_NAME,
      parentExecutionId,
    );
  } catch {
    throw new ToolError('Failed to register Claude Code CLI execution.');
  }

  const { childStreamId, logger } = createChildStream(
    executionId,
    parentStreamId,
    {
      streamPrefix: 'claude@agent-sdk',
      streamCategory: AgentCategory.ToolUse,
      agentName: CLAUDE_AGENT_NAME,
      description: input.prompt,
      config: agentConfig,
      toolName: CLAUDE_AGENT_NAME,
      runtimeHost,
    },
  );

  startClaudeAgentLoop({
    childStreamId,
    parentStreamId,
    executionId,
    logger,
    initialPrompt: input.prompt,
    model,
    permissionMode,
    effort,
    cwd: workspace.cwd,
    additionalDirectories: workspace.additionalDirectories,
    env,
    pathToClaudeCodeExecutable: findClaudeBinaryPath(),
    runtimeHost,
  });

  const preview = truncateWithEllipsis(input.prompt, 60);
  return {
    summary: `Launched Claude Code CLI: ${preview}`,
    output: [
      `Claude Code agent launched (model: ${model}, permission: ${permissionMode}).`,
      `Execution ID: ${executionId}`,
      `Stream tab: ${childStreamId}`,
      `Result will be delivered as a follow-up message when the turn completes. The delivery includes the session_id — pass it back on a later call to send a follow-up.`,
    ].join('\n'),
  };
}

function resumeClaudeAgentSession(
  sessionId: string,
  prompt: string,
  callerStreamId: StreamTabId | undefined,
): ToolResult {
  const stored = sessionRegistry.get(sessionId);
  if (!stored) {
    throw new ToolError(
      `Claude Code CLI session '${sessionId}' is not active. It may have completed or been stopped; start a new session without session_id.`,
    );
  }

  if (callerStreamId && stored.parentStreamId !== callerStreamId) {
    throw new ToolError(
      `Claude Code CLI session '${sessionId}' is owned by a different session; start a new session without session_id to run in this context.`,
    );
  }

  const queue = ToolUseFollowUpQueue.acquire(stored.childStreamId);
  queue.enqueue(prompt);

  const preview = truncateWithEllipsis(prompt, 60);
  return {
    summary: `Follow-up queued for Claude Code CLI: ${preview}`,
    output: [
      `Follow-up instruction queued for Claude Code session '${sessionId}'. The agent will process it and deliver a new result automatically.`,
      `Execution ID: ${stored.executionId}`,
    ].join('\n'),
  };
}
