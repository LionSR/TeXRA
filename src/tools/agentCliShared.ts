// Shared helpers for the agent-CLI tool modules (codex.ts, claudeAgent.ts).
// Host-agnostic, VS Code-free.

import { registerExecution } from '@agent/storage';
import { type AgentTrace } from '@agent/trace';
import {
  captureOwnedExecutionLease,
  releaseOwnedExecutionLeaseAfterFailure,
} from '@agent/storage/executionLease';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { currentSession } from '@agent/runtime/SessionHandle';
import { getCurrentToolContexts } from '@agent/followUp/ToolFileInteractionContext';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type { RunContext } from '@agent/runtime/RunContext';
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
import { generateExecutionId } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

import { createChildStream, type ChildStream } from './childStream';

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
  logger.usage(
    {
      streamId: childStreamId,
      storageKey: executionId as StorageKey,
      executionId,
      usage,
    },
    { recordTranscript: false },
  );
}

interface ResumableAgentCliSession {
  parentStreamId: StreamTabId;
  childStreamId: StreamTabId;
  executionId: ExecutionId;
}

interface ClaimableAgentCliStore {
  claim(id: string): (() => void) | undefined;
  waitForActive(id: string): Promise<ResumableAgentCliSession | undefined>;
}

export interface AgentCliResumeLabels {
  notActiveLabel: string;
  idParamName: string;
  summaryLabel: string;
  queuedLabel: string;
}

async function queueAgentCliFollowUp(
  stored: ResumableAgentCliSession,
  params: {
    id: string;
    prompt: string;
    callerStreamId: StreamTabId | undefined;
    labels: AgentCliResumeLabels;
  },
): Promise<ToolResult> {
  const { id, prompt, callerStreamId, labels } = params;
  if (callerStreamId && stored.parentStreamId !== callerStreamId) {
    throw new ToolError(
      `${labels.notActiveLabel} '${id}' is owned by a different session; start a new session without ${labels.idParamName} to run in this context.`,
    );
  }

  const result = await submitFollowUp(stored.childStreamId, prompt, {
    session: currentSession(),
  });
  if (result.status === 'no_session' || result.status === 'dropped') {
    throw new ToolError(
      `${labels.notActiveLabel} '${id}' no longer has a resumable continuation.`,
    );
  }

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

/**
 * Atomically choose between queueing onto an owned session id and launching a
 * disk-based fallback. A failed owner releases only its own claim; waiting
 * callers then compete for the released id, so one retries the fallback while
 * the others continue waiting. A successful launch transfers the claim to its
 * loop, which promotes it after the first successful turn or releases it during
 * cleanup so an acknowledged follow-up can never be stranded behind a failed
 * initial turn.
 */
export async function resumeOrLaunchAgentCliSession(
  store: ClaimableAgentCliStore,
  params: {
    id: string | undefined;
    prompt: string;
    callerStreamId: StreamTabId | undefined;
    labels: AgentCliResumeLabels;
    launch: (releaseClaim?: () => void) => Promise<ToolResult>;
  },
): Promise<ToolResult> {
  const { id } = params;
  if (!id) return params.launch();

  while (true) {
    const releaseClaim = store.claim(id);
    if (releaseClaim) {
      try {
        return await params.launch(releaseClaim);
      } catch (error) {
        releaseClaim();
        throw error;
      }
    }

    const stored = await store.waitForActive(id);
    if (!stored) continue;
    return queueAgentCliFollowUp(stored, {
      id,
      prompt: params.prompt,
      callerStreamId: params.callerStreamId,
      labels: params.labels,
    });
  }
}

export interface AgentCliLaunchParams {
  parentStreamId: StreamTabId;
  parentExecutionId: ExecutionId | undefined;
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
  const runWithOwnership = captureOwnedExecutionLease(executionId);

  return runWithOwnership(async () => {
    let childStream: ChildStream | undefined;
    try {
      childStream = createChildStream(executionId, params.parentStreamId, {
        streamPrefix: params.streamPrefix,
        streamCategory: AgentCategory.ToolUse,
        runKind: 'agent',
        agentName: params.agentName,
        description: params.description,
        config: params.config,
        toolName: params.agentName,
      });
      await params.startLoop({ childStream, executionId });
    } catch (error) {
      let failure = error;
      if (childStream) {
        try {
          await childStream.finalize({
            outcome: { kind: 'failed', error },
            persistence: { kind: 'finalize', flowRecord: 'delete' },
          });
        } catch (finalizeError) {
          failure = new AggregateError(
            [error, finalizeError],
            `Agent CLI execution ${executionId} failed and its child stream could not be finalized`,
          );
        }
      }
      throw await releaseOwnedExecutionLeaseAfterFailure(executionId, failure);
    }

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
  });
}

/**
 * Run the shared agent-CLI execute() prelude: refuse a run that cannot collect
 * the result, request bash approval for the labelled command, fire the
 * post-approval in-progress hook, then dispatch to the resume/launch branch
 * with the active run context.
 *
 * Both agent-CLI tools deliver every turn as a follow-up message. A run with
 * `stopAfterCycle` ends after the current cycle, so that follow-up would land
 * in a turn that never happens and the child's result is stranded. Fail before
 * prompting for approval rather than launching work nobody collects.
 */
export async function withAgentCliApproval(
  toolName: string,
  approvalLabel: string,
  run: (runContext: RunContext | undefined) => ToolResult | Promise<ToolResult>,
): Promise<ToolResult> {
  const contexts = getCurrentToolContexts();
  if (contexts?.runContext?.stopAfterCycle) {
    throw new ToolError(
      `${toolName} is unavailable in one-shot runs: it delivers its result as a follow-up message, and this run ends after the current cycle so no follow-up can be collected. Delegate with delegate_agent, which returns the child's result directly.`,
    );
  }

  const approval = await requestBashApproval({ command: approvalLabel });
  if (approval.action !== 'approve') {
    return buildBashApprovalRejectedResult(approvalLabel, approval.feedback);
  }

  contexts?.callContext?.hooks?.onExecutionReady?.();
  return run(contexts?.runContext);
}
