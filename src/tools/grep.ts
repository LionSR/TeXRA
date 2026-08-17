// Node imports
import * as nodePath from 'node:path';

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { ToolError, type ToolResult } from '@shared/schemas';
import { getGitignoreMatcher } from '@tools/gitignore';
import { resolveAndFormat, currentToolRoot } from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import { executeCommand } from '@utils/system/execUtils';
import { splitOutputLines } from '@utils/text/stringUtils';

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
// Pagination and total counts require draining all of ripgrep's output. Keep
// execa 10's current per-stream ceiling explicit instead of coupling this
// failure boundary to a dependency default or killing rg after one page.
const GREP_MAX_BUFFER_CHARS = 100_000_000;

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
  parallelSafe: true,
  description:
    'Search file contents using regex patterns. For surrounding lines use -C with output_mode "content".',
  schema: GrepInputSchema,
}) {
  protected async execute(input: GrepInput): Promise<ToolResult> {
    const { output_mode: outputMode } = input;
    const root = currentToolRoot();
    const { path, display } = resolveAndFormat(input.path ?? undefined, root);
    const gitignore = await getGitignoreMatcher();
    const args = buildArguments(input, outputMode);
    const applyWorkspaceIgnores = !nodePath.isAbsolute(path.relative);
    const ignoreArgs = applyWorkspaceIgnores
      ? gitignore.ignoreFiles.flatMap((ignoreFile) => [
          '--ignore-file',
          ignoreFile,
        ])
      : [];

    // `--` ends rg option parsing so the LLM-controlled pattern can't be read as
    // a flag — e.g. `--pre=<cmd>` would run <cmd> as a preprocessor on every
    // searched file (code execution via this non-approval-gated tool). Our own
    // flags in args/ignoreArgs precede it and are unaffected; a leading-dash
    // literal pattern (e.g. "-foo") now searches correctly instead of erroring.
    const command = [
      'rg',
      ...args,
      ...ignoreArgs,
      '--',
      input.pattern,
      path.fsPath,
    ];

    const result = await executeCommand(command, {
      cwd: root,
      channel: CHANNEL,
      truncate: false,
      maxBuffer: GREP_MAX_BUFFER_CHARS,
      // Cancellation for the owning agent run — parallel batches must be
      // able to terminate large-repo rg subprocesses on interrupt.
      signal: getCurrentToolCallContext()?.signal,
    });

    if (result.outputLimitExceeded) {
      throw new ToolError(
        `Search output exceeded the ${GREP_MAX_BUFFER_CHARS.toLocaleString()}-character retained-output ceiling.\n` +
          `Narrow the search path or pattern, or use glob/type filters. ` +
          `Pagination with offset/head_limit does not avoid draining the total ripgrep output.`,
      );
    }

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
    const allLines = splitOutputLines(result.stdout);
    const totalCount = allLines.length;

    if (totalCount === 0) {
      return executed(
        `No matches found for "${input.pattern}" in ${display}. ` +
          `Try a broader pattern, { "-i": true } for case-insensitive, or search a wider directory.`,
        `No matches for "${input.pattern}" in ${display}`,
      );
    }

    // Apply pagination to filtered lines for consistent offset calculation
    const offset = input.offset ?? 0;
    const limit = input.head_limit;
    const end = limit ? offset + limit : undefined;
    const paginatedLines = allLines.slice(offset, end);
    const returnedCount = paginatedLines.length;

    const summary = `Found ${returnedCount} of ${totalCount} matches for "${input.pattern}" in ${display}`;
    const hasMore = returnedCount < totalCount;
    const output = hasMore
      ? `${paginatedLines.join('\n')}\n\n[Showing ${returnedCount} of ${totalCount} results. Use offset=${offset + returnedCount} to see more.]`
      : paginatedLines.join('\n');

    return executed(output, summary);
  }
}
