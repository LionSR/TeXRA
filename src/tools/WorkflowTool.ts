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
import { proposalCoordinator } from '@agent/runtime/WorkflowAgentProposalCoordinator';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

// Local imports - event bus (after utils per import order rules)
import {
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
} from '@eventBus/types';

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

/** Format agent entry for description. */
function formatAgentEntry(agent: {
  name: string;
  description?: string;
  tools?: string[];
}): string {
  const desc = agent.description || 'No description';
  if (agent.tools?.length) {
    return `- ${agent.name}: ${desc}\n  Tools: ${agent.tools.join(', ')}`;
  }
  return `- ${agent.name}: ${desc}`;
}

/** Format agent list for tool descriptions. */
function formatAgentList(
  agents: { name: string; description?: string; tools?: string[] }[],
): string {
  return agents.map(formatAgentEntry).join('\n');
}

/** Build workflow agents list for description. */
function buildWorkflowAgentsList(): string {
  return formatAgentList(getVisibleWorkflowAgents());
}

/** Build tool-use agents list for description. */
function buildToolUseAgentsList(): string {
  return formatAgentList(getVisibleToolUseAgents());
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
      const feedback = result.feedback
        ? `\n\nUser feedback: ${result.feedback}`
        : '';
      return {
        summary: `User rejected '${agentName}' ${label}`,
        output: `The ${context === 'workflow' ? 'workflow agent proposal' : 'delegation proposal'} was rejected.${feedback}`,
        isError: true,
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
  model: z.string().prefault('gemini3p').describe('Model to use'),
  instruction: z
    .string()
    .describe('Self-contained instruction with all context needed'),
  inputFile: z.string().describe('Primary input file to process (required)'),
  inputFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional input files'),
  referenceFile: z.string().nullish().describe('Reference file for context'),
  referenceFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional reference files'),
  auxiliaryFile: z
    .string()
    .nullish()
    .describe('Auxiliary file for supplementary content'),
  auxiliaryFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional auxiliary files'),
  mediaFile: z.string().nullish().describe('Media file for images/figures'),
  mediaFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional media files'),
  outputFiles: z.array(z.string()).prefault([]).describe('Output file paths'),
  useMultipleOutputs: z
    .boolean()
    .prefault(false)
    .describe('Enable multiple outputs mode'),
});

export type WorkflowAgentInput = z.infer<typeof WorkflowAgentInputSchema>;

/** Tool for proposing workflow agent executions (document processing). */
export class WorkflowAgentTool extends defineTool({
  name: 'propose_workflow',
  description:
    () => `Propose running a workflow agent for document processing. Creates a proposal for user approval in the ProgressBoard.

**IMPORTANT:** The agent runs in a NEW session WITHOUT your context. Write SELF-SUFFICIENT instructions:
- Include ALL relevant context, goals, and constraints
- The agent cannot see your conversation or memory
- Provide enough detail for the agent to succeed independently

**Available Workflow Agents:**
${buildWorkflowAgentsList()}

**Usage:**
- Set agent name and inputFile (required)
- Write a complete, self-contained instruction
- Optionally specify outputFiles for custom paths

**Example:**
agent="correct"
inputFile="/workspace/paper.tex"
instruction="This is a research paper about quantum computing. Fix grammar errors, improve sentence clarity, and ensure consistent terminology. Focus on the abstract and introduction."

**User Response Options:**
- Approve: Run immediately
- Reject: Cancel with feedback (adjust and retry)
- Setup: Edit in main view before running`,
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
      agentCategory: 'workflow',
      agent: input.agent,
      model: input.model,
      instruction: input.instruction,
      inputFile: input.inputFile,
      inputFiles: input.inputFiles,
      referenceFile: input.referenceFile ?? null,
      referenceFiles: input.referenceFiles,
      auxiliaryFile: input.auxiliaryFile ?? null,
      auxiliaryFiles: input.auxiliaryFiles,
      mediaFile: input.mediaFile ?? null,
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
  model: z.string().prefault('gemini3p').describe('Model to use'),
  instruction: z
    .string()
    .describe(
      'Self-contained instruction with all context. Include file paths in the text.',
    ),
});

export type DelegateAgentInput = z.infer<typeof DelegateAgentInputSchema>;

/** Tool for delegating tasks to tool-use agents (interactive assistants). */
export class DelegateAgentTool extends defineTool({
  name: 'propose_agent',
  description:
    () => `Delegate a task to another tool-use agent. Creates a proposal for user approval in the ProgressBoard.

**IMPORTANT:** The delegated agent runs in a NEW session WITHOUT your context. Write SELF-SUFFICIENT instructions:
- Include ALL relevant context, file paths, goals, and constraints
- The agent cannot see your conversation or memory
- Mention file paths naturally in the instruction text
- Provide enough detail for the agent to succeed independently

**Available Tool-Use Agents:**
${buildToolUseAgentsList()}

**Usage:**
- Set agent name and instruction (both required)
- Include file paths and context IN the instruction
- The delegated agent uses its own tools (read_file, etc.) to access files

**Example:**
agent="search"
instruction="Read the paper at /workspace/paper.tex which proposes a new attention mechanism called FlashAttention-3. Search the web for 3-5 related papers on efficient transformer attention mechanisms that we should cite in the related work section."

**User Response Options:**
- Approve: Run immediately
- Reject: Cancel with feedback (adjust and retry)
- Setup: Edit in main view before running`,
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
      agentCategory: 'toolUse',
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
