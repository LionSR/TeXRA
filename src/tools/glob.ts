// Standard library imports
import * as path from 'path';

// Third-party imports
import { glob } from 'glob';
import { z } from 'zod';

// Local imports - tools
import { toErrorMessage } from '@common/errors';
import { ToolError, ToolResult } from '@tools/result';
import {
  joinWorkspaceRelativePath,
  resolveAndFormat,
  formatToolOutput,
  pluralize,
} from '@tools/utils';
import { getGitignoreMatcher } from '@tools/gitignore';
import { StorageFS, WorkspaceFS } from '@utils/files';
import { toPosixPath } from '@utils/core/pathCore';

// Local file imports
import { defineTool } from './core/define';
import {
  tryResolveVirtualPath,
  type VirtualPathResolution,
} from './virtualPath';

const GlobInputSchema = z.strictObject({
  pattern: z.string().min(1, 'pattern is required'),
  path: z.string().nullish(),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

interface GlobMatchInfo {
  relativePath: string;
  mtime: number;
}

export class GlobTool extends defineTool({
  name: 'glob',
  description:
    'Find files matching glob patterns (e.g., "**/*.tex", "src/**/*.ts"). Returns paths sorted by modification time. ' +
    'Also supports virtual storage paths: use "/memories" to search memory files, "/executions" to search execution data.',
  schema: GlobInputSchema,
}) {
  protected async execute(input: GlobInput): Promise<ToolResult> {
    const inputPath = input.path ?? undefined;

    const virtual = inputPath ? tryResolveVirtualPath(inputPath) : null;
    if (inputPath && virtual) {
      return this.executeVirtual(input, inputPath, virtual);
    }

    return this.executeWorkspace(input, inputPath);
  }

  /** Glob workspace files (original behavior). */
  private async executeWorkspace(
    input: GlobInput,
    inputPath: string | undefined,
  ): Promise<ToolResult> {
    const { path: resolvedPath, display } = resolveAndFormat(inputPath);
    const gitignore = await getGitignoreMatcher();

    let matches: string[];
    try {
      matches = await glob(input.pattern, {
        cwd: resolvedPath.absolute,
        dot: true,
        nodir: false,
        absolute: false,
        follow: false,
      });
    } catch (err) {
      throw new ToolError(
        `Glob pattern error: ${toErrorMessage(err)}. ` +
          `Check syntax: use ** for recursive, * for single level. Example: "**/*.tex"`,
      );
    }

    const statPromises = matches.map(
      async (match): Promise<GlobMatchInfo | null> => {
        let resolved;
        try {
          resolved = joinWorkspaceRelativePath(resolvedPath.relative, match);
        } catch (err) {
          throw new ToolError(
            `Match resolved outside the workspace: ${match} (${toErrorMessage(err)})`,
          );
        }

        const relativePath =
          resolved.relative === '.' ? '.' : resolved.relative;
        if (relativePath === '.' || gitignore.ignores(relativePath)) {
          return null;
        }

        const stat = await WorkspaceFS.stat(relativePath).catch(() => null);
        return { relativePath, mtime: stat?.mtime ?? 0 };
      },
    );

    const results = await Promise.all(statPromises);
    const decorated = results.filter(
      (item): item is GlobMatchInfo => item !== null,
    );

    return this.formatMatches(input, display, decorated);
  }

  /** Glob virtual storage paths (/memories, /executions). */
  private async executeVirtual(
    input: GlobInput,
    virtualPath: string,
    resolved: VirtualPathResolution,
  ): Promise<ToolResult> {
    const { absolutePath, namespace } = resolved;

    const exists = await StorageFS.exists(namespace.storage);
    if (!exists) {
      return {
        summary: `No data found at ${virtualPath}`,
        output: `The ${namespace.display} directory does not exist yet.`,
      };
    }

    let matches: string[];
    try {
      matches = await glob(input.pattern, {
        cwd: absolutePath,
        dot: true,
        nodir: false,
        absolute: false,
        follow: false,
      });
    } catch (err) {
      throw new ToolError(
        `Glob pattern error: ${toErrorMessage(err)}. ` +
          `Check syntax: use ** for recursive, * for single level. Example: "**/*.json"`,
      );
    }

    const statPromises = matches.map(async (match): Promise<GlobMatchInfo> => {
      const storagePath = path.join(namespace.storage, match);
      const stat = await StorageFS.stat(storagePath).catch(() => null);
      const displayPath = `${namespace.display}/${toPosixPath(match)}`;
      return { relativePath: displayPath, mtime: stat?.mtime ?? 0 };
    });

    const decorated = await Promise.all(statPromises);
    return this.formatMatches(input, virtualPath, decorated);
  }

  /** Shared formatting for glob matches. */
  private formatMatches(
    input: GlobInput,
    display: string,
    decorated: GlobMatchInfo[],
  ): ToolResult {
    const sorted = decorated.toSorted((a, b) => {
      if (b.mtime !== a.mtime) {
        return b.mtime - a.mtime;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });

    const lines = sorted.map((item) => toPosixPath(item.relativePath));
    const count = lines.length;
    const header = `Found ${count} ${pluralize(count, 'file')} matching "${input.pattern}" under ${display}`;
    return {
      summary: `Found ${count} ${pluralize(count, 'file')} for "${input.pattern}" in ${display}`,
      output: formatToolOutput(header, lines, '(no matches)'),
    };
  }
}
