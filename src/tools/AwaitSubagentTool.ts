/**
 * Tool for awaiting the result of an async subagent (Mode B).
 *
 * When a proposal tool launches a subagent in 'async' mode, the promise is
 * stored in pendingResults. This tool resolves that promise and returns
 * the formatted result to the orchestrator.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { pendingResults, formatFlowResult } from '@tools/subagentResults';
import { defineTool } from '@tools/core/define';

// ============================================================================
// Schema
// ============================================================================

const AwaitSubagentInputSchema = z.strictObject({
  subagent_id: z
    .string()
    .describe(
      'The subagent ID returned by propose_workflow or propose_agent in async mode',
    ),
});

type AwaitSubagentInput = z.infer<typeof AwaitSubagentInputSchema>;

// ============================================================================
// Tool
// ============================================================================

export class AwaitSubagentTool extends defineTool({
  name: 'await_subagent',
  description:
    'Wait for an async subagent to complete and retrieve its result. ' +
    'Use after launching a subagent with mode="async".',
  schema: AwaitSubagentInputSchema,
}) {
  protected async execute(input: AwaitSubagentInput): Promise<ToolResult> {
    const entry = pendingResults.get(input.subagent_id);
    if (!entry) {
      throw new Error(
        `No pending subagent with ID '${input.subagent_id}'. ` +
          'It may have already been awaited, or the ID is incorrect.',
      );
    }

    try {
      const result = await entry.promise;
      return formatFlowResult(result, entry.agentName, entry.inputFile);
    } finally {
      pendingResults.delete(input.subagent_id);
    }
  }
}
