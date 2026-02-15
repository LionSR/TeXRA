/**
 * Tools for delegating agent executions from tool-use agents.
 * Two separate tools for clean separation of concerns:
 * - delegate_workflow: For workflow agents (full-document transformation with file I/O)
 * - delegate_agent: For tool-use agents (targeted edits, research, interactive work)
 *
 * All subagents execute asynchronously — result delivered via follow-up queue.
 */

// Third-party imports
import { randomUUID } from 'crypto';
import { z } from 'zod';

// Local imports - agent
import {
  AGENT_CATEGORY,
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
  type StreamTabId,
} from '@shared/schemas';
import { getExecutionStore, registerExecution } from '@agent/storage';
import { getAgent, getVisibleAgents } from '@agent/index/agentRegistry';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { executeAgent } from '@agent/runtime/executeAgent';
import { proposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import {
  getCurrentToolFileInteractionContext,
  type ToolFileInteractionContext,
} from '@agent/toolUse/ToolFileInteractionContext';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - model
import {
  getVisibleModels,
  resolveVisibleModel,
} from '@model/computeModelOptions';

// Local imports - tools
import { ToolResult } from '@tools/result';
import {
  isSuperYoloFeatureEnabled,
  isProposalBypassedForStream,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import {
  formatSubagentDelivery,
  formatSubagentError,
} from '@tools/subagentResults';
import { defineTool } from '@tools/core/define';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';
import { generateExecutionId } from '@utils/core/executionId';

// ============================================================================
// Shared utilities
// ============================================================================

const LOG_CHANNEL = 'WorkflowTool';
logger.initialize(LOG_CHANNEL);

/** Get required context fields, throwing if unavailable. */
function getRequiredContext(): ToolFileInteractionContext & {
  streamId: StreamTabId;
} {
  const ctx = getCurrentToolFileInteractionContext();
  if (!ctx?.streamId) {
    throw new Error(
      'Tool context unavailable. Cannot create proposal without active stream.',
    );
  }
  return ctx as ToolFileInteractionContext & { streamId: StreamTabId };
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
  options?: { enableYoloOnChild?: boolean },
): Promise<ToolResult> {
  const executionId = generateExecutionId();

  const ctx = getCurrentToolFileInteractionContext();
  const parentExecutionId = ctx?.executionId;
  const syntheticConfig = AgentConfigSchema.parse(configPayload);
  await registerExecution(
    executionId,
    syntheticConfig,
    agentName,
    parentExecutionId,
  );

  // Track whether result has already been delivered (via onBeforeWaiting)
  // to avoid duplicate delivery when the promise eventually resolves.
  let hasDelivered = false;
  let childStreamId: StreamTabId | undefined;

  const promise = executeAgent(configPayload, executionId, {
    isSubagent: true,
    parentStreamId: orchestratorStreamId,
    onStreamResolved: (resolvedStreamId) => {
      childStreamId = resolvedStreamId;
      if (options?.enableYoloOnChild) {
        setToolEditApprovalSessionBypass(resolvedStreamId, true);
      }
    },
    onBeforeWaiting: (lastResponse) => {
      if (hasDelivered || !childStreamId) return;
      hasDelivered = true;
      const msg = formatSubagentDelivery(agentName, {
        category: 'toolUse' as const,
        status: 'stopped' as const,
        lastResponse,
        executionId,
        streamId: childStreamId,
      });
      void getExecutionStore(executionId).write('report', msg);
      ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
    },
    onCompleted: (result) => {
      if (hasDelivered) return;
      hasDelivered = true;
      const msg = formatSubagentDelivery(agentName, result);
      void getExecutionStore(executionId).write('report', msg);
      ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
    },
  });
  promise.catch((err: unknown) => {
    const msg = formatSubagentError(executionId, agentName, err);
    void getExecutionStore(executionId).write('report', msg);
    ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
  });
  return {
    summary: `Launched '${agentName}' (async)`,
    output: [
      `Subagent '${agentName}' launched. Result will be delivered automatically as a follow-up message when complete.`,
      `Execution ID: ${executionId}`,
      `To check intermediate progress: executions tool with path=/executions/${executionId} and action=wait (waits for next status change).`,
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

/** Convert proposal result to ToolResult. Returns null if approved. */
function proposalResultToToolResult(
  result: Awaited<ReturnType<typeof proposalCoordinator.waitForProposal>>,
  agentName: string,
  context: 'workflow' | 'delegation',
): ToolResult | null {
  const label = context === 'workflow' ? 'proposal' : 'delegation';

  switch (result.action) {
    case 'reject': {
      const feedback = result.feedback?.trim();
      return {
        summary: `User rejected '${agentName}' ${label}`,
        output: `The ${label} was rejected.`,
        isError: true,
        ...(feedback ? { userInstruction: feedback } : {}),
      };
    }
    case 'timeout':
      return {
        summary: `'${agentName}' ${label} timed out`,
        output: 'The proposal timed out waiting for user approval.',
        isError: true,
      };
    case 'setup':
      return {
        summary: `User opened '${agentName}' for editing`,
        output:
          'Proposal opened in main view for editing. User will run manually.',
      };
    case 'approve':
      return null;
  }
}

/**
 * Shared proposal-or-bypass flow used by both delegate_workflow and delegate_agent.
 *
 * If Super YOLO is active for this stream, skips the proposal and launches immediately.
 * Otherwise, waits for user approval via the proposal coordinator.
 */
async function proposeAndExecute(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
  agentName: string,
  streamId: StreamTabId,
  context: 'workflow' | 'delegation',
): Promise<ToolResult> {
  if (isSuperYoloFeatureEnabled() && isProposalBypassedForStream(streamId)) {
    return executeSubagent(toConfigPayload(proposal), agentName, streamId, {
      enableYoloOnChild: true,
    });
  }

  const proposalId = randomUUID();

  const result = await proposalCoordinator.waitForProposal(streamId, {
    proposalId,
    proposal,
  });

  const nonApproveResult = proposalResultToToolResult(
    result,
    agentName,
    context,
  );
  if (nonApproveResult) return nonApproveResult;

  // At this point result.action === 'approve' (all other cases returned above)
  const effective =
    result.action === 'approve' && result.model
      ? { ...proposal, model: result.model }
      : proposal;
  return executeSubagent(toConfigPayload(effective), agentName, streamId);
}

// ============================================================================
// delegate_workflow tool - for document processing agents
// ============================================================================

/** Schema for delegate_workflow tool (document processing). */
const WorkflowAgentInputSchema = z.object({
  agent: z.string().describe('Name of the workflow agent to execute'),
  model: z
    .string()
    .optional()
    .describe(
      'Model short name (e.g., opus46T, sonnet45T, gpt52, gemini3p). Defaults to the current model if omitted. User can change via dropdown.',
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
  outputFiles: z
    .array(z.string())
    .prefault([])
    .describe(
      'Output file paths. Must be a subset of input files—never create new files or change format. Leave empty for default suffix-based outputs.',
    ),
  useMultipleOutputs: z
    .boolean()
    .prefault(false)
    .describe(
      'Set true when outputFiles has multiple entries. Enables multi-file extraction from agent response.',
    ),
});

export type WorkflowAgentInput = z.infer<typeof WorkflowAgentInputSchema>;

/** Tool for delegating tasks to workflow agents (document processing). */
export class WorkflowAgentTool extends defineTool({
  name: 'delegate_workflow',
  description:
    () => `Delegate a task to a workflow agent for full-document transformation. The agent rewrites the entire input file from start to finish, preserving its structure and section order. Best for uniform operations across a whole document (grammar correction, style polishing, figure generation, document merging, creating presentations from papers). NOT suitable for targeted edits to specific parts of a document—use delegate_agent for that.

Available agents:
${formatAgentList(getVisibleAgents('workflow'))}

Available models: ${getVisibleModels().join(', ')}
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Example: agent=correct, inputFile=paper.tex, instruction="This research paper proposes a new quantum error correction scheme. Please fix grammar errors, improve sentence clarity, and ensure consistent terminology throughout. Pay particular attention to the abstract and introduction where the key contributions are summarized."`,
  schema: WorkflowAgentInputSchema,
}) {
  protected async execute(input: WorkflowAgentInput): Promise<ToolResult> {
    // Validate agent exists and is a workflow agent
    const agentEntry = getAgent(input.agent);
    if (!agentEntry) {
      const available = getVisibleAgents('workflow')
        .map((a) => a.name)
        .join(', ');
      throw new Error(
        `Unknown workflow agent '${input.agent}'. Available: ${available}`,
      );
    }

    if (agentEntry.category !== AgentCategory.Workflow) {
      throw new Error(
        `'${input.agent}' is not a workflow agent. Use delegate_agent for tool-use agents.`,
      );
    }

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

    // Construct workflow proposal
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
      useMultipleOutputs: input.useMultipleOutputs,
    } satisfies WorkflowAgentProposal);

    return proposeAndExecute(proposal, input.agent, ctx.streamId, 'workflow');
  }
}

// ============================================================================
// delegate_agent tool - for interactive assistants
// ============================================================================

/** Schema for delegate_agent tool (tool-use agents). */
const DelegateAgentInputSchema = z.object({
  agent: z.string().describe('Name of the tool-use agent to delegate to'),
  model: z
    .string()
    .optional()
    .describe(
      'Model short name (e.g., opus46T, sonnet45T, gpt52, gemini3p). Defaults to the current model if omitted. User can change via dropdown.',
    ),
  instruction: z
    .string()
    .describe('Plain prose instruction with file paths included naturally'),
});

export type DelegateAgentInput = z.infer<typeof DelegateAgentInputSchema>;

/** Tool for delegating tasks to tool-use agents (interactive assistants). */
export class DelegateAgentTool extends defineTool({
  name: 'delegate_agent',
  description:
    () => `Delegate a task to a tool-use agent. The agent has its own tools (file reading, editing, search, bash) and works interactively—use it for targeted edits, fixing specific issues in a document, research, exploration, multi-step investigations, or any task that benefits from reading files and making selective changes. Prefer this over delegate_workflow when you need to edit specific parts of a document rather than rewrite it entirely.

Available agents:
${formatAgentList(getVisibleAgents('toolUse'))}

Available models: ${getVisibleModels().join(', ')}
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Example: agent=chat, instruction="The presentation at slides/talk.tex has incorrect citations on slides 3 and 7. Please read the file, fix the \\cite commands to reference the correct BibTeX keys from refs.bib, and ensure the bibliography slide is consistent."`,
  schema: DelegateAgentInputSchema,
}) {
  protected async execute(input: DelegateAgentInput): Promise<ToolResult> {
    // Validate agent exists and is a tool-use agent
    const agentEntry = getAgent(input.agent);
    if (!agentEntry) {
      const available = getVisibleAgents('toolUse')
        .map((a) => a.name)
        .join(', ');
      throw new Error(
        `Unknown tool-use agent '${input.agent}'. Available: ${available}`,
      );
    }

    if (agentEntry.category !== AgentCategory.ToolUse) {
      throw new Error(
        `'${input.agent}' is not a tool-use agent. Use delegate_workflow for document processing.`,
      );
    }

    const ctx = getRequiredContext();

    // Resolve model: explicit input → parent model → first visible model
    const model = resolveVisibleModel(input.model ?? ctx.model ?? '');

    // Construct tool-use proposal (no file fields)
    const proposal = ToolUseAgentProposalSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: input.agent,
      model,
      instruction: input.instruction,
    } satisfies ToolUseAgentProposal);

    return proposeAndExecute(proposal, input.agent, ctx.streamId, 'delegation');
  }
}
