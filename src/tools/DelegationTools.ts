/**
 * Tools for delegating agent executions from tool-use agents.
 * - delegate_workflow: For workflow agents (structured file I/O, fixed-round full-document rewrite)
 * - delegate_agent: For tool-use agents (new delegation or resume via execution_id)
 *
 * Interactive subagents execute asynchronously — result delivered via follow-up
 * queue. One-shot/headless parent runs execute subagents in-band because there
 * is no later interactive follow-up turn to consume async delivery.
 */

// Third-party imports
import { nanoid } from 'nanoid';
import { z } from 'zod';

// Local imports - agent
import { getExecutionStore, registerExecution } from '@agent/storage';
import { getVisibleAgent, getVisibleAgents } from '@agent/index/agentRegistry';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { evaluateCurrentDelegationGate } from '@agent/runtime/delegationPolicy';
import { currentSession } from '@agent/runtime/SessionHandle';
import type { ProposalResult } from '@agent/runtime/AgentProposalCoordinator';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import {
  getAgentFlowErrorResult,
  type AgentFlowResult,
} from '@agent/runtime/AgentFlowResult';
import { tryUseRunContext, type RunContext } from '@agent/runtime/RunContext';
import { getCurrentToolCallContext } from '@agent/toolUse/ToolFileInteractionContext';
import {
  sendFollowUp,
  wakeOrReleaseQueuedStream,
} from '@agent/toolUse/ToolUseFollowUp';
import type { FollowUpQueueInput } from '@agent/toolUse/FollowUpQueue';

// Local imports - logger
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';

// Local imports - common

// Local imports - model
import { computeModelOptionsData } from '@model/computeModelOptions';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
  type StreamTabId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { formatBytes } from '@shared/utils/string';

// Local imports - tools
import type { ToolResult } from '@shared/schemas/toolResult';
import {
  isApprovalBypassedForStream,
  proposalApprovalState,
  enableYoloOnChildStream,
  inheritBashBypassOnChildStream,
} from '@tools/approval';
import {
  computeAndWriteWorkflowDiffs,
  type DiffFileInfo,
} from '@tools/subagentDiffs';
import {
  formatSubagentDelivery,
  formatSubagentError,
  formatSubagentProgress,
  formatFollowUpInstruction,
} from '@tools/subagentResults';
import {
  SUBAGENT_DELIVERY_DECISION,
  subagentDeliveryRegistry,
} from '@tools/subagentDeliveryState';
import {
  availableModelNamesFromOptions,
  resolveDelegationModelFromAvailableNames,
} from '@tools/delegationModelAvailability';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { isWorktreeSupportEnabled } from '@tools/worktreeConfig';
import { defineTool } from '@tools/core/define';

// Local imports - memory
import { displayToStoragePath } from '@tools/memory/memoryUtils';

// Local imports - worktree config

// Local imports - utils
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import { generateExecutionId } from '@utils/core/executionId';
import { hasExtension } from '@utils/core/pathCore';
import { isNonEmptyString } from '@utils/core/stringCore';

// ============================================================================
// Shared utilities
// ============================================================================

const LOG_CHANNEL = 'DelegationTools';
logger.initialize(LOG_CHANNEL);

const LARGE_BIB_LIMIT_BYTES = 100 * 1024;

/**
 * Shared Zod field for the `memories` parameter on delegation tools.
 * Validates that all paths are within /memories using displayToStoragePath
 * (prefix + traversal checks). Existence is NOT checked — getAttachedMemories
 * handles read failures gracefully, avoiding a TOCTOU race.
 */
const memoriesField = z
  .array(z.string())
  .prefault([])
  .describe(
    'Memory file paths to attach (e.g. /memories/conventions.md). Content is injected into the agent prompt as read-only context. Use for project conventions, style guides, or accumulated knowledge the agent should follow.',
  )
  .superRefine((memories, ctx) => {
    for (const [i, memory] of memories.entries()) {
      try {
        displayToStoragePath(memory);
      } catch (e) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message:
            e instanceof Error ? e.message : `Invalid memory path: ${memory}`,
        });
      }
    }
  });

const WORKTREE_DISABLED_MESSAGE =
  "git worktree support is disabled in this workspace. Omit working_directory, or enable 'Allow agents to work in git worktrees' on the Multi-Agent settings tab.";
const TOOL_USE_SUBAGENT_HANDOFF_INSTRUCTION = [
  'Delegated task handoff:',
  '- Treat the delegated instruction as your full task contract.',
  '- Follow any tool, network, file, approval, output-format, or scope constraints it includes.',
  '- If a requested action conflicts with those constraints or needs missing context, report the conflict instead of guessing permission.',
  '- Your final response is delivered verbatim to the parent orchestrator.',
  '- Include the substantive result requested: answer, findings, evidence/checks, and unresolved caveats.',
  '- Do not finish with only status/process notes such as "done", "complete", or "no files were edited"; if no files were edited, state that after the task result.',
].join('\n');
const DEFAULT_DELEGATION_REJECTION_FEEDBACK = [
  'No feedback provided.',
  'Do not retry the same or equivalent delegation unless the user explicitly asks for it;',
  'continue directly with available context, or ask the user a clarifying question.',
].join(' ');

function withToolUseSubagentHandoffInstruction(instruction: string): string {
  const trimmed = instruction.trimEnd();
  return trimmed
    ? `${trimmed}\n\n${TOOL_USE_SUBAGENT_HANDOFF_INSTRUCTION}`
    : TOOL_USE_SUBAGENT_HANDOFF_INSTRUCTION;
}

function ensureWorkingDirectoryExists(dir: string): void {
  try {
    if (AbsoluteFS.statSync(dir).isDirectory()) return;
  } catch (e) {
    throw new Error(
      `working_directory must be an existing directory: ${toErrorMessage(e)}`,
      { cause: e },
    );
  }
  throw new Error(`working_directory must be a directory: ${dir}`);
}

/**
 * Shared Zod field for the `working_directory` parameter on delegation tools.
 * Validates and normalizes in one step so downstream code always receives the
 * canonical `string | undefined` value — no trimming or absolute-path checks
 * needed at the call site.
 */
const workingDirectoryField = z
  .string()
  .nullish()
  .describe(
    'Absolute path for the subagent to operate in (e.g. a git worktree). All tool calls within the subagent will automatically use this as their root directory. Defaults to workspace root. Only accepted when git worktree support is enabled on the Multi-Agent settings tab.',
  )
  .transform((value, ctx): string | undefined => {
    let trimmed: string | undefined;
    try {
      trimmed = parseWorkingDirectory(value);
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message: toErrorMessage(e),
      });
      return z.NEVER;
    }
    if (!trimmed) return trimmed;
    if (!isWorktreeSupportEnabled()) {
      ctx.addIssue({
        code: 'custom',
        message: WORKTREE_DISABLED_MESSAGE,
      });
      return z.NEVER;
    }
    try {
      ensureWorkingDirectoryExists(trimmed);
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message: toErrorMessage(e),
      });
      return z.NEVER;
    }
    return trimmed;
  });

/** Get required context fields, throwing if unavailable. */
function getRequiredContext(): RunContext & {
  streamId: StreamTabId;
} {
  const ctx = tryUseRunContext();
  if (!ctx?.streamId) {
    throw new Error(
      'Tool context unavailable. Cannot create proposal without active stream.',
    );
  }
  return ctx as RunContext & { streamId: StreamTabId };
}

/** Metadata about how the delegation was approved, included in the tool result. */
interface ApprovalMeta {
  autoApproved: boolean;
  modelOverride?: string;
  requestedModel?: string;
  agentOverride?: string;
  requestedAgent?: string;
}

/**
 * Format a subagent result for delivery to the orchestrator.
 * For workflow results, computes latexdiffs and writes them as files to the
 * execution's run directory first — the delivery references diff file paths
 * so the orchestrator can read them on demand via /executions/{id}/files/.
 */
async function subagentDeliveryMessage(
  executionId: string,
  agentName: string,
  result: AgentFlowResult,
  options: {
    readonly startedAt: number;
    readonly workingDirectory?: string;
  },
): Promise<string> {
  let diffInfos: Map<string, DiffFileInfo> | undefined;
  let diffsUnavailable: string | undefined;
  if (result.category === 'workflow' && result.outputs.length > 0) {
    try {
      diffInfos = await computeAndWriteWorkflowDiffs(
        executionId,
        result.outputs,
      );
    } catch (err) {
      // Diff computation failure is non-fatal — deliver without diffs, but
      // tell the orchestrator so it can read the output files directly
      // instead of assuming the revision was a no-op.
      diffsUnavailable = toErrorMessage(err);
      logger.warn(
        'subagentDelivery',
        `Diff computation failed for ${executionId}: ${diffsUnavailable}`,
      );
    }
  }

  return formatSubagentDelivery(agentName, result, {
    diffInfos,
    diffsUnavailable,
    wallTimeMs: Date.now() - options.startedAt,
    workingDirectory: options.workingDirectory,
  });
}

async function writeSubagentReport(
  executionId: string,
  message: string,
): Promise<void> {
  try {
    await getExecutionStore(executionId).writeReport(message);
  } catch (err) {
    // Non-fatal, but the report is the only durable copy of the result when
    // delivery later fails — leave a trace instead of vanishing silently.
    logger.warn(
      'subagentDelivery',
      `Failed to persist subagent report for ${executionId}: ${toErrorMessage(err)}`,
    );
  }
}

function resolveDeliveryStreamId(
  executionId: string,
  fallbackStreamId: StreamTabId,
): StreamTabId | undefined {
  const handle = currentSession().executions.getHandle(executionId);
  if (!(handle instanceof AgentExecutionHandle)) return fallbackStreamId;
  // AgentExecutionHandle.detach() promotes a child by setting
  // parentStreamId === childStreamId. Do not enqueue the formatted result
  // back into the detached child's own prompt as a synthetic follow-up.
  return handle.parentStreamId === handle.childStreamId
    ? undefined
    : handle.parentStreamId;
}

/**
 * Runtime depth gate shared by fresh delegations and resumes.
 * Evaluates against the current workspace delegation policy.
 */
function depthGateError(parentDelegationDepth: number): ToolResult | null {
  const gate = evaluateCurrentDelegationGate(parentDelegationDepth);
  if (gate.allowed) return null;

  const unknownDepth = gate.blockReason === 'unknown_depth';
  const reason = unknownDepth
    ? [
        'The current session was resumed from saved state,',
        'but its delegation lineage could not be verified.',
      ].join(' ')
    : [
        `This agent is already at delegation depth ${gate.depth},`,
        'and agents may delegate only when their current depth is less than',
        'the configured max depth.',
      ].join(' ');
  const remediation = unknownDepth
    ? [
        'Resume or restart from a valid parent session,',
        'or complete this task directly without delegating.',
      ].join(' ')
    : [
        'Raise Settings → Multi-Agent → Max delegation depth,',
        'or complete this task directly without delegating.',
      ].join(' ');
  return {
    error: [
      `Delegation depth cap reached (current depth ${gate.depth},`,
      `max depth ${gate.maxDepth}).`,
      reason,
      remediation,
    ].join(' '),
    isError: true,
    diagnostics: {
      type: 'delegation_depth_cap',
      currentDepth: gate.depth,
      currentDepthKnown: !unknownDepth,
      maxDepth: gate.maxDepth,
      blockReason: gate.blockReason,
    },
  };
}

/**
 * Execute a subagent asynchronously.
 * Pre-generates executionId so all IDs (tool return, XML delivery, error)
 * are consistent and usable with the executions tool.
 *
 * Result is delivered via FollowUpQueue. For tool-use subagents, the result
 * is delivered early via onBeforeWaiting (before the subagent enters WAITING),
 * so the orchestrator gets the response without waiting for flow exit.
 * For workflow subagents, delivery happens when the promise resolves.
 */
async function executeSubagent(
  configPayload: AgentConfigPayload,
  agentName: string,
  orchestratorStreamId: StreamTabId,
  options?: { enableYoloOnChild?: boolean; approvalMeta?: ApprovalMeta },
): Promise<ToolResult> {
  // Lazy import: the delegation tool runs agents, and the agent runtime loads
  // this tool through the registry. Same intentional recursion pattern as the
  // dynamic RemoteAgentLoader import in agentRegistry.
  const { executeAgent } = await import('@agent/runtime/executeAgent');
  const parentContext = tryUseRunContext();
  if (!parentContext?.runtimeHost) {
    return {
      summary: 'Delegation tool runtime host unavailable',
      error:
        'delegate_agent and delegate_workflow require an active tool runtime host. Run delegation from an active agent session, or ensure the tool run context provides runtimeHost.',
      isError: true,
      diagnostics: {
        type: 'missing_runtime_host',
        tools: ['delegate_agent', 'delegate_workflow'],
      },
    };
  }
  const parentExecutionId = parentContext.executionId;
  const parentDelegationDepth = parentContext.delegationDepth ?? 0;
  const runtimeHost = parentContext.runtimeHost;
  const parentSession = currentSession();
  // Captured now (while the launching tool call's ALS frame is live) so the
  // async completion callbacks below can still roll the child's cost into the
  // parent run after this tool call has returned. Subagents count toward
  // parent usage totals only — they never drive the loop.
  const recordSubagentCost = getCurrentToolCallContext()?.recordSubagentCost;
  let subagentCostSettled = false;
  function settleSubagentCost(result?: AgentFlowResult): void {
    if (subagentCostSettled) return;
    subagentCostSettled = true;
    recordSubagentCost?.(result?.totalCostUsd ?? 0);
  }

  const gated = depthGateError(parentDelegationDepth);
  if (gated) return gated;

  const executionId = generateExecutionId();
  const startedAt = Date.now();
  const workingDirectory = configPayload.workingDirectory ?? undefined;

  const syntheticConfig = AgentConfigSchema.parse(configPayload);
  await registerExecution(
    executionId,
    syntheticConfig,
    agentName,
    parentExecutionId,
    undefined,
    parentDelegationDepth + 1,
  );

  const inheritChildStreamApprovals = (resolvedStreamId: StreamTabId): void => {
    // Bash bypass follows the parent regardless of edit-YOLO, so a bash-only
    // parent (CLI AUTO-BASH without AUTO-APPROVE) still propagates to the child.
    inheritBashBypassOnChildStream(resolvedStreamId, orchestratorStreamId);
    if (options?.enableYoloOnChild) {
      enableYoloOnChildStream(resolvedStreamId);
    }
  };

  if (parentContext.stopAfterCycle) {
    const failureResult = async (
      err: unknown,
      memoryMisses?: AgentFlowResult['memoryMisses'],
    ): Promise<ToolResult> => {
      const msg = formatSubagentError(executionId, agentName, err, {
        wallTimeMs: Date.now() - startedAt,
        workingDirectory,
        memoryMisses,
      });
      await writeSubagentReport(executionId, msg);
      return {
        summary: `Subagent '${agentName}' failed`,
        output: msg,
        error: toErrorMessage(err),
        isError: true,
      };
    };
    try {
      let subagentError: unknown;
      const result = await executeAgent(configPayload, executionId, {
        runtimeHost,
        isSubagent: true,
        enforceCategory: true,
        parentStreamId: orchestratorStreamId,
        delegationDepth: parentDelegationDepth + 1,
        approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
        runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
        stopAfterCycle: true,
        onStreamResolved: inheritChildStreamApprovals,
        onError: (err) => {
          subagentError = err;
        },
      });
      settleSubagentCost(result);
      if (result.outcome === 'failed') {
        return failureResult(
          subagentError ?? 'Subagent ended with failed outcome.',
          result.memoryMisses,
        );
      }
      const msg = await subagentDeliveryMessage(
        executionId,
        agentName,
        result,
        { startedAt, workingDirectory },
      );
      await writeSubagentReport(executionId, msg);
      return {
        summary:
          result.outcome === 'cancelled'
            ? `Cancelled '${agentName}'`
            : `Completed '${agentName}'`,
        output: msg,
      };
    } catch (err) {
      settleSubagentCost(getAgentFlowErrorResult(err));
      return failureResult(err);
    }
  }

  // Register delivery state so delegate_agent (resume) can find live subagents.
  // The state object owns duplicate-delivery protection between onBeforeWaiting
  // and onCompleted. When a follow-up is consumed, the next onBeforeWaiting
  // delivers the resumed cycle's result.
  const deliveryState = subagentDeliveryRegistry.start(executionId);
  let childStreamId: StreamTabId | undefined;

  /**
   * Deliver a follow-up to the parent stream. For terminal results (`wake`),
   * a parent whose cycle has exited is resumed via the host port so the
   * queued result is consumed instead of sitting until the user pokes the
   * stream; if the parent is gone for good (terminal status, resume failed),
   * the force-reopened queue is re-released so late deliveries don't leak
   * into the next run — the result stays readable in the execution report.
   */
  async function deliverFollowUp(
    followUp: FollowUpQueueInput,
    options?: { wake?: boolean },
  ): Promise<boolean> {
    const targetStreamId = resolveDeliveryStreamId(
      executionId,
      orchestratorStreamId,
    );
    if (!targetStreamId) return false;

    const result = await sendFollowUp(
      targetStreamId,
      followUp,
      undefined,
      undefined,
      parentSession,
    );
    if (result.status === 'no_session') {
      logger.warn(
        'subagentDelivery',
        `Unable to deliver subagent result for ${executionId}: parent stream ${targetStreamId} has no active session (status: ${result.streamStatus ?? 'unknown'}).`,
      );
      return false;
    }
    if (
      options?.wake &&
      !(await wakeOrReleaseQueuedStream(targetStreamId, result))
    ) {
      logger.warn(
        'subagentDelivery',
        `Dropped subagent result for ${executionId}: parent stream ${targetStreamId} is gone and could not be resumed. The result remains in the execution report.`,
      );
      return false;
    }
    return true;
  }

  async function deliverTerminalFollowUp(
    followUp: FollowUpQueueInput,
  ): Promise<boolean> {
    if (!deliveryState.beginDelivery()) return false;
    try {
      const delivered = await deliverFollowUp(followUp, { wake: true });
      if (delivered) {
        deliveryState.completeDelivery();
      } else {
        deliveryState.failDelivery();
      }
      return delivered;
    } catch (err) {
      deliveryState.failDelivery();
      throw err;
    }
  }

  function onProgress(update: SubagentProgressUpdate): void {
    if (deliveryState.isDelivered()) return;
    const msg = formatSubagentProgress(executionId, agentName, update);
    void deliverFollowUp({ text: msg, origin: 'subagent_result' });
  }

  async function deliverSubagentError(
    err: unknown,
    result?: AgentFlowResult,
  ): Promise<void> {
    settleSubagentCost(result);
    const msg = formatSubagentError(executionId, agentName, err, {
      wallTimeMs: Date.now() - startedAt,
      workingDirectory,
      memoryMisses: result?.memoryMisses,
    });
    await writeSubagentReport(executionId, msg);
    await deliverTerminalFollowUp({
      text: msg,
      origin: 'subagent_result',
    });
  }

  const promise = executeAgent(configPayload, executionId, {
    runtimeHost,
    isSubagent: true,
    enforceCategory: true,
    parentStreamId: orchestratorStreamId,
    delegationDepth: parentDelegationDepth + 1,
    approvalPromptsUnavailable: parentContext.approvalPromptsUnavailable,
    runtimeUnavailableTools: parentContext.runtimeUnavailableTools,
    onStreamResolved: (resolvedStreamId) => {
      childStreamId = resolvedStreamId;
      inheritChildStreamApprovals(resolvedStreamId);
    },
    onProgress,
    onFollowUpConsumed: () => {
      deliveryState.markPending();
    },
    onBeforeWaiting: async (lastResponse, touchedFiles, memoryMisses) => {
      const deliveryDecision =
        deliveryState.resolveBeforeWaiting(childStreamId);
      if (deliveryDecision === SUBAGENT_DELIVERY_DECISION.AlreadyDelivered) {
        return true;
      }
      if (deliveryDecision === SUBAGENT_DELIVERY_DECISION.MissingStream) {
        return false;
      }
      const resolvedChildStreamId = childStreamId;
      if (!resolvedChildStreamId) return false;

      const msg = formatSubagentDelivery(
        agentName,
        {
          category: 'toolUse' as const,
          // The turn finished and the subagent is entering WAITING — for the
          // orchestrator this interim delivery is a completed turn.
          outcome: 'completed' as const,
          lastResponse,
          touchedFiles,
          executionId,
          streamId: resolvedChildStreamId,
          memoryMisses: memoryMisses.length > 0 ? [...memoryMisses] : undefined,
        },
        {
          wallTimeMs: Date.now() - startedAt,
          workingDirectory,
        },
      );
      // Best-effort persist — must never block delivery or abort the subagent.
      await writeSubagentReport(executionId, msg);
      // Claim only the enqueue step: formatting/storage failures before this
      // still leave onCompleted/onError available as terminal fallbacks.
      return await deliverTerminalFollowUp({
        text: msg,
        origin: 'subagent_result',
      });
    },
    onCompleted: async (result) => {
      settleSubagentCost(result);
      const msg = await subagentDeliveryMessage(
        executionId,
        agentName,
        result,
        { startedAt, workingDirectory },
      );
      await writeSubagentReport(executionId, msg);
      await deliverTerminalFollowUp({
        text: msg,
        origin: 'subagent_result',
      });
    },
    onError: (err, result) => deliverSubagentError(err, result),
  });
  promise
    // Await the error delivery so the registry entry is not torn down while
    // the delivery (and any resume-based follow-up routing) is in flight.
    .catch((err: unknown) => deliverSubagentError(err))
    .catch((deliveryErr: unknown) => {
      logger.warn(
        'subagentDelivery',
        `Failed to deliver subagent error for ${executionId}: ${toErrorMessage(deliveryErr)}`,
      );
    })
    .finally(() => {
      subagentDeliveryRegistry.finish(executionId);
    });
  const isToolUse = configPayload.agentCategory === AgentCategory.ToolUse;
  const meta = options?.approvalMeta;
  const metaLines: string[] = [];
  if (meta) {
    const modelInfo = meta.modelOverride
      ? `Model: ${meta.modelOverride} (overridden from ${meta.requestedModel ?? 'default'})`
      : `Model: ${configPayload.model}`;
    const agentInfo = meta.agentOverride
      ? ` Agent: ${meta.agentOverride} (overridden from ${meta.requestedAgent ?? 'default'}).`
      : '';
    metaLines.push(
      `Approval: ${meta.autoApproved ? 'auto-approved' : 'user-approved'}. ${modelInfo}.${agentInfo}`,
    );
  }
  return {
    summary: `Launched '${agentName}' (async)`,
    output: [
      `Subagent '${agentName}' launched. Result will be delivered automatically as a follow-up message when complete.`,
      `Execution ID: ${executionId}`,
      ...metaLines,
      `To check intermediate progress: executions tool with path=/executions/${executionId} and action=wait (waits for next status change).`,
      ...(isToolUse
        ? [
            `To send follow-up instructions after delivery: use delegate_agent with execution_id set to this ID.`,
          ]
        : []),
    ].join('\n'),
  };
}

/** Format an agent list for tool descriptions. */
function formatAgentList(
  agents: { name: string; description?: string; tools?: string[] }[],
): string {
  return agents
    .map((agent) => {
      const desc = agent.description || 'No description';
      const toolsSuffix = agent.tools?.length
        ? `\n  Tools: ${agent.tools.join(', ')}`
        : '';
      return `- ${agent.name}: ${desc}${toolsSuffix}`;
    })
    .join('\n');
}

async function resolveAvailableDelegationModel(input: {
  readonly requestedModel?: string | null;
  readonly parentModel?: string | null;
}): Promise<string> {
  const modelOptions = await computeModelOptionsData();
  return resolveDelegationModelFromAvailableNames({
    ...input,
    availableModels: availableModelNamesFromOptions(modelOptions),
  });
}

/** Return the visible current agent, or throw with the current visible list. */
function requireVisibleAgent(
  category: AgentCategory,
  name: string,
): { name: string } {
  const agent = getVisibleAgent(category, name);
  if (agent) return agent;
  const available = getVisibleAgents(category)
    .map((a) => a.name)
    .join(', ');
  throw new Error(
    `Unknown ${category} agent '${name}'. Available: ${available}`,
  );
}

/** Build a concise summary of proposal parameters for rejection echo. */
function summarizeProposal(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): string {
  const parts = [`Agent: ${proposal.agent}`, `Model: ${proposal.model}`];
  if ('inputFiles' in proposal && proposal.inputFiles?.[0]) {
    parts.push(`File: ${proposal.inputFiles[0]}`);
  }
  if (proposal.memories.length > 0) {
    parts.push(`Memories: ${proposal.memories.join(', ')}`);
  }
  const instrPreview =
    proposal.instruction.length > 120
      ? `${proposal.instruction.slice(0, 117)}...`
      : proposal.instruction;
  parts.push(`Instruction: "${instrPreview}"`);
  return parts.join(', ');
}

/** Convert proposal result to ToolResult. Returns null if approved. */
function proposalResultToToolResult(
  result: ProposalResult,
  agentName: string,
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): ToolResult | null {
  const echo = summarizeProposal(proposal);

  switch (result.action) {
    case 'reject': {
      const feedback = result.feedback?.trim();
      const feedbackLine = feedback
        ? `\nUser feedback: ${feedback}`
        : `\n${DEFAULT_DELEGATION_REJECTION_FEEDBACK}`;
      return {
        summary: `User rejected delegation to '${agentName}'`,
        output: `Delegation to '${agentName}' was rejected.\nYour delegation was: ${echo}${feedbackLine}`,
        isError: true,
      };
    }
    case 'timeout':
      return {
        summary: `Delegation to '${agentName}' timed out`,
        output: `Delegation to '${agentName}' timed out waiting for user approval.\nYour delegation was: ${echo}`,
        isError: true,
      };
    case 'setup':
      return {
        summary: `User opened '${agentName}' for editing`,
        output: `Delegation opened for editing. The user will run it manually when ready.\nYour delegation was: ${echo}`,
      };
    case 'approve':
      return null;
  }
}

/**
 * Shared proposal-or-bypass flow used by both delegate_workflow and delegate_agent.
 *
 * If proposal bypass is active for this stream, skips the proposal and launches immediately.
 * Otherwise, waits for user approval via the proposal coordinator.
 */
async function proposeAndExecute(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
  agentName: string,
  streamId: StreamTabId,
): Promise<ToolResult> {
  if (proposalApprovalState.isBypassed(streamId)) {
    return executeSubagent(proposal, agentName, streamId, {
      enableYoloOnChild: true,
      approvalMeta: { autoApproved: true },
    });
  }

  const proposalId = nanoid();

  const result = await currentSession().coordinators.waitForProposal(streamId, {
    proposalId,
    proposal,
  });

  const nonApproveResult = proposalResultToToolResult(
    result,
    agentName,
    proposal,
  );
  if (nonApproveResult) return nonApproveResult;

  // At this point result.action === 'approve' (all other cases returned above).
  if (result.action !== 'approve') {
    throw new Error(`Unexpected non-approve proposal result: ${result.action}`);
  }
  const modelOverride = result.model;
  const agentOverride =
    result.agent && result.agent !== proposal.agent ? result.agent : undefined;
  const resolvedAgentOverride = agentOverride
    ? getVisibleAgent(proposal.agentCategory, agentOverride)?.name
    : undefined;

  // Re-validate against the current registry — between proposal display and
  // approval the agent may have been removed/renamed, or the approval could
  // carry a malformed value. Fail fast so the orchestrator sees the problem
  // synchronously instead of after an async launch.
  if (agentOverride && !resolvedAgentOverride) {
    return {
      summary: `Approved agent override '${agentOverride}' is not available`,
      output: `Cannot launch '${agentOverride}': it is not currently a visible ${proposal.agentCategory} agent (removed, renamed, or disabled since the proposal was shown). Re-propose the delegation.`,
      isError: true,
    };
  }

  const effective = {
    ...proposal,
    ...(modelOverride && { model: modelOverride }),
    ...(resolvedAgentOverride && { agent: resolvedAgentOverride }),
  };
  const effectiveAgentName = resolvedAgentOverride ?? agentName;
  return executeSubagent(effective, effectiveAgentName, streamId, {
    enableYoloOnChild: isApprovalBypassedForStream(streamId),
    approvalMeta: {
      autoApproved: false,
      ...(modelOverride && {
        modelOverride,
        requestedModel: proposal.model,
      }),
      ...(agentOverride && {
        agentOverride,
        requestedAgent: proposal.agent,
      }),
    },
  });
}

// ============================================================================
// delegate_workflow tool - for document processing agents
// ============================================================================

/** Schema for delegate_workflow tool (document processing). */
const WorkflowAgentInputSchema = z.strictObject({
  agent: z.string().describe('Name of the workflow agent to execute'),
  model: z
    .string()
    .nullish()
    .describe(
      'Model short name from the Available models line. Omit unless the user explicitly requested a model; defaults to the current model when available.',
    ),
  instruction: z
    .string()
    .describe(
      'What the agent should do, in plain prose. If you attach context or media files, name each one and say what role it plays — e.g., "preamble.tex defines the math macros; refs.bib is the bibliography to cite from; figure.png shows the panel layout to match". The sub-agent has no other signal for why each file was attached.',
    ),
  inputFiles: z
    .array(z.string())
    .min(1)
    .describe(
      'Files the agent rewrites. List every file you want it to touch. The agent emits one revised <document> per entry.',
    ),
  contextFiles: z
    .array(z.string())
    .prefault([])
    .describe(
      'Read-only context the agent should see but not modify: guidance, examples, related papers, bibliographies (.bib), style/macro definitions (.sty/.cls). Explain each one in the instruction.',
    ),
  mediaFiles: z
    .array(z.string())
    .prefault([])
    .describe('Images, figures, PDFs, or audio files the agent should view.'),
  extractFigures: z
    .boolean()
    .nullish()
    .describe(
      'When true, automatically extracts figures referenced by the input LaTeX file(s) (via \\includegraphics, \\begin{overpic}) and attaches them as media files. Merges with any explicitly provided mediaFile/mediaFiles.',
    ),
  extractTikz: z
    .boolean()
    .nullish()
    .describe(
      'When true, extracts TikZ figures from the input LaTeX file(s), compiles them into standalone PDFs, and attaches them as media files.',
    ),
  outputFiles: z
    .array(z.string())
    .prefault([])
    .describe(
      'Output file paths. Must be a subset of input files—never create new files or change format. Leave empty for default suffix-based outputs.',
    ),
  memories: memoriesField,
});

export type WorkflowAgentInput = z.infer<typeof WorkflowAgentInputSchema>;

function isBibFile(filePath: string): boolean {
  return hasExtension(filePath, '.bib');
}

/** Reject workflow proposals that attach oversized bibliography files. */
export async function rejectOversizedBibAttachments(
  input: WorkflowAgentInput,
): Promise<ToolResult | null> {
  const bibFiles = input.contextFiles
    .filter(isNonEmptyString)
    .filter(isBibFile);

  for (const bibFile of bibFiles) {
    const stats = await WorkspaceFS.stat(bibFile);
    if (stats.size <= LARGE_BIB_LIMIT_BYTES) continue;

    const message = `${bibFile} is ${stats.size} bytes (${formatBytes(stats.size)}), over the ${LARGE_BIB_LIMIT_BYTES} byte (${formatBytes(LARGE_BIB_LIMIT_BYTES)}) limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.`;
    return {
      summary: `Rejected oversized BibTeX attachment`,
      error: message,
      output: message,
      isError: true,
      diagnostics: {
        type: 'oversized_bib_attachment',
        path: bibFile,
        sizeBytes: stats.size,
        limitBytes: LARGE_BIB_LIMIT_BYTES,
      },
    };
  }

  return null;
}

/** Tool for delegating tasks to workflow agents (document processing). */
export class WorkflowAgentTool extends defineTool({
  name: 'delegate_workflow',
  description:
    () => `Delegate to a workflow agent. The agent rewrites every file you list in inputFiles, emitting one revised <document> per input. Use for whole-document operations: proofreading, polishing, applying reviews, adding derivations, merging revisions. For interactive tool use or selective edits, use delegate_agent instead.

Available agents:
${formatAgentList(getVisibleAgents('workflow'))}

Pick the agent whose description matches the task — don't default to correct. correct is for proofreading only. For applying review suggestions use apply; for new derivations use devise; for instruction-driven rewriting use polish; for critical review use criticize.

Available models: loaded from the active API mode at runtime.
Largest models for deep reasoning; long-context for lengthy tedious work; cost-effective for parallel routine work.

Optional auto-attach from the input LaTeX:
- extractFigures=true: pull \\includegraphics / \\begin{overpic} figures into mediaFiles.
- extractTikz=true: compile TikZ figures into standalone PDFs and attach.

Example: agent=correct, inputFiles=["paper.tex"], extractFigures=true, instruction="Quantum error correction paper. Fix grammar, tighten sentences, keep terminology consistent — especially in the abstract and intro."`,
  schema: WorkflowAgentInputSchema,
}) {
  protected async execute(input: WorkflowAgentInput): Promise<ToolResult> {
    const agentName = requireVisibleAgent('workflow', input.agent).name;
    const ctx = getRequiredContext();

    const model = await resolveAvailableDelegationModel({
      requestedModel: input.model,
      parentModel: ctx.model,
    });

    // Validate all file paths exist (parallel for performance)
    const toValidate = (
      arr: string[],
      label: string,
    ): { path: string; label: string }[] =>
      arr.filter(isNonEmptyString).map((path) => ({ path, label }));

    const filesToValidate = [
      ...toValidate(input.inputFiles, 'Input file'),
      ...toValidate(input.contextFiles, 'Context file'),
      ...toValidate(input.mediaFiles, 'Media file'),
    ];

    const validationResults = await Promise.all(
      filesToValidate.map(async ({ path, label }) => ({
        path,
        label,
        exists: await WorkspaceFS.exists(path),
      })),
    );

    const missing = validationResults.find((r) => !r.exists);
    if (missing) {
      throw new Error(`${missing.label} not found: ${missing.path}`);
    }

    const oversizedBibRejection = await rejectOversizedBibAttachments(input);
    if (oversizedBibRejection) return oversizedBibRejection;

    // Extraction flags map to toolConfig, flowing through the proposal UI and
    // into MediaExtractionNode → LatexMediaManager at runtime.
    const proposal = WorkflowAgentProposalSchema.parse({
      agentCategory: AgentCategory.Workflow,
      agent: agentName,
      model,
      instruction: input.instruction,
      inputFiles: input.inputFiles,
      contextFiles: input.contextFiles,
      mediaFiles: input.mediaFiles,
      outputFiles: input.outputFiles,
      toolConfig: {
        ...DEFAULT_TOOL_CONFIG,
        autoExtractFigure: input.extractFigures ?? false,
        autoExtractTikzFigure: input.extractTikz ?? false,
      },
      memories: input.memories,
    } satisfies WorkflowAgentProposal);

    return proposeAndExecute(proposal, agentName, ctx.streamId);
  }
}

// ============================================================================
// delegate_agent tool - for interactive assistants
// ============================================================================

/** Schema for delegate_agent tool (tool-use agents). */
const DelegateAgentInputSchema = z.strictObject({
  agent: z
    .string()
    .nullish()
    .describe(
      'Name of the tool-use agent to delegate to. Required for new delegations, ignored when resuming via execution_id.',
    ),
  model: z
    .string()
    .nullish()
    .describe(
      'Model short name from the Available models line. Omit unless the user explicitly requested a model; defaults to the current model when available.',
    ),
  instruction: z
    .string()
    .describe(
      'Plain prose instruction for the agent. For new delegations, include file paths naturally and copy every relevant parent constraint into this field: tool/network/file/approval limits, output format, and scope. The subagent does not automatically inherit the parent conversation or hidden constraints. For resumes, reference previous work freely — the subagent retains its full history.',
    ),
  memories: memoriesField,
  working_directory: workingDirectoryField,
  execution_id: z
    .string()
    .nullish()
    .describe(
      'If set, sends follow-up instructions to a tool-use subagent instead of starting a new one. Busy subagents queue the follow-up for their next turn. Use the execution ID from the original delegation result or /executions.',
    ),
});

export type DelegateAgentInput = z.infer<typeof DelegateAgentInputSchema>;

/** Tool for delegating tasks to tool-use agents (interactive assistants). */
export class DelegateAgentTool extends defineTool({
  name: 'delegate_agent',
  description:
    () => `Delegate a task to a tool-use agent, or queue follow-up instructions for a tool-use subagent.

**New delegation** (no execution_id): Launches a new tool-use agent with its own tools (file reading, editing, search, bash). Tool-use agents are versatile—they can create entire documents, make targeted edits, perform research, or run multi-step investigations.

**Resume** (with execution_id): Sends follow-up instructions to a WAITING or still-running subagent. If the subagent is busy, the instruction is queued for its next turn. The subagent keeps its full history. Result arrives asynchronously like the original delegation.

When a subagent result is delivered, preserve its stated evidence, tool names, and caveats accurately; do not substitute or invent methods while summarizing it for the user.

Available agents:
${formatAgentList(getVisibleAgents('toolUse'))}

Agent selection: choose the most specific agent whose description matches the task. Specialized agents have domain-specific tools and focused prompts that produce better results for matching tasks. When using a general-purpose agent, state why the work does not map cleanly to a listed specialist.

Available models: loaded from the active API mode at runtime.
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Example (new, specialized): agent=research, instruction="Derive the asymptotic expansion of the partition function in appendix_A.tex using saddle-point methods. Verify with Wolfram."
Example (new, targeted LaTeX repair): agent=latexFixer, instruction="Fix the unresolved citation commands on slides 3 and 7 in slides/talk.tex using refs.bib."
Example (resume): execution_id=exec_abc123, instruction="Also fix the bibliography slide formatting."

Git worktree support: ${
      isWorktreeSupportEnabled()
        ? 'ENABLED. Pass `working_directory` (absolute path) to run a subagent rooted in a git worktree; every tool call in the subagent resolves paths against that directory. The subagent reports its working directory back in its delivery result.'
        : 'DISABLED in this workspace. Do not pass `working_directory` — it will be rejected at schema validation. Ask the user to enable "Allow agents to work in git worktrees" on the Multi-Agent settings tab if worktree operation is needed.'
    }`,
  schema: DelegateAgentInputSchema,
}) {
  protected async execute(input: DelegateAgentInput): Promise<ToolResult> {
    // Resume path: execution_id is set
    if (input.execution_id) {
      return this.resumeAgent(input.execution_id, input.instruction);
    }

    // Delegate path: agent is required
    if (!input.agent) {
      throw new Error(
        `'agent' is required when starting a new delegation. Provide an agent name, or set 'execution_id' to resume an existing subagent.`,
      );
    }

    const agentName = requireVisibleAgent('toolUse', input.agent).name;

    const ctx = getRequiredContext();

    const model = await resolveAvailableDelegationModel({
      requestedModel: input.model,
      parentModel: ctx.model,
    });

    // Construct tool-use proposal (no file fields)
    const proposal = ToolUseAgentProposalSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: agentName,
      model,
      instruction: withToolUseSubagentHandoffInstruction(input.instruction),
      memories: input.memories,
      workingDirectory: input.working_directory,
    } satisfies ToolUseAgentProposal);

    return proposeAndExecute(proposal, agentName, ctx.streamId);
  }

  /** Queue follow-up instructions for a tool-use subagent. */
  private async resumeAgent(
    executionId: string,
    instruction: string,
  ): Promise<ToolResult> {
    const parentContext = tryUseRunContext();
    const parentDelegationDepth = parentContext?.delegationDepth ?? 0;
    const gated = depthGateError(parentDelegationDepth);
    if (gated) return gated;

    const handle = currentSession().executions.getHandle(executionId);
    if (!(handle instanceof AgentExecutionHandle)) {
      throw new Error(
        `Execution '${executionId}' not found or not an agent execution. Use the executions tool to check status.`,
      );
    }

    if (handle.category !== 'toolUse') {
      throw new Error(
        `Execution '${executionId}' is a workflow agent. Only tool-use subagents can be resumed.`,
      );
    }

    // Results route to handle.parentStreamId — a detached subagent (parent ===
    // child) delivers nowhere, and a subagent of another orchestrator reports
    // to that orchestrator, not the caller. Fail fast instead of silently
    // queueing instructions whose results would never come back here.
    if (handle.parentStreamId === handle.childStreamId) {
      throw new Error(
        `Execution '${executionId}' was detached from its orchestrator and now runs top-level. Its results can no longer be delivered back to this session — start a new delegation instead.`,
      );
    }
    const callerStreamId = parentContext?.streamId;
    if (callerStreamId && handle.parentStreamId !== callerStreamId) {
      throw new Error(
        `Execution '${executionId}' belongs to a different orchestrator session. Its results would be delivered there, not here — start a new delegation instead.`,
      );
    }

    const deliveryState = subagentDeliveryRegistry.getActive(executionId);
    if (!deliveryState) {
      throw new Error(
        `Execution '${executionId}' is no longer tracked for delivery. It may have already completed.`,
      );
    }

    const framedInstruction = formatFollowUpInstruction(instruction);
    const result = await sendFollowUp(handle.childStreamId, framedInstruction);

    switch (result.status) {
      case 'sent':
        deliveryState.markPending();
        return {
          summary: `Follow-up sent to '${handle.agentName}'`,
          output: [
            `Follow-up instruction sent to '${handle.agentName}'. The subagent will process it and deliver a new result automatically.`,
            `Execution ID: ${executionId}`,
          ].join('\n'),
        };
      case 'queued':
        deliveryState.markPending();
        return {
          summary: `Follow-up queued for '${handle.agentName}'`,
          output: [
            `Follow-up instruction queued for '${handle.agentName}' (${result.reason}). The subagent will process it and deliver a new result automatically.`,
            `Execution ID: ${executionId}`,
          ].join('\n'),
        };
      case 'no_session':
        throw new Error(
          `No active session for '${handle.agentName}' (stream status: ${result.streamStatus ?? 'unknown'}). The subagent may have stopped or its session expired.`,
        );
    }
  }
}
