/**
 * Workflow tool for proposing workflow agent executions from tool-use agents.
 *
 * This tool allows tool-use agents to invoke workflow agents (like 'correct',
 * 'polish', 'draw') on files, enabling sophisticated multi-agent workflows.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - agent
import {
  getAgent,
  getWorkflowAgents,
  getVisibleWorkflowAgents,
} from '@agent/index/agentRegistry';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { executeAgent } from '@agent/runtime/executeAgent';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

/**
 * Schema for the workflow_agent tool input.
 *
 * Uses Zod v4 patterns:
 * - z.strictObject() to disallow extra keys
 * - .prefault([]) for optional arrays with defaults
 * - .nullish() for optional nullable strings
 */
const WorkflowAgentInputSchema = z.strictObject({
  /** Name of the workflow agent to execute (e.g., 'correct', 'polish', 'draw') */
  agent: z.string().describe('Name of the workflow agent to execute'),

  /** Model to use for the agent execution */
  model: z
    .string()
    .prefault('gemini3p')
    .describe('Model to use for agent execution'),

  /** User instruction describing what the agent should do */
  instruction: z.string().describe('Instruction for the workflow agent'),

  /** Primary input file path (relative to workspace) */
  inputFile: z.string().describe('Path to the primary input file'),

  /** Additional input files */
  inputFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional input file paths'),

  /** Reference file for context (optional) */
  referenceFile: z
    .string()
    .nullish()
    .describe('Reference file path for additional context'),

  /** Additional reference files */
  referenceFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional reference file paths'),

  /** Output file paths (optional - defaults to agent behavior) */
  outputFiles: z
    .array(z.string())
    .prefault([])
    .describe('Desired output file paths'),

  /** Whether to use multiple outputs mode */
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
- outputFiles: Where to save results (optional)
- useMultipleOutputs: Generate multiple output files (optional)

The tool returns immediately after launching the agent. Monitor the ProgressBoard for execution status.`,
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

    // Build agent configuration
    const agentConfig = {
      agent: input.agent,
      model: input.model,
      instruction: input.instruction,
      inputFile: input.inputFile,
      inputFiles: input.inputFiles,
      referenceFile: input.referenceFile ?? null,
      referenceFiles: input.referenceFiles,
      outputFiles: input.outputFiles,
      useMultipleOutputs: input.useMultipleOutputs,
    };

    // Execute the workflow agent (runs in background)
    // Note: executeAgent doesn't block - it starts the agent and returns
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
