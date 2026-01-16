/**
 * Workflow tool for proposing workflow agent executions from tool-use agents.
 *
 * This tool allows tool-use agents to invoke workflow agents (like 'correct',
 * 'polish', 'draw') on files, enabling sophisticated multi-agent workflows.
 */

// Third-party imports
import { randomUUID } from 'crypto';
import { z } from 'zod';

// Local imports - agent
import {
  getAgent,
  getWorkflowAgents,
  getVisibleWorkflowAgents,
} from '@agent/index/agentRegistry';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { executeAgent } from '@agent/runtime/executeAgent';
import { proposalCoordinator } from '@agent/runtime/WorkflowAgentProposalCoordinator';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import {
  WorkflowAgentProposalSchema,
  type WorkflowAgentProposal,
} from '@eventBus/types';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

/**
 * Schema for the workflow_agent tool input.
 *
 * Derived from WorkflowAgentProposalSchema with tool-specific modifications:
 * - Adds defaults via .prefault() for optional arrays and booleans
 * - Uses .nullish() instead of .nullable() for API compatibility
 * - Adds descriptions for tool documentation
 */
const WorkflowAgentInputSchema = WorkflowAgentProposalSchema.extend({
  agent: z.string().describe('Name of the workflow agent to execute'),
  model: z
    .string()
    .prefault('gemini3p')
    .describe('Model to use for agent execution'),
  instruction: z.string().describe('Instruction for the workflow agent'),
  inputFile: z.string().describe('Path to the primary input file'),
  inputFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional input file paths'),
  referenceFile: z
    .string()
    .nullish()
    .describe('Reference file path for additional context'),
  referenceFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional reference file paths'),
  auxiliaryFile: z
    .string()
    .nullish()
    .describe('Auxiliary file path for supplementary content'),
  auxiliaryFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional auxiliary file paths'),
  mediaFile: z.string().nullish().describe('Media file path for images/figures'),
  mediaFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional media file paths'),
  outputFiles: z
    .array(z.string())
    .prefault([])
    .describe('Desired output file paths'),
  useMultipleOutputs: z
    .boolean()
    .prefault(false)
    .describe('Enable multiple outputs mode for agents that support it'),
});

export type WorkflowAgentInput = z.infer<typeof WorkflowAgentInputSchema>;

/**
 * Tool for proposing workflow agent executions from tool-use agents.
 *
 * This tool enables tool-use agents to invoke workflow agents like 'correct',
 * 'polish', or 'draw' to process files. The workflow agent runs in the background
 * and results are saved to the specified output files.
 *
 * Use cases:
 * - Processing LaTeX documents with specialized agents
 * - Chaining agent operations in complex workflows
 * - Delegating specific tasks to purpose-built agents
 */
export class WorkflowAgentTool extends defineTool({
  name: 'workflow_agent',
  description: `Execute a workflow agent to process files.

This tool invokes specialized workflow agents (like 'correct', 'polish', 'draw') to process documents. The agent runs in the background and saves results to the output files.

Available workflow agents and their purposes:
- correct: Fix grammar, spelling, and LaTeX errors
- polish: Improve writing quality and clarity
- draw: Generate vector graphics from descriptions
- ocr: Extract text from images

Parameters:
- agent: Name of the workflow agent to execute
- model: Model to use (default: gemini3p)
- instruction: What the agent should do
- inputFile: Primary file to process
- inputFiles: Additional input files (optional)
- referenceFile: Reference file for context (optional)
- referenceFiles: Additional reference files (optional)
- auxiliaryFile: Auxiliary file for supplementary content (optional)
- auxiliaryFiles: Additional auxiliary files (optional)
- mediaFile: Media file for images/figures (optional)
- mediaFiles: Additional media files (optional)
- outputFiles: Where to save results (optional)
- useMultipleOutputs: Generate multiple output files (optional)

The proposal is shown in the ProgressBoard for review. User can approve or reject before execution.`,
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
        `Unknown agent '${input.agent}'. Available workflow agents: ${available}`,
      );
    }

    if (agentEntry.category !== AgentCategory.Workflow) {
      throw new Error(
        `Agent '${input.agent}' is not a workflow agent. ` +
          `Only workflow agents can be invoked with this tool.`,
      );
    }

    // Validate input file exists
    const inputExists = await WorkspaceFS.exists(input.inputFile);
    if (!inputExists) {
      throw new Error(`Input file not found: ${input.inputFile}`);
    }

    // Validate additional input files exist
    for (const file of input.inputFiles) {
      const exists = await WorkspaceFS.exists(file);
      if (!exists) {
        throw new Error(`Additional input file not found: ${file}`);
      }
    }

    // Validate reference file if provided
    if (input.referenceFile) {
      const refExists = await WorkspaceFS.exists(input.referenceFile);
      if (!refExists) {
        throw new Error(`Reference file not found: ${input.referenceFile}`);
      }
    }

    // Validate additional reference files
    for (const file of input.referenceFiles) {
      const exists = await WorkspaceFS.exists(file);
      if (!exists) {
        throw new Error(`Reference file not found: ${file}`);
      }
    }

    // Validate auxiliary file if provided
    if (input.auxiliaryFile) {
      const auxExists = await WorkspaceFS.exists(input.auxiliaryFile);
      if (!auxExists) {
        throw new Error(`Auxiliary file not found: ${input.auxiliaryFile}`);
      }
    }

    // Validate additional auxiliary files
    for (const file of input.auxiliaryFiles) {
      const exists = await WorkspaceFS.exists(file);
      if (!exists) {
        throw new Error(`Auxiliary file not found: ${file}`);
      }
    }

    // Validate media file if provided
    if (input.mediaFile) {
      const mediaExists = await WorkspaceFS.exists(input.mediaFile);
      if (!mediaExists) {
        throw new Error(`Media file not found: ${input.mediaFile}`);
      }
    }

    // Validate additional media files
    for (const file of input.mediaFiles) {
      const exists = await WorkspaceFS.exists(file);
      if (!exists) {
        throw new Error(`Media file not found: ${file}`);
      }
    }

    // Build workflow agent proposal
    const proposal: WorkflowAgentProposal = {
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
    };

    // Get stream ID from tool execution context
    const context = getCurrentToolFileInteractionContext();
    const streamId = context?.streamId ?? '';

    // Generate unique proposal ID
    const proposalId = randomUUID();

    // Wait for user approval
    const result = await proposalCoordinator.waitForUserAction(streamId, {
      proposalId,
      proposal,
    });

    if (result.action === 'reject') {
      return {
        summary: `User rejected workflow agent '${input.agent}' proposal`,
        output: 'The proposed workflow agent execution was rejected by the user.',
        isError: true,
      };
    }

    if (result.action === 'timeout') {
      return {
        summary: `Workflow agent '${input.agent}' proposal timed out`,
        output:
          'The proposed workflow agent execution timed out waiting for user approval.',
        isError: true,
      };
    }

    // User approved - execute the workflow agent
    const agentConfig = {
      agent: proposal.agent,
      model: proposal.model,
      instruction: proposal.instruction,
      inputFile: proposal.inputFile,
      inputFiles: proposal.inputFiles,
      referenceFile: proposal.referenceFile,
      referenceFiles: proposal.referenceFiles,
      auxiliaryFile: proposal.auxiliaryFile,
      auxiliaryFiles: proposal.auxiliaryFiles,
      mediaFile: proposal.mediaFile,
      mediaFiles: proposal.mediaFiles,
      outputFiles: proposal.outputFiles,
      useMultipleOutputs: proposal.useMultipleOutputs,
    };

    // Execute the workflow agent (runs in background)
    void executeAgent(agentConfig);

    // Build response
    const outputInfo =
      input.outputFiles.length > 0
        ? `Output will be saved to: ${input.outputFiles.join(', ')}`
        : 'Output will be saved to default location';

    const summary = `Started workflow agent '${input.agent}' on ${input.inputFile}`;
    const output = [
      `Workflow agent '${input.agent}' has been started.`,
      '',
      `Input: ${input.inputFile}`,
      input.inputFiles.length > 0
        ? `Additional inputs: ${input.inputFiles.join(', ')}`
        : null,
      input.referenceFile ? `Reference: ${input.referenceFile}` : null,
      `Model: ${input.model}`,
      `Instruction: ${input.instruction}`,
      '',
      outputInfo,
      '',
      'Monitor the ProgressBoard to track execution status.',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      summary,
      output,
    };
  }

  /**
   * Get list of available workflow agents for discovery.
   */
  static getAvailableAgents(): string[] {
    return getWorkflowAgents().map((a) => a.name);
  }
}
