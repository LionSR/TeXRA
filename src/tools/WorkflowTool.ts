/**
 * Tools for proposing agent executions from tool-use agents.
 * Two separate tools for clean separation of concerns:
 * - workflow_agent: For workflow agents (document processing with file I/O)
 * - delegate_agent: For tool-use agents (interactive assistants)
 */

// Third-party imports
import { randomUUID } from 'crypto';
import { z } from 'zod';

// Local imports - agent
import {
  getAgent,
  getVisibleWorkflowAgents,
  getVisibleToolUseAgents,
} from '@agent/index/agentRegistry';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { executeAgent } from '@agent/runtime/executeAgent';
import { proposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

// Local imports - shared schemas
import {
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
} from '@shared/schemas';

// ============================================================================
// Shared utilities
// ============================================================================

const LOG_CHANNEL = 'WorkflowTool';
logger.initialize(LOG_CHANNEL);

/** Execute agent with error logging. */
function executeAgentWithLogging(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): void {
  executeAgent(proposal).catch((error: unknown) => {
    logger.error(LOG_CHANNEL, `Failed to start agent '${proposal.agent}'`, {
      data: error,
    });
  });
}

/** Get streamId from context, throwing if unavailable. */
function getRequiredStreamId(): string {
  const streamId = getCurrentToolFileInteractionContext()?.streamId;
  if (!streamId) {
    throw new Error(
      'Tool context unavailable. Cannot create proposal without active stream.',
    );
  }
  return streamId;
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

// ============================================================================
// workflow_agent tool - for document processing agents
// ============================================================================

/** Schema for workflow_agent tool (document processing). */
const WorkflowAgentInputSchema = z.object({
  agent: z.string().describe('Name of the workflow agent to execute'),
  model: z
    .string()
    .prefault('gemini3p')
    .describe(
      'Model short name (e.g., gemini3p, sonnet45, opus45, gpt45, o3). User can change via dropdown.',
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

/** Tool for proposing workflow agent executions (document processing). */
export class WorkflowAgentTool extends defineTool({
  name: 'propose_workflow',
  description: () => `Propose a workflow agent for document processing.

Available agents:
${formatAgentList(getVisibleWorkflowAgents())}

Example: agent=correct, inputFile=paper.tex, instruction="This research paper proposes a new quantum error correction scheme. Please fix grammar errors, improve sentence clarity, and ensure consistent terminology throughout. Pay particular attention to the abstract and introduction where the key contributions are summarized."`,
  schema: WorkflowAgentInputSchema,
}) {
  protected async execute(input: WorkflowAgentInput): Promise<ToolResult> {
    // Validate agent exists and is a workflow agent
    const agentEntry = getAgent(input.agent);
    if (!agentEntry) {
      const available = getVisibleWorkflowAgents()
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
      model: input.model,
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

    const streamId = getRequiredStreamId();
    const proposalId = randomUUID();

    const result = await proposalCoordinator.waitForProposal(streamId, {
      proposalId,
      proposal,
    });

    const nonApproveResult = proposalResultToToolResult(
      result,
      input.agent,
      'workflow',
    );
    if (nonApproveResult) return nonApproveResult;

    // Approved - execute with error logging
    executeAgentWithLogging(proposal);

    const outputInfo =
      input.outputFiles.length > 0
        ? `Output: ${input.outputFiles.join(', ')}`
        : 'Output: default location';

    return {
      summary: `Started '${input.agent}' on ${input.inputFile}`,
      output: [
        `Workflow agent '${input.agent}' started.`,
        `Input: ${input.inputFile}`,
        `Model: ${input.model}`,
        outputInfo,
        'Monitor ProgressBoard for status.',
      ].join('\n'),
    };
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
    .prefault('gemini3p')
    .describe(
      'Model short name (e.g., gemini3p, sonnet45, opus45, gpt45, o3). User can change via dropdown.',
    ),
  instruction: z
    .string()
    .describe('Plain prose instruction with file paths included naturally'),
});

export type DelegateAgentInput = z.infer<typeof DelegateAgentInputSchema>;

/** Tool for delegating tasks to tool-use agents (interactive assistants). */
export class DelegateAgentTool extends defineTool({
  name: 'propose_agent',
  description:
    () => `Propose a tool-use agent for exploration or research tasks.

Available agents:
${formatAgentList(getVisibleToolUseAgents())}

Example: agent=search, instruction="The paper at paper.tex proposes a new attention mechanism called FlashAttention-3 that reduces memory complexity from quadratic to linear. Please search the web for three to five related papers on efficient transformer attention mechanisms, particularly those addressing memory efficiency or linear attention, that we should cite in the related work section."`,
  schema: DelegateAgentInputSchema,
}) {
  protected async execute(input: DelegateAgentInput): Promise<ToolResult> {
    // Validate agent exists and is a tool-use agent
    const agentEntry = getAgent(input.agent);
    if (!agentEntry) {
      const available = getVisibleToolUseAgents()
        .map((a) => a.name)
        .join(', ');
      throw new Error(
        `Unknown tool-use agent '${input.agent}'. Available: ${available}`,
      );
    }

    if (agentEntry.category !== AgentCategory.ToolUse) {
      throw new Error(
        `'${input.agent}' is not a tool-use agent. Use workflow_agent for document processing.`,
      );
    }

    // Construct tool-use proposal (no file fields)
    const proposal = ToolUseAgentProposalSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: input.agent,
      model: input.model,
      instruction: input.instruction,
    } satisfies ToolUseAgentProposal);

    const streamId = getRequiredStreamId();
    const proposalId = randomUUID();

    const result = await proposalCoordinator.waitForProposal(streamId, {
      proposalId,
      proposal,
    });

    const nonApproveResult = proposalResultToToolResult(
      result,
      input.agent,
      'delegation',
    );
    if (nonApproveResult) return nonApproveResult;

    // Approved - execute with error logging
    executeAgentWithLogging(proposal);

    return {
      summary: `Delegated task to '${input.agent}'`,
      output: [
        `Tool-use agent '${input.agent}' started.`,
        `Model: ${input.model}`,
        `Task: ${input.instruction.slice(0, 100)}${input.instruction.length > 100 ? '...' : ''}`,
        'Monitor ProgressBoard for status.',
      ].join('\n'),
    };
  }
}
