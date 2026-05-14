// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError, type ToolResult } from '@tools/result';
import { getGitignoreMatcher } from '@tools/gitignore';
import { resolveAndFormat, currentToolRoot } from '@tools/pathResolution';
import { executeCommand } from '@utils/system/execUtils';

// Local file imports
import { defineTool } from './core/define';

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

      if (value != null) args.push(flag, String(value));
    }
  }

  return args;
}

export class GrepTool extends defineTool({
  name: 'grep',
  description:
    'Search file contents using regex patterns. output_mode must be "content", "files_with_matches", or "count" (NOT "context"). To show surrounding lines, use -C with output_mode "content".',
  schema: GrepInputSchema,
}) {
  protected async execute(input: GrepInput): Promise<ToolResult> {
    const { output_mode: outputMode } = input;
    const root = currentToolRoot();
    const { path, display } = resolveAndFormat(input.path ?? undefined, root);
    const gitignore = await getGitignoreMatcher();
    const args = buildArguments(input, outputMode);
    const ignoreArgs = gitignore.ignoreFiles.flatMap((ignoreFile) => [
      '--ignore-file',
      ignoreFile,
    ]);

    const command = ['rg', ...args, ...ignoreArgs, input.pattern, path.fsPath];

    const result = await executeCommand(command, {
      cwd: root,
      channel: CHANNEL,
      truncate: false,
    });

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
