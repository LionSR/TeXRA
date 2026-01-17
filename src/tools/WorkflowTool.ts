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
  getVisibleWorkflowAgents,
  getVisibleToolUseAgents,
} from '@agent/index/agentRegistry';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { executeAgent } from '@agent/runtime/executeAgent';
import { proposalCoordinator } from '@agent/runtime/WorkflowAgentProposalCoordinator';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

// Local imports - event bus (after utils per import order rules)
import {
  WorkflowAgentProposalSchema,
  type WorkflowAgentProposal,
} from '@eventBus/types';

/**
 * Build the dynamic agent list for the tool description.
 * Called at class definition time to include current agents.
 */
function buildAgentListDescription(): string {
  const workflowAgents = getVisibleWorkflowAgents();
  const toolUseAgents = getVisibleToolUseAgents();

  const formatAgent = (a: { name: string; description?: string }): string =>
    `- ${a.name}: ${a.description || 'No description'}`;

  const sections: string[] = [];

  if (workflowAgents.length > 0) {
    sections.push(
      '**Workflow Agents** (document processing):',
      ...workflowAgents.map(formatAgent),
    );
  }

  if (toolUseAgents.length > 0) {
    sections.push(
      '',
      '**Tool-Use Agents** (interactive assistants):',
      ...toolUseAgents.map(formatAgent),
    );
  }

  return sections.join('\n');
}

/**
 * Schema for the workflow_agent tool input.
 *
 * Extends WorkflowAgentProposalSchema with tool-specific modifications:
 * - .prefault() for default values on optional arrays and booleans
 * - .nullish() instead of .nullable() for OpenAI API compatibility
 */
const WorkflowAgentInputSchema = WorkflowAgentProposalSchema.extend({
  // Default model
  model: z.string().prefault('gemini3p'),
  // Arrays need defaults for tool invocation
  inputFiles: z.array(z.string()).prefault([]),
  referenceFiles: z.array(z.string()).prefault([]),
  auxiliaryFiles: z.array(z.string()).prefault([]),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  // Nullable fields need nullish for OpenAI API compatibility
  referenceFile: z.string().nullish(),
  auxiliaryFile: z.string().nullish(),
  mediaFile: z.string().nullish(),
  // Boolean needs default
  useMultipleOutputs: z.boolean().prefault(false),
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
  description: `Execute a workflow or tool-use agent to process files.

This tool invokes specialized agents to process documents. The agent runs in the background and saves results to the output files.

Available agents:
${buildAgentListDescription()}

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

    // Validate all file paths exist
    const filesToValidate = [
      { path: input.inputFile, label: 'Input file' },
      ...input.inputFiles.map((path) => ({ path, label: 'Input file' })),
      ...(input.referenceFile
        ? [{ path: input.referenceFile, label: 'Reference file' }]
        : []),
      ...input.referenceFiles.map((path) => ({
        path,
        label: 'Reference file',
      })),
      ...(input.auxiliaryFile
        ? [{ path: input.auxiliaryFile, label: 'Auxiliary file' }]
        : []),
      ...input.auxiliaryFiles.map((path) => ({
        path,
        label: 'Auxiliary file',
      })),
      ...(input.mediaFile
        ? [{ path: input.mediaFile, label: 'Media file' }]
        : []),
      ...input.mediaFiles.map((path) => ({ path, label: 'Media file' })),
    ];

    for (const { path, label } of filesToValidate) {
      const exists = await WorkspaceFS.exists(path);
      if (!exists) {
        throw new Error(`${label} not found: ${path}`);
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
      const feedbackMessage = result.feedback
        ? `\n\nUser feedback: ${result.feedback}`
        : '';
      return {
        summary: `User rejected workflow agent '${input.agent}' proposal`,
        output: `The proposed workflow agent execution was rejected by the user.${feedbackMessage}`,
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

    // User approved - execute the workflow agent in background
    void executeAgent(proposal);

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
    return getVisibleWorkflowAgents().map((a) => a.name);
  }
}
