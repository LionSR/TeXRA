import * as path from 'path';

import { z } from 'zod';

import { isDirectory } from '@common/files/fsEntryType';
import { AbsoluteFS } from '@utils/files';
import { splitContentLines } from '@utils/text/stringUtils';

import { defineTool } from '../core/define';
import { ToolError, type ToolResult } from '../result';
import { resolveVirtualPath } from '../virtualPaths';

const AgentSearchInputSchema = z.strictObject({
  pattern: z.string().describe('Text or regex pattern to search for.'),
  path: z
    .string()
    .nullish()
    .describe(
      'Agent directory to search. Defaults to all agent directories. E.g. /agents/builtin',
    ),
});

export class AgentSearchTool extends defineTool({
  name: 'agent_search',
  description:
    'Search agent files for a text pattern. Searches YAML files in /agents/builtin, /agents/tooluse, /agents/custom, and docs in /agents/docs.',
  schema: AgentSearchInputSchema,
}) {
  protected async execute(
    input: z.infer<typeof AgentSearchInputSchema>,
  ): Promise<ToolResult> {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, 'i');
    } catch {
      throw new ToolError(`Invalid regex pattern: ${input.pattern}`);
    }

    // Determine which directories to search
    const searchPaths = input.path
      ? [input.path]
      : [
          '/agents/builtin',
          '/agents/tooluse',
          '/agents/custom',
          '/agents/docs',
        ];

    const results: string[] = [];

    for (const searchPath of searchPaths) {
      const virtual = resolveVirtualPath(searchPath);
      if (!virtual) continue;

      const exists = await AbsoluteFS.exists(virtual.absolutePath);
      if (!exists) continue;

      const isDir = await AbsoluteFS.isDir(virtual.absolutePath);
      if (!isDir) continue;

      const entries = await AbsoluteFS.readDir(virtual.absolutePath);
      for (const [name, type] of entries) {
        if (isDirectory(type)) continue;

        const filePath = path.join(virtual.absolutePath, name);
        const displayPath = `${searchPath}/${name}`;

        try {
          const content = await AbsoluteFS.read(filePath);
          const lines = splitContentLines(content);

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`${displayPath}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }

    const matchCount = results.length;
    const output =
      matchCount > 0
        ? results.join('\n')
        : `No matches for "${input.pattern}"`;

    return {
      summary: `Searched agents for "${input.pattern}": ${matchCount} matches`,
      output,
    };
  }
}
