// Node imports
import * as nodePath from 'node:path';

// Third-party imports
import { Effect, FileSystem, Schema } from 'effect';
import { ToolContext } from '@tools/core/ToolTypes';

// Local imports - tools
import {
  ToolError,
  type ToolResult,
  NonNegativeIntSchema,
} from '@shared/schemas';
import { resolveToolPath, type ToolPathCall } from '@tools/pathResolution';
import { getGitignoreMatcher } from '@tools/gitignore';
import { executed } from '@tools/core/result';
import { executeCommand } from '@utils/system/execUtils';
import { withLogChannel } from '@logger/effectLog';

// Local file imports
import { defineTool } from './core/definition';
import { nullishWithDefault, optionalInput } from './core/inputSchema';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const OUTPUT_MODES = ['content', 'files_with_matches', 'count'] as const;

type OutputMode = (typeof OUTPUT_MODES)[number];

const GrepInputSchema = Schema.Struct({
  pattern: Schema.NonEmptyString.annotate({
    description: 'Regex pattern.',
  }),
  path: optionalInput(Schema.String, 'File or directory to search in.'),
  glob: optionalInput(
    Schema.String,
    'Glob filter for file names (e.g. "*.tex").',
  ),
  output_mode: nullishWithDefault(
    Schema.Literals(OUTPUT_MODES),
    'content',
    'Must be "content", "files_with_matches", or "count". For context lines around matches, use -C instead.',
  ),
  '-B': optionalInput(
    NonNegativeIntSchema,
    'Lines of context BEFORE each match (only with output_mode "content").',
  ),
  '-A': optionalInput(
    NonNegativeIntSchema,
    'Lines of context AFTER each match (only with output_mode "content").',
  ),
  '-C': optionalInput(
    NonNegativeIntSchema,
    'Lines of context before AND after each match.',
  ),
  '-n': optionalInput(Schema.Boolean, 'Show line numbers.'),
  '-i': optionalInput(Schema.Boolean, 'Case-insensitive search.'),
  type: optionalInput(
    Schema.String,
    'Ripgrep file type filter (e.g. "tex", "py").',
  ),
  offset: nullishWithDefault(NonNegativeIntSchema, 0, 'Skip first N results.'),
  head_limit: optionalInput(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    'Limit to first N results.',
  ),
  multiline: optionalInput(
    Schema.Boolean,
    'Enable multiline matching (pattern can span lines).',
  ),
  literal: optionalInput(Schema.Boolean, 'Exact string, not regex.'),
});

type GrepInput = typeof GrepInputSchema.Type;

const CHANNEL = 'GrepTool';
// Pagination and total counts require draining all of ripgrep's output. Keep
// the per-stream ceiling explicit instead of coupling this failure boundary
// to executeCommand's default or killing rg after one page.
const GREP_MAX_BUFFER_CHARS = 100_000_000;

function buildArguments(input: GrepInput): string[] {
  const outputMode: OutputMode = input.output_mode;
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

const runGrep = Effect.fn('GrepTool.execute')(function* (
  call: ToolPathCall,
  input: GrepInput,
): Effect.fn.Return<
  ToolResult,
  Error,
  FileSystem.FileSystem | ChildProcessSpawner
> {
  const path = yield* resolveToolPath(call, input.path ?? undefined);
  const { display } = path;
  const gitignore = yield* getGitignoreMatcher(call.roots.workspace);
  const args = buildArguments(input);
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

  // `executeCommand` reports how the command ended in its result (`end`: an
  // exit, a timeout, the output limit, or no exit) and never fails, so the
  // spawn has no error channel of its own. The region is interruptible, and
  // interrupting the tool tears the `rg` process down instead of abandoning
  // it — parallel batches must be able to stop large-repo searches.
  const result = yield* executeCommand(command, {
    // No `working_directory` on the call means the search runs from the
    // session's own workspace root, which the call carries as data.
    cwd: call.workingDirectory ?? call.roots.workspace,
    maxBuffer: GREP_MAX_BUFFER_CHARS,
  });

  if (result.end._tag === 'LimitExceeded') {
    return yield* new ToolError(
      `Search output exceeded the ${GREP_MAX_BUFFER_CHARS.toLocaleString()}-character retained-output ceiling.\n` +
        `Narrow the search path or pattern, or use glob/type filters. ` +
        `Pagination with offset/head_limit does not avoid draining the total ripgrep output.`,
    );
  }

  if (result.end._tag === 'NoExit' && result.end.why === 'spawn') {
    return yield* new ToolError(
      `ripgrep could not start: ${result.stderr}.\n` +
        `Check that rg is installed and the search path exists.`,
    );
  }
  if (result.end._tag !== 'Exited') {
    return yield* new ToolError(`ripgrep did not finish: ${result.stderr}`);
  }
  // ripgrep exit codes: 0 = matches found, 1 = no matches, 2 = error.
  const exitCode = result.end.code;
  if (exitCode >= 2) {
    return yield* new ToolError(
      `Regex error: ${result.stderr || `exit code ${exitCode}`}.\n` +
        `To fix, either:\n` +
        `- Escape special regex characters in the pattern (e.g. \\., \\(, \\{)\n` +
        `- Set literal: true for exact string matching: { "literal": true }`,
    );
  }

  // Filter empty lines consistently for counting and pagination
  const allLines = result.stdout.split(/\r?\n/).filter(Boolean);
  const totalCount = allLines.length;

  if (totalCount === 0) {
    return executed(
      `No matches found for "${input.pattern}" in ${display}. ` +
        `Try a broader pattern, { "-i": true } for case-insensitive, or search a wider directory.`,
      `No matches for "${input.pattern}" in ${display}`,
    );
  }

  // Apply pagination to filtered lines for consistent offset calculation
  const offset = input.offset;
  const limit = input.head_limit;
  const end = limit ? offset + limit : undefined;
  const paginatedLines = allLines.slice(offset, end);
  const returnedCount = paginatedLines.length;

  const summary = `Found ${returnedCount} of ${totalCount} matches for "${input.pattern}" in ${display}`;
  const hasMore = offset + returnedCount < totalCount;
  const output = hasMore
    ? `${paginatedLines.join('\n')}\n\n[Showing ${returnedCount} of ${totalCount} results. Use offset=${offset + returnedCount} to see more.]`
    : paginatedLines.join('\n');

  return executed(output, summary);
});

export const GrepTool = defineTool({
  name: 'grep',
  replay: 'safe',
  lane: 'parallel',
  description:
    'Search file contents using regex patterns. For surrounding lines use -C with output_mode "content".',
  schema: GrepInputSchema,
  execute: Effect.fn('GrepTool.call')(function* (input: GrepInput) {
    return yield* runGrep((yield* ToolContext).env, input);
  }, withLogChannel(CHANNEL)),
});
