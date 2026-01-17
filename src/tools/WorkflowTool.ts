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
 */
const WorkflowAgentInputSchema = WorkflowAgentProposalSchema.extend({
  model: z.string().prefault('gemini3p'),
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

/** Tool for invoking workflow or tool-use agents to process files. */
export class WorkflowAgentTool extends defineTool({
  name: 'workflow_agent',
  description: `Execute a workflow or tool-use agent to process files.

This tool invokes specialized agents to process documents. The agent runs in the background and saves results to the output files.

Available agents:
${buildAgentListDescription()}

Parameters:
- agent: Name of the agent to execute
- model: Model to use (default: gemini3p)
- instruction: What the agent should do
- inputFile: Primary file to process (required)
- inputFiles: Additional input files (optional)
- referenceFile: Reference file for context (optional)
- referenceFiles: Additional reference files (optional)
- auxiliaryFile: Auxiliary file for supplementary content (optional)
- auxiliaryFiles: Additional auxiliary files (optional)
- mediaFile: Media file for images/figures (optional)
- mediaFiles: Additional media files (optional)
- outputFiles: Output file paths (optional, see below)
- useMultipleOutputs: Generate multiple output files (optional)

Output file naming:
- If outputFiles is empty/omitted: single output mode, path derived from inputFile with agent suffix
- If outputFiles is provided: multiple outputs mode, one output per input file
  - Output file names should correspond to input files (e.g., inputFiles: [a.tex, b.tex] → outputFiles: [a_out.tex, b_out.tex])
- Paths support Nunjucks templating: {{ name }}, {{ ext }}, {{ dir }} from the corresponding input file

The proposal is shown in the ProgressBoard for user review. User can:
- Approve: Execute the agent immediately
- Reject: Cancel with optional feedback
- Setup: Open in main view for editing before execution`,
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

    // Validate all file paths exist
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
