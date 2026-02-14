// Third-party imports
import { z } from 'zod';

// Local imports - tools
import type { ExecResult } from '@agent/types/ResultTypes';
import { ToolError, ToolResult } from '@tools/result';
import { getGitignoreMatcher } from '@tools/gitignore';
import { resolveAndFormat } from '@tools/utils';
import { StorageFS } from '@utils/files';
import { executeCommand } from '@utils/system/execUtils';

// Local file imports
import { defineTool } from './core/define';
import {
  tryResolveVirtualPath,
  translateOutputLine,
  type VirtualPathResolution,
} from './virtualPath';

const OUTPUT_MODES = ['content', 'files_with_matches', 'count'] as const;

type OutputMode = (typeof OUTPUT_MODES)[number];

const GrepInputSchema = z.strictObject({
  pattern: z.string().min(1, 'pattern is required').describe('Regex pattern.'),
  path: z.string().nullish().describe('File or directory to search in.'),
  glob: z
    .string()
    .nullish()
    .describe('Glob filter for file names (e.g. "*.tex").'),
  output_mode: z
    .enum(OUTPUT_MODES)
    .nullish()
    .transform((v) => v ?? 'content')
    .describe(
      'Must be "content", "files_with_matches", or "count". For context lines around matches, use -C instead.',
    ),
  '-B': z
    .int()
    .min(0)
    .nullish()
    .describe(
      'Lines of context BEFORE each match (only with output_mode "content").',
    ),
  '-A': z
    .int()
    .min(0)
    .nullish()
    .describe(
      'Lines of context AFTER each match (only with output_mode "content").',
    ),
  '-C': z
    .int()
    .min(0)
    .nullish()
    .describe('Lines of context before AND after each match.'),
  '-n': z.boolean().nullish().describe('Show line numbers.'),
  '-i': z.boolean().nullish().describe('Case-insensitive search.'),
  type: z
    .string()
    .nullish()
    .describe('Ripgrep file type filter (e.g. "tex", "py").'),
  offset: z.int().min(0).nullish().describe('Skip first N results.'),
  head_limit: z.int().min(1).nullish().describe('Limit to first N results.'),
  multiline: z
    .boolean()
    .nullish()
    .describe('Enable multiline matching (pattern can span lines).'),
  literal: z.boolean().nullish().describe('Exact string, not regex.'),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;

const CHANNEL = 'GrepTool';

export function buildArguments(
  input: GrepInput,
  outputMode: OutputMode,
): string[] {
  const args: string[] = ['--color=never'];

  // Output mode flags
  switch (outputMode) {
    case 'files_with_matches':
      args.push('--files-with-matches');
      break;
    case 'count':
      args.push('--count');
      break;
  }

  // Filter options
  if (input.glob) args.push('--glob', input.glob);
  if (input.type) args.push('--type', input.type);
  if (input['-i']) args.push('-i');
  if (input.literal) args.push('--fixed-strings');
  if (input.multiline) args.push('--multiline', '--multiline-dotall');

  // Context flags (only for content mode)
  if (outputMode === 'content') {
    if (input['-n']) args.push('-n');
    for (const flag of ['-A', '-B', '-C'] as const) {
      const value = input[flag];
      // eslint-disable-next-line eqeqeq -- nullish check for .nullish() schema fields
      if (value != null) args.push(flag, String(value));
    }
  }

  return args;
}

export class GrepTool extends defineTool({
  name: 'grep',
  description:
    'Search file contents using regex patterns. output_mode must be "content", "files_with_matches", or "count" (NOT "context"). To show surrounding lines, use -C with output_mode "content". ' +
    'Also supports virtual storage paths: use "/memories" to search memory files, "/executions" to search execution history (conversations, configs, reports).',
  schema: GrepInputSchema,
}) {
  protected async execute(input: GrepInput): Promise<ToolResult> {
    const { output_mode: outputMode } = input;
    const inputPath = input.path ?? undefined;

    // Route virtual storage paths through StorageFS instead of workspace
    const virtual = inputPath ? tryResolveVirtualPath(inputPath) : null;
    if (inputPath && virtual) {
      return this.executeVirtual(input, inputPath, outputMode, virtual);
    }

    return this.executeWorkspace(input, inputPath, outputMode);
  }

  /** Search workspace files (original behavior). */
  private async executeWorkspace(
    input: GrepInput,
    inputPath: string | undefined,
    outputMode: OutputMode,
  ): Promise<ToolResult> {
    const { path: resolvedPath, display } = resolveAndFormat(inputPath);
    const gitignore = await getGitignoreMatcher();
    const args = buildArguments(input, outputMode);
    const ignoreArgs = gitignore.ignoreFiles.flatMap((ignoreFile) => [
      '--ignore-file',
      ignoreFile,
    ]);

    const command = [
      'rg',
      ...args,
      ...ignoreArgs,
      input.pattern,
      resolvedPath.relative,
    ];

    const result = await executeCommand(command, {
      channel: CHANNEL,
      truncate: false,
    });

    return this.formatResult(result, input, display);
  }

  /** Search virtual storage paths (/memories, /executions). */
  private async executeVirtual(
    input: GrepInput,
    virtualPath: string,
    outputMode: OutputMode,
    resolved: VirtualPathResolution,
  ): Promise<ToolResult> {
    const { absolutePath, namespace } = resolved;

    const exists = await StorageFS.exists(namespace.storage);
    if (!exists) {
      return {
        summary: `No data found at ${virtualPath}`,
        output: `The ${namespace.display} directory does not exist yet. No data to search.`,
      };
    }

    const args = buildArguments(input, outputMode);
    const command = ['rg', ...args, input.pattern, absolutePath];

    const result = await executeCommand(command, {
      channel: CHANNEL,
      truncate: false,
    });

    // Translate physical paths to virtual display paths line-by-line
    // (only replaces the leading path prefix, never content after it)
    if (result.stdout) {
      result.stdout = result.stdout
        .split('\n')
        .map((line) => translateOutputLine(line, absolutePath, namespace))
        .join('\n');
    }

    return this.formatResult(result, input, virtualPath);
  }

  /** Shared formatting for rg results (workspace and virtual). */
  private formatResult(
    result: ExecResult,
    input: GrepInput,
    display: string,
  ): ToolResult {
    // ripgrep exit codes: 0 = matches found, 1 = no matches, 2+ = error
    const exitCode = result.exitCode ?? (result.success ? 0 : 1);
    if (exitCode >= 2) {
      throw new ToolError(
        `Regex error: ${result.stderr || `exit code ${exitCode}`}.\n` +
          `To fix, either:\n` +
          `- Escape special regex characters in the pattern (e.g. \\., \\(, \\{)\n` +
          `- Set literal: true for exact string matching: { "literal": true }`,
      );
    }

    // Filter empty lines consistently for counting and pagination
    const allLines = result.stdout?.split(/\r?\n/).filter(Boolean) ?? [];
    const totalCount = allLines.length;

    if (totalCount === 0) {
      return {
        summary: `No matches for "${input.pattern}" in ${display}`,
        output:
          `No matches found for "${input.pattern}" in ${display}. ` +
          `Try a broader pattern, { "-i": true } for case-insensitive, or search a wider directory.`,
      };
    }

    // Apply pagination to filtered lines for consistent offset calculation
    const offset = input.offset ?? 0;
    const limit = input.head_limit;
    const end = limit ? offset + limit : undefined;
    const paginatedLines = allLines.slice(offset, end);
    const returnedCount = paginatedLines.length;

    const summary = `Found ${returnedCount} of ${totalCount} matches for "${input.pattern}" in ${display}`;
    const hasMore = returnedCount < totalCount;

    const toolResult: ToolResult = {
      summary,
      output: paginatedLines.join('\n'),
    };

    if (hasMore) {
      toolResult.instruction = `Showing ${returnedCount} of ${totalCount} results. Use offset=${offset + returnedCount} to see more.`;
    }

    return toolResult;
  }
}
