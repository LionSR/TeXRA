/**
 * Tool for proposing agent executions from tool-use agents.
 * Enables invoking workflow or tool-use agents on files for multi-agent workflows.
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

/** Build the dynamic agent list for the tool description. */
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
 * Tool input schema. Extends WorkflowAgentProposalSchema with:
 * - .prefault() defaults for arrays/booleans
 * - .nullish() for OpenAI API compatibility
 * - inputFile optional (only needed for workflow agents, not tool-use)
 */
const WorkflowAgentInputSchema = WorkflowAgentProposalSchema.extend({
  model: z.string().prefault('gemini3p'),
  // inputFile optional - required for workflow agents, not for tool-use
  inputFile: z.string().prefault(''),
  inputFiles: z.array(z.string()).prefault([]),
  referenceFiles: z.array(z.string()).prefault([]),
  auxiliaryFiles: z.array(z.string()).prefault([]),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  referenceFile: z.string().nullish(),
  auxiliaryFile: z.string().nullish(),
  mediaFile: z.string().nullish(),
  useMultipleOutputs: z.boolean().prefault(false),
});

export type WorkflowAgentInput = z.infer<typeof WorkflowAgentInputSchema>;

function getAvailableAgentNames(): string[] {
  return [
    ...getVisibleWorkflowAgents().map((a) => a.name),
    ...getVisibleToolUseAgents().map((a) => a.name),
  ];
}

/** Tool for invoking workflow or tool-use agents. */
export class WorkflowAgentTool extends defineTool({
  name: 'workflow_agent',
  description: `Propose running another agent. The proposal appears in the ProgressBoard for user approval.

Available agents:
${buildAgentListDescription()}

For workflow agents (document processing): Provide inputFile and instruction. The agent processes the file directly and saves output.

For tool-use agents (interactive): Only provide instruction with file paths mentioned naturally in text. Tool-use agents access files through their own tools (read_file, write_file, etc.), so inputFile/outputFiles are not needed.

Parameters:
- agent: Name of the agent to execute
- model: Model to use (default: gemini3p)
- instruction: What the agent should do (for tool-use agents, mention files here)
- inputFile: Primary file to process (required for workflow agents, optional for tool-use)
- outputFiles: Output paths (optional, workflow agents only)

The user can Approve (run immediately), Reject (with feedback), or Setup (edit in main view first).`,
  schema: WorkflowAgentInputSchema,
}) {
  protected async execute(input: WorkflowAgentInput): Promise<ToolResult> {
    // Validate agent exists and is a workflow or tool-use agent
    const agentEntry = getAgent(input.agent);
    if (!agentEntry) {
      const available = getAvailableAgentNames().join(', ');
      throw new Error(
        `Unknown agent '${input.agent}'. Available agents: ${available}`,
      );
    }

    const isWorkflow = agentEntry.category === AgentCategory.Workflow;
    const isToolUse = agentEntry.category === AgentCategory.ToolUse;
    if (!isWorkflow && !isToolUse) {
      throw new Error(
        `Agent '${input.agent}' cannot be invoked with this tool. ` +
          `Only workflow and tool-use agents are supported.`,
      );
    }

    // For workflow agents, inputFile is required
    if (isWorkflow && !input.inputFile) {
      throw new Error(
        `Workflow agent '${input.agent}' requires inputFile. ` +
          `Specify the file to process.`,
      );
    }

    // Only validate file paths for workflow agents
    // Tool-use agents access files through their own tools (read_file, etc.)
    if (isWorkflow) {
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

      for (const { path, label } of filesToValidate) {
        if (!(await WorkspaceFS.exists(path))) {
          throw new Error(`${label} not found: ${path}`);
        }
      }
    }

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
      agentCategory: isWorkflow ? 'workflow' : 'toolUse',
    };

    const streamId = getCurrentToolFileInteractionContext()?.streamId ?? '';
    const proposalId = randomUUID();

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

    if (result.action === 'setup') {
      return {
        summary: `User opened '${input.agent}' proposal for editing`,
        output:
          'The proposal was opened in the main view for editing. ' +
          'The user may modify the configuration and execute manually.',
      };
    }

    // Approved - execute in background
    void executeAgent(proposal);

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

  static getAvailableAgents(): string[] {
    return getAvailableAgentNames();
  }
}
