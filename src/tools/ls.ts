// Standard library imports
import * as path from 'path';

// Third-party imports
import { minimatch } from 'minimatch';
import { z } from 'zod';

// Local imports - core
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, ToolError } from './result';
import {
  fileTypeToString,
  normalizeRelativeForOutput,
  resolvePathWithinWorkspace,
} from './utils';
import { WorkspaceFS } from '@utils/files';

const LsInputSchema = z.object({
  path: z.string(),
  ignore: z.array(z.string()).optional(),
});

export type LsInput = z.infer<typeof LsInputSchema>;

export class LsTool extends defineTool({
  name: 'ls',
  description: 'List files and directories within the workspace',
  schema: LsInputSchema,
}) {
  protected async execute(input: LsInput): Promise<ToolResult> {
    const resolved = resolvePathWithinWorkspace(input.path);
    if (!resolved.relativePath) {
      throw new ToolError('Unable to resolve workspace path');
    }

    const directory =
      resolved.relativePath === '.' ? '.' : resolved.relativePath;
    const isDirectory = await WorkspaceFS.isDir(directory);
    if (!isDirectory) {
      throw new ToolError(
        'The provided path is not a directory inside the workspace',
      );
    }

    const entries = await WorkspaceFS.readDir(directory);
    const ignorePatterns = (input.ignore ?? [])
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern.length > 0);

    const shouldIgnore = (relativePath: string, name: string): boolean => {
      if (ignorePatterns.length === 0) {
        return false;
      }
      return ignorePatterns.some((pattern) => {
        const options = { dot: true, matchBase: true } as const;
        return (
          minimatch(relativePath, pattern, options) ||
          minimatch(name, pattern, options)
        );
      });
    };

    const results = entries
      .map(([name, fileType]) => {
        const relativePath =
          directory === '.' ? name : path.join(directory, name);
        const normalizedRelative = normalizeRelativeForOutput(relativePath);

        return {
          name,
          path: normalizedRelative,
          type: fileTypeToString(fileType),
          ignore: shouldIgnore(normalizedRelative, name),
        };
      })
      .filter((entry) => !entry.ignore)
      .map(({ ignore: _ignore, ...entry }) => entry)
      .sort((a, b) => a.name.localeCompare(b.name));

    const output = {
      path: normalizeRelativeForOutput(directory),
      entries: results,
    };

    return new ToolResult({ output: JSON.stringify(output) });
  }
}
