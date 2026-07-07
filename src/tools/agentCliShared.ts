// Shared helpers for the agent-CLI tool modules (codex.ts, claudeAgent.ts).
// Host-agnostic, VS Code-free.

import { registerExecution } from '@agent/storage';
import { type AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { currentSession } from '@agent/runtime/SessionHandle';
import { getCurrentToolContexts } from '@agent/followUp/ToolFileInteractionContext';
import type { RunContext } from '@agent/runtime/RunContext';
import { isAbortError } from '@common/errors';
import type {
  ExecutionId,
  StorageKey,
  StreamTabId,
  TokenUsageStats,
} from '@shared/schemas';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import {
  requestBashApproval,
  buildBashApprovalRejectedResult,
} from '@tools/approval/bashApproval';
import { formatDuration, generateExecutionId } from '@utils/core';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

import { createChildStream, type ChildStream } from './childStream';

/**
 * True when an error/abort represents a clean, caller-initiated interruption
 * rather than a genuine failure.
 */
export function isCleanInterruption(
  err: unknown,
  signal: AbortSignal,
  session: { isInterrupted(): boolean },
): boolean {
  return signal.aborted || session.isInterrupted() || isAbortError(err);
}

/**
 * Publish a turn's token usage to the progress UI for an agent-CLI child stream.
 * Shared by the codex and claudeAgent session strategies.
 */
export function publishAgentCliStreamUsage(
  childStreamId: StreamTabId,
  executionId: ExecutionId,
  usage: TokenUsageStats,
  logger: AgentTrace,
): void {
  const stats = Object.fromEntries(
    Object.entries(usage).filter(([, value]) => typeof value === 'number'),
  ) as Record<string, number>;
  logger.usage(stats, {
    data: {
      streamId: childStreamId,
      storageKey: executionId as StorageKey,
      executionId,
      usage,
    },
    recordTranscript: false,
  });
}

/** Log a turn summary (duration + token usage) to the child stream. */
export function logTurnSummary(
  logger: AgentTrace,
  wallTimeMs: number,
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined,
): void {
  logger.info(`Turn completed in ${formatDuration(wallTimeMs)}`);
  if (usage) {
    logger.info('Tokens', {
      data: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      },
    });
  }
}

interface ResumableAgentCliStore {
  lookup(id: string):
    | {
        parentStreamId: StreamTabId;
        childStreamId: StreamTabId;
        executionId: ExecutionId;
      }
    | undefined;
}

export interface AgentCliResumeLabels {
  notActiveLabel: string;
  idParamName: string;
  summaryLabel: string;
  queuedLabel: string;
}

/**
 * Enqueue a follow-up prompt onto an already-running agent-CLI session.
 * Refuse callers from a different parent stream because the turn result is
 * delivered back to the stored parent stream.
 */
export function resumeAgentCliSession(
  store: ResumableAgentCliStore,
  params: {
    id: string;
    prompt: string;
    callerStreamId: StreamTabId | undefined;
    labels: AgentCliResumeLabels;
  },
): ToolResult {
  const { id, prompt, callerStreamId, labels } = params;
  const stored = store.lookup(id);
  if (!stored) {
    throw new ToolError(
      `${labels.notActiveLabel} '${id}' is not active. It may have completed or been stopped; start a new session without ${labels.idParamName}.`,
    );
  }
  if (callerStreamId && stored.parentStreamId !== callerStreamId) {
    throw new ToolError(
      `${labels.notActiveLabel} '${id}' is owned by a different session; start a new session without ${labels.idParamName} to run in this context.`,
    );
  }

  currentSession().followUps.acquire(stored.childStreamId).enqueue({
    text: prompt,
  });

  const preview = truncateWithEllipsis(prompt, 60);
  return {
    status: 'executed',
    summary: `Follow-up queued for ${labels.summaryLabel}: ${preview}`,
    output: [
      `Follow-up instruction queued for ${labels.queuedLabel} '${id}'. The agent will process it and deliver a new result automatically.`,
      `Execution ID: ${stored.executionId}`,
    ].join('\n'),
  };
}

export interface AgentCliLaunchParams {
  parentStreamId: StreamTabId;
  parentExecutionId: ExecutionId | undefined;
  runtimeHost: AgentRuntimeHost;
  agentName: string;
  streamPrefix: string;
  description: string;
  config: AgentConfig;
  registerFailedMessage: string;
  startLoop: (ctx: {
    childStream: ChildStream;
    executionId: ExecutionId;
  }) => void | Promise<void>;
  summary: string;
  launchedLine: string;
  followUpLine: string;
}

/**
 * Register a fresh agent-CLI execution, create its child stream tab, start the
 * provider's turn loop, and return the "launched" ToolResult.
 */
export async function launchAgentCliSession(
  params: AgentCliLaunchParams,
): Promise<ToolResult> {
  const executionId = generateExecutionId();
  await ensureRunDir(executionId);

  try {
    await registerExecution(
      executionId,
      params.config,
      params.agentName,
      params.parentExecutionId,
    );
  } catch {
    throw new ToolError(params.registerFailedMessage);
  }

  const childStream = createChildStream(executionId, params.parentStreamId, {
    streamPrefix: params.streamPrefix,
    streamCategory: AgentCategory.ToolUse,
    agentName: params.agentName,
    description: params.description,
    config: params.config,
    toolName: params.agentName,
    runtimeHost: params.runtimeHost,
  });

  await params.startLoop({ childStream, executionId });

  return {
    status: 'executed',
    summary: params.summary,
    output: [
      params.launchedLine,
      `Execution ID: ${executionId}`,
      `Stream tab: ${childStream.childStreamId}`,
      params.followUpLine,
    ].join('\n'),
  };
}

/**
 * Run the shared agent-CLI execute() prelude: request bash approval for the
 * labelled command, fire the post-approval in-progress hook, then dispatch to
 * the resume/launch branch with the active run context.
 */
export async function withAgentCliApproval(
  approvalLabel: string,
  run: (runContext: RunContext | undefined) => ToolResult | Promise<ToolResult>,
): Promise<ToolResult> {
  const approval = await requestBashApproval({ command: approvalLabel });
  if (!approval.accepted) {
    return buildBashApprovalRejectedResult(
      approvalLabel,
      approval.userMessage,
      approval.timedOut,
    );
  }

  const contexts = getCurrentToolContexts();
  contexts?.callContext?.onExecutionReady?.();
  return run(contexts?.runContext);
}
