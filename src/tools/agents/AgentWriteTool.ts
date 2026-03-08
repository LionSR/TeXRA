import * as path from 'path';

import { z } from 'zod';

import { AbsoluteFS } from '@utils/files';

import { defineTool } from '../core/define';
import { ToolError, type ToolResult } from '../result';
import { resolveVirtualPath } from '../virtualPaths';

const AgentWriteInputSchema = z.strictObject({
  path: z
    .string()
    .describe(
      'Virtual path under /agents/custom/, e.g. /agents/custom/my_agent.yaml',
    ),
  content: z.string().describe('YAML content to write.'),
});

export class AgentWriteTool extends defineTool({
  name: 'agent_write',
  description:
    'Write an agent YAML file to the custom agents directory (/agents/custom/). Built-in directories are read-only.',
  schema: AgentWriteInputSchema,
}) {
  protected async execute(
    input: z.infer<typeof AgentWriteInputSchema>,
  ): Promise<ToolResult> {
    const virtual = resolveVirtualPath(input.path);
    if (!virtual) {
      throw new ToolError(
        `Invalid agent path "${input.path}". Paths must start with /agents/.`,
      );
    }

    if (!virtual.writable) {
      throw new ToolError(
        `Cannot write to ${input.path} — this directory is read-only. Write to /agents/custom/ instead.`,
      );
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(virtual.absolutePath);
    await AbsoluteFS.ensureDir(parentDir);

    await AbsoluteFS.write(virtual.absolutePath, input.content);
    const lineCount = input.content.split('\n').length;

    return {
      summary: `Wrote ${input.path} (${lineCount} lines)`,
      output: `Agent file written to ${input.path}. It will appear in the agent dropdown.`,
    };
  }
}
