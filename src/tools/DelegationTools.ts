/**
 * Tools for delegating agent executions from tool-use agents.
 * - delegate_workflow: For workflow agents (structured file I/O, fixed-round full-document rewrite)
 * - delegate_agent: For tool-use agents (new delegation or resume via execution_id)
 *
 * All subagents execute asynchronously — result delivered via follow-up queue.
 */

// Third-party imports
import { randomUUID } from 'crypto';
import { z } from 'zod';

// Local imports - agent
import { getExecutionStore, registerExecution } from '@agent/storage';
import { getVisibleAgents } from '@agent/index/agentRegistry';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { executeAgent } from '@agent/runtime/executeAgent';
import { readNestedDelegationConfig } from '@agent/runtime/delegationPolicy';
import { waitForProposal } from '@agent/runtime/runCoordinators';
import type { ProposalResult } from '@agent/runtime/AgentProposalCoordinator';
import {
  getHandle,
  AgentExecutionHandle,
} from '@agent/runtime/executionRegistry';
import {
  getCurrentToolRunContext,
  type ToolRunContext,
} from '@agent/toolUse/ToolFileInteractionContext';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';

// Local imports - logger
import * as logger from '@agent/core/logger';

// Local imports - model
import {
  getVisibleModels,
  resolveVisibleModel,
} from '@model/modelOptionsBasic';
import {
  AGENT_CATEGORY,
  DEFAULT_TOOL_CONFIG,
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
  type StreamTabId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import {
  evaluateDelegationGate,
  type NestedDelegationConfig,
} from '@shared/constants/delegationPolicy';
import { formatBytes } from '@shared/utils/string';

// Local imports - tools
import type { ToolResult } from '@tools/result';
import {
  isProposalBypassedForStream,
  isApprovalBypassedForStream,
  enableYoloOnChildStream,
} from '@tools/approval';
import { computeAndWriteWorkflowDiffs } from '@tools/subagentDiffs';
import {
  formatSubagentDelivery,
  formatSubagentError,
  formatSubagentProgress,
  formatFollowUpInstruction,
} from '@tools/subagentResults';
import { isWorktreeSupportEnabled } from '@tools/worktreeConfig';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { defineTool } from '@tools/core/define';

// Local imports - memory
import { displayToStoragePath } from '@tools/memory/memoryUtils';

// Local imports - worktree config

// Local imports - utils
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import { generateExecutionId } from '@utils/core/executionId';

// ============================================================================
// Shared utilities
// ============================================================================

const LOG_CHANNEL = 'DelegationTools';
logger.initialize(LOG_CHANNEL);

const LARGE_BIB_LIMIT_BYTES = 100 * 1024;

// ============================================================================
// Subagent delivery state tracking
// ============================================================================

/**
 * Per-execution delivery gate for subagent result routing.
 *
 * `hasDelivered` prevents duplicate delivery of the same result via both
 * `onBeforeWaiting` and `onCompleted`. Accepted follow-ups mark delivery
 * pending immediately so interrupts before consumption still report back;
 * consuming a follow-up keeps the next cycle pending for `onBeforeWaiting`.
 */
interface SubagentDeliveryState {
  hasDelivered: boolean;
}

const activeSubagentDelivery = new Map<string, SubagentDeliveryState>();

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
    for (let i = 0; i < memories.length; i++) {
      try {
        displayToStoragePath(memories[i]);
      } catch (e) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message:
            e instanceof Error
              ? e.message
              : `Invalid memory path: ${memories[i]}`,
        });
      }
    }
  });

const WORKTREE_DISABLED_MESSAGE =
  "git worktree support is disabled in this workspace. Omit working_directory, or enable 'Allow agents to work in git worktrees' on the Multi-Agent settings tab.";

function ensureWorkingDirectoryExists(dir: string): void {
  try {
    if (AbsoluteFS.statSync(dir).isDirectory()) return;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `working_directory must be an existing directory: ${reason}`,
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
        message: e instanceof Error ? e.message : String(e),
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
        message: e instanceof Error ? e.message : String(e),
      });
      return z.NEVER;
    }
    return trimmed;
  });

/** Get required context fields, throwing if unavailable. */
function getRequiredContext(): ToolRunContext & {
  streamId: StreamTabId;
} {
  const ctx = getCurrentToolRunContext();
  if (!ctx?.streamId) {
    throw new Error(
      'Tool context unavailable. Cannot create proposal without active stream.',
    );
  }
  return ctx as ToolRunContext & { streamId: StreamTabId };
}

/** Build config payload from a proposal. */
function toConfigPayload(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): AgentConfigPayload {
  return {
    ...proposal,
    agentCategory:
      proposal.agentCategory === AGENT_CATEGORY.TOOL_USE
        ? AgentCategory.ToolUse
        : AgentCategory.Workflow,
  };
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
 * Runtime depth gate shared by fresh delegations and resumes.
 * Tool-use flows pass the same max-depth snapshot used for tool resolution so
 * prompt pruning and runtime enforcement derive from one policy snapshot.
 * Direct tool calls fall back to the current workspace policy.
 */
function depthGateError(
  parentDelegationDepth: number,
  configSnapshot?: NestedDelegationConfig,
): ToolResult | null {
  const gate = evaluateDelegationGate(
    parentDelegationDepth,
    configSnapshot ?? readNestedDelegationConfig(),
  );
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
  const parentContext = getCurrentToolRunContext();
  const parentExecutionId = parentContext?.executionId;
  const parentDelegationDepth = parentContext?.delegationDepth ?? 0;
  const runtimeHost = parentContext?.runtimeHost;

  const gated = depthGateError(
    parentDelegationDepth,
    parentContext?.delegationConfig,
  );
  if (gated) return gated;

  const executionId = generateExecutionId();
  const startedAt = Date.now();

  const syntheticConfig = AgentConfigSchema.parse(configPayload);
  await registerExecution(
    executionId,
    syntheticConfig,
    agentName,
    parentExecutionId,
    undefined,
    parentDelegationDepth + 1,
  );

  // Track delivery state in the module-level map so delegate_agent (resume)
  // can find live subagents and enqueue follow-up instructions.
  // The flag prevents duplicate delivery of the same result via both
  // onBeforeWaiting and onCompleted. When a follow-up is consumed, the next
  // onBeforeWaiting will deliver the resumed cycle's result.
  const deliveryState: SubagentDeliveryState = { hasDelivered: false };
  activeSubagentDelivery.set(executionId, deliveryState);
  let childStreamId: StreamTabId | undefined;

  function onProgress(update: SubagentProgressUpdate): void {
    if (deliveryState.hasDelivered) return;
    const msg = formatSubagentProgress(executionId, agentName, update);
    ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
  }

  const promise = executeAgent(configPayload, executionId, {
    runtimeHost,
    isSubagent: true,
    enforceCategory: true,
    parentStreamId: orchestratorStreamId,
    delegationDepth: parentDelegationDepth + 1,
    onStreamResolved: (resolvedStreamId) => {
      childStreamId = resolvedStreamId;
      if (options?.enableYoloOnChild) {
        enableYoloOnChildStream(resolvedStreamId);
      }
    },
    onProgress,
    onFollowUpConsumed: () => {
      deliveryState.hasDelivered = false;
    },
    onBeforeWaiting: async (lastResponse, touchedFiles) => {
      if (deliveryState.hasDelivered || !childStreamId) return;
      const wallTimeMs = Date.now() - startedAt;
      const msg = formatSubagentDelivery(
        agentName,
        {
          category: 'toolUse' as const,
          status: 'stopped' as const,
          lastResponse,
          touchedFiles,
          executionId,
          streamId: childStreamId,
        },
        {
          wallTimeMs,
          workingDirectory: configPayload.workingDirectory ?? undefined,
        },
      );
      // Best-effort persist — must never block delivery or abort the subagent.
      try {
        await getExecutionStore(executionId).writeReport(msg);
      } catch {
        /* storage failure is non-fatal */
      }
      // Mark delivered and enqueue only after the write attempt so that
      // onCompleted can still act as a fallback if we somehow never reach here.
      deliveryState.hasDelivered = true;
      ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
    },
    onCompleted: async (result) => {
      if (deliveryState.hasDelivered) return;
      deliveryState.hasDelivered = true;

      // For workflow results, compute diffs and write them as files to the
      // execution's run directory. The delivery references diff file paths
      // so the orchestrator can read them on demand via /executions/{id}/files/.
      let diffInfos:
        | Awaited<ReturnType<typeof computeAndWriteWorkflowDiffs>>
        | undefined;
      if (result.category === 'workflow' && result.outputs.length > 0) {
        try {
          diffInfos = await computeAndWriteWorkflowDiffs(
            executionId,
            result.outputs,
          );
        } catch {
          // Diff computation failure is non-fatal — deliver without diffs.
        }
      }

      const wallTimeMs = Date.now() - startedAt;
      const msg = formatSubagentDelivery(agentName, result, {
        diffInfos,
        wallTimeMs,
        workingDirectory: configPayload.workingDirectory ?? undefined,
      });
      void getExecutionStore(executionId).writeReport(msg);
      ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
    },
  });
  promise
    .catch((err: unknown) => {
      const wallTimeMs = Date.now() - startedAt;
      const msg = formatSubagentError(executionId, agentName, err, {
        wallTimeMs,
        workingDirectory: configPayload.workingDirectory ?? undefined,
      });
      void getExecutionStore(executionId).writeReport(msg);
      ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
    })
    .finally(() => {
      activeSubagentDelivery.delete(executionId);
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
      const desc =
        agent.name === 'chat'
          ? `${agent.description || 'No description'} Fallback-only: use this only after ruling out every specialized tool-use agent.`
          : agent.description || 'No description';
      const toolsSuffix = agent.tools?.length
        ? `\n  Tools: ${agent.tools.join(', ')}`
        : '';
      return `- ${agent.name}: ${desc}${toolsSuffix}`;
    })
    .join('\n');
}

/** Throw if no visible agent of the given category matches the name. */
function assertVisibleAgent(
  category: 'workflow' | 'toolUse',
  name: string,
): void {
  const visible = getVisibleAgents(category);
  if (visible.some((a) => a.name === name)) return;
  const available = visible.map((a) => a.name).join(', ');
  throw new Error(
    `Unknown ${category} agent '${name}'. Available: ${available}`,
  );
}

/** Build a concise summary of proposal parameters for rejection echo. */
function summarizeProposal(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): string {
  const parts = [`Agent: ${proposal.agent}`, `Model: ${proposal.model}`];
  if ('inputFile' in proposal && proposal.inputFile) {
    parts.push(`File: ${proposal.inputFile}`);
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
        : '\nNo feedback provided. Consider asking the user for guidance.';
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
  if (isProposalBypassedForStream(streamId)) {
    return executeSubagent(toConfigPayload(proposal), agentName, streamId, {
      enableYoloOnChild: true,
      approvalMeta: { autoApproved: true },
    });
  }

  const proposalId = randomUUID();

  const result = await waitForProposal(streamId, {
    proposalId,
    proposal,
  });

  const nonApproveResult = proposalResultToToolResult(
    result,
    agentName,
    proposal,
  );
  if (nonApproveResult) return nonApproveResult;

  // At this point result.action === 'approve' (all other cases returned above)
  const modelOverride = result.action === 'approve' ? result.model : undefined;
  const agentOverride =
    result.action === 'approve' &&
    result.agent &&
    result.agent !== proposal.agent
      ? result.agent
      : undefined;

  // Re-validate against the current registry — between proposal display and
  // approval the agent may have been removed/renamed, or the approval could
  // carry a malformed value. Fail fast so the orchestrator sees the problem
  // synchronously instead of after an async launch.
  if (agentOverride) {
    const visible = getVisibleAgents(proposal.agentCategory);
    if (!visible.some((a) => a.name === agentOverride)) {
      return {
        summary: `Approved agent override '${agentOverride}' is not available`,
        output: `Cannot launch '${agentOverride}': it is not currently a visible ${proposal.agentCategory} agent (removed, renamed, or disabled since the proposal was shown). Re-propose the delegation.`,
        isError: true,
      };
    }
  }

  const effective = {
    ...proposal,
    ...(modelOverride && { model: modelOverride }),
    ...(agentOverride && { agent: agentOverride }),
  };
  const effectiveAgentName = agentOverride ?? agentName;
  return executeSubagent(
    toConfigPayload(effective),
    effectiveAgentName,
    streamId,
    {
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
    },
  );
}

// ============================================================================
// delegate_workflow tool - for document processing agents
// ============================================================================

/** Schema for delegate_workflow tool (document processing). */
const WorkflowAgentInputSchema = z.object({
  agent: z.string().describe('Name of the workflow agent to execute'),
  model: z
    .string()
    .nullish()
    .describe(
      'Model short name (e.g., opus47T, sonnet46T, gpt55, gemini31p). Defaults to the current model if omitted.',
    ),
  instruction: z.string().describe('Plain prose instruction for the agent'),
  inputFile: z.string().describe('Primary input file to process (required)'),
  inputFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional input files'),
  referenceFile: z
    .string()
    .nullable()
    .prefault(null)
    .describe(
      'Reference file providing guidance or examples (not modified). Do not put .bib files here.',
    ),
  referenceFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional reference files'),
  auxiliaryFile: z
    .string()
    .nullable()
    .prefault(null)
    .describe(
      'Auxiliary file for supplementary content like bibliographies (.bib files).',
    ),
  auxiliaryFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional auxiliary files'),
  mediaFile: z
    .string()
    .nullable()
    .prefault(null)
    .describe('Media file for images/figures'),
  mediaFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional media files'),
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
  const basename = filePath.replaceAll('\\', '/').split('/').at(-1);
  return basename?.toLowerCase().endsWith('.bib') ?? false;
}

function getReferenceAndAuxiliaryFiles(input: WorkflowAgentInput): string[] {
  return [
    input.referenceFile,
    ...input.referenceFiles,
    input.auxiliaryFile,
    ...input.auxiliaryFiles,
  ].filter(
    (path): path is string => typeof path === 'string' && path.length > 0,
  );
}

/** Reject workflow proposals that attach oversized bibliography files. */
export async function rejectOversizedBibAttachments(
  input: WorkflowAgentInput,
): Promise<ToolResult | null> {
  const bibFiles = getReferenceAndAuxiliaryFiles(input).filter(isBibFile);

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
    () => `Delegate a task to a workflow agent. Workflow agents receive structured file parameters (input, reference, auxiliary, media, output) and rewrite the entire input file from start to finish in fixed rounds. Best for uniform whole-document operations: grammar correction, style polishing, figure generation, document merging. NOT suitable for tasks requiring interactive tool use, exploration, or selective edits—use delegate_agent for those.

Available agents:
${formatAgentList(getVisibleAgents('workflow'))}

Agent selection: match the task to the most specific agent. Read each agent's description carefully. Do NOT default to correct for everything—correct is strictly for proofreading (typos, grammar, LaTeX formatting). For applying review suggestions use apply; for adding derivations use devise; for instruction-driven rewriting use polish; for critical review use criticize. Use the agent whose description best matches the task.

Available models: ${getVisibleModels().join(', ')}
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Extraction attachments — automatically discover and attach assets from input LaTeX file(s):
- extractFigures=true: Extract \\includegraphics/\\begin{overpic} figures and attach as media files.
- extractTikz=true: Compile TikZ figures into standalone PDFs and attach as media files.
All extraction options merge with explicitly provided files and are non-fatal on failure.

Example: agent=correct, inputFile=paper.tex, extractFigures=true, instruction="This research paper proposes a new quantum error correction scheme. Please fix grammar errors, improve sentence clarity, and ensure consistent terminology throughout. Pay particular attention to the abstract and introduction where the key contributions are summarized."`,
  schema: WorkflowAgentInputSchema,
}) {
  protected async execute(input: WorkflowAgentInput): Promise<ToolResult> {
    assertVisibleAgent('workflow', input.agent);
    const ctx = getRequiredContext();

    // Resolve model: explicit input → parent model → first visible model
    const model = resolveVisibleModel(input.model ?? ctx.model ?? '');

    // Validate inputFile is provided
    if (!input.inputFile) {
      throw new Error('inputFile is required for workflow agents.');
    }

    // Validate all file paths exist (parallel for performance)
    const toValidate = (
      single: string | null | undefined,
      arr: string[],
      label: string,
    ): { path: string; label: string }[] =>
      [single, ...arr]
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((path) => ({ path, label }));

    const filesToValidate = [
      ...toValidate(input.inputFile, input.inputFiles, 'Input file'),
      ...toValidate(
        input.referenceFile,
        input.referenceFiles,
        'Reference file',
      ),
      ...toValidate(
        input.auxiliaryFile,
        input.auxiliaryFiles,
        'Auxiliary file',
      ),
      ...toValidate(input.mediaFile, input.mediaFiles, 'Media file'),
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
      agent: input.agent,
      model,
      instruction: input.instruction,
      inputFile: input.inputFile,
      inputFiles: input.inputFiles,
      referenceFile: input.referenceFile,
      referenceFiles: input.referenceFiles,
      auxiliaryFile: input.auxiliaryFile,
      auxiliaryFiles: input.auxiliaryFiles,
      mediaFile: input.mediaFile,
      mediaFiles: input.mediaFiles,
      outputFiles: input.outputFiles,
      toolConfig: {
        ...DEFAULT_TOOL_CONFIG,
        autoExtractFigure: input.extractFigures ?? false,
        autoExtractTikzFigure: input.extractTikz ?? false,
      },
      memories: input.memories,
    } satisfies WorkflowAgentProposal);

    return proposeAndExecute(proposal, input.agent, ctx.streamId);
  }
}

// ============================================================================
// delegate_agent tool - for interactive assistants
// ============================================================================

/** Schema for delegate_agent tool (tool-use agents). */
const DelegateAgentInputSchema = z.object({
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
      'Model short name (e.g., opus47T, sonnet46T, gpt55, gemini31p). Defaults to the current model if omitted.',
    ),
  instruction: z
    .string()
    .describe(
      'Plain prose instruction for the agent. For new delegations, include file paths naturally. For resumes, reference previous work freely — the subagent retains its full history.',
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

Available agents:
${formatAgentList(getVisibleAgents('toolUse'))}

Agent selection: choose the most specific agent whose description matches the task. Specialized agents have domain-specific tools and focused prompts that produce better results for matching tasks. Do not choose chat just because the task is a targeted edit, file operation, or mixed research/editing request; choose chat only when no listed specialized agent covers the work, and state that reason in the instruction.

Available models: ${getVisibleModels().join(', ')}
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

    assertVisibleAgent('toolUse', input.agent);

    const ctx = getRequiredContext();

    // Resolve model: explicit input → parent model → first visible model
    const model = resolveVisibleModel(input.model ?? ctx.model ?? '');

    // Construct tool-use proposal (no file fields)
    const proposal = ToolUseAgentProposalSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: input.agent,
      model,
      instruction: input.instruction,
      memories: input.memories,
      workingDirectory: input.working_directory,
    } satisfies ToolUseAgentProposal);

    return proposeAndExecute(proposal, input.agent, ctx.streamId);
  }

  /** Queue follow-up instructions for a tool-use subagent. */
  private async resumeAgent(
    executionId: string,
    instruction: string,
  ): Promise<ToolResult> {
    const parentContext = getCurrentToolRunContext();
    const parentDelegationDepth = parentContext?.delegationDepth ?? 0;
    const gated = depthGateError(
      parentDelegationDepth,
      parentContext?.delegationConfig,
    );
    if (gated) return gated;

    const handle = getHandle(executionId);
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

    const deliveryState = activeSubagentDelivery.get(executionId);
    if (!deliveryState) {
      throw new Error(
        `Execution '${executionId}' is no longer tracked for delivery. It may have already completed.`,
      );
    }

    const framedInstruction = formatFollowUpInstruction(instruction);
    const result = await sendFollowUp(handle.childStreamId, framedInstruction);

    switch (result.status) {
      case 'sent':
        deliveryState.hasDelivered = false;
        return {
          summary: `Follow-up sent to '${handle.agentName}'`,
          output: [
            `Follow-up instruction sent to '${handle.agentName}'. The subagent will process it and deliver a new result automatically.`,
            `Execution ID: ${executionId}`,
          ].join('\n'),
        };
      case 'queued':
        deliveryState.hasDelivered = false;
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
