import { z } from 'zod';

import { AbsoluteFS } from '@utils/files';
import { splitContentLines } from '@utils/text/stringUtils';

import { defineTool } from '../core/define';
import { ToolError, type ToolResult } from '../result';
import { formatLinesWithNumbers } from '../utils';
import { resolveVirtualPath } from '../virtualPaths';

const AgentReadInputSchema = z.strictObject({
  path: z
    .string()
    .describe(
      'Virtual path to the file to read, e.g. /agents/builtin/polish.yaml or /agents/docs/tool_catalog.md',
    ),
});

export class AgentReadTool extends defineTool({
  name: 'agent_read',
  description:
    'Read a file from an agent directory. Supports YAML agents in /agents/builtin, /agents/tooluse, /agents/custom, and reference docs in /agents/docs.',
  schema: AgentReadInputSchema,
}) {
  protected async execute(
    input: z.infer<typeof AgentReadInputSchema>,
  ): Promise<ToolResult> {
    const virtual = resolveVirtualPath(input.path);
    if (!virtual) {
      throw new ToolError(
        `Invalid agent path "${input.path}". Paths must start with /agents/.`,
      );
    }

    const exists = await AbsoluteFS.exists(virtual.absolutePath);
    if (!exists) {
      throw new ToolError(`File not found: ${input.path}`);
    }

    const content = await AbsoluteFS.read(virtual.absolutePath);
    const lines = splitContentLines(content);
    const numbered = formatLinesWithNumbers(lines);

    return {
      summary: `Read ${input.path} (${lines.length} lines)`,
      output: numbered.join('\n'),
    };
  }
}
