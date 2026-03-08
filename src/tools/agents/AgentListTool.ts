import * as path from 'path';

import { z } from 'zod';

import { isDirectory } from '@common/files/fsEntryType';
import { AbsoluteFS } from '@utils/files';

import { defineTool } from '../core/define';
import { ToolError, type ToolResult } from '../result';
import { resolveVirtualPath } from '../virtualPaths';

const AgentListInputSchema = z.strictObject({
  path: z
    .string()
    .describe(
      'Virtual agent directory path. One of: /agents/builtin, /agents/tooluse, /agents/custom, /agents/docs',
    ),
});

export class AgentListTool extends defineTool({
  name: 'agent_list',
  description:
    'List files in an agent directory. Use /agents/builtin (workflow agents), /agents/tooluse (tool-use agents), /agents/custom (your custom agents), or /agents/docs (reference documentation).',
  schema: AgentListInputSchema,
}) {
  protected async execute(
    input: z.infer<typeof AgentListInputSchema>,
  ): Promise<ToolResult> {
    const virtual = resolveVirtualPath(input.path);
    if (!virtual) {
      throw new ToolError(
        `Invalid agent path "${input.path}". Use /agents/builtin, /agents/tooluse, /agents/custom, or /agents/docs.`,
      );
    }

    const exists = await AbsoluteFS.exists(virtual.absolutePath);
    if (!exists) {
      throw new ToolError(`Directory not found: ${input.path}`);
    }

    const isDir = await AbsoluteFS.isDir(virtual.absolutePath);
    if (!isDir) {
      throw new ToolError(`Not a directory: ${input.path}`);
    }

    const entries = await AbsoluteFS.readDir(virtual.absolutePath);
    const lines: string[] = [];

    for (const [name, type] of entries) {
      const suffix = isDirectory(type) ? '/' : '';
      lines.push(`${name}${suffix}`);
    }

    lines.sort();

    const rw = virtual.writable ? 'read-write' : 'read-only';
    const header = `${input.path} (${rw}, ${lines.length} entries)`;

    return {
      summary: `Listed ${input.path}: ${lines.length} entries`,
      output: lines.length > 0 ? `${header}\n${lines.join('\n')}` : `${header}\n(empty)`,
    };
  }
}
