// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError, ToolResult } from '@tools/result';
import { getGitignoreMatcher } from '@tools/gitignore';
import { resolveAndFormat } from '@tools/utils';
import { executeCommand } from '@utils/system/execUtils';

// Local file imports
import { defineTool } from './core/define';

const OUTPUT_MODES = ['content', 'files_with_matches', 'count'] as const;

type OutputMode = (typeof OUTPUT_MODES)[number];

const GrepInputSchema = z.strictObject({
  pattern: z.string().min(1, 'pattern is required'),
  path: z.string().nullish(),
  glob: z.string().nullish(),
  output_mode: z.enum(OUTPUT_MODES).nullish(),
  '-B': z.int().min(0).nullish(),
  '-A': z.int().min(0).nullish(),
  '-C': z.int().min(0).nullish(),
  '-n': z.boolean().nullish(),
  '-i': z.boolean().nullish(),
  type: z.string().nullish(),
  head_limit: z.int().min(1).nullish(),
  multiline: z.boolean().nullish(),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;

const CHANNEL = 'GrepTool';

export function buildArguments(
  input: GrepInput,
  outputMode: OutputMode,
): string[] {
  const args: string[] = ['--color=never'];

  // Output mode flags
  if (outputMode === 'files_with_matches') {
    args.push('--files-with-matches');
  } else if (outputMode === 'count') {
    args.push('--count');
  }

  // Filter options
  if (input.glob) args.push('--glob', input.glob);
  if (input.type) args.push('--type', input.type);
  if (input['-i']) args.push('-i');
  if (input.multiline) args.push('--multiline', '--multiline-dotall');

  // Context flags (only for content mode)
  if (outputMode === 'content') {
    if (input['-n']) args.push('-n');
    if (input['-A'] !== undefined) args.push('-A', String(input['-A']));
    if (input['-B'] !== undefined) args.push('-B', String(input['-B']));
    if (input['-C'] !== undefined) args.push('-C', String(input['-C']));
  }

  return args;
}

function applyHeadLimit(output: string | null, headLimit?: number): string {
  if (!output) return '';
  if (!headLimit || headLimit <= 0) return output;
  return output.split(/\r?\n/).slice(0, headLimit).join('\n');
}

export class GrepTool extends defineTool({
  name: 'grep',
  description:
    'Search file contents using regex patterns. Supports context (-A/-B/-C), glob/type filters, and multiline matching.',
  schema: GrepInputSchema,
}) {
  protected async execute(input: GrepInput): Promise<ToolResult> {
    const outputMode: OutputMode = input.output_mode ?? 'content';
    const { resolved: searchPath, display } = resolveAndFormat(
      input.path ?? undefined,
    );
    const gitignore = await getGitignoreMatcher();
    const args = buildArguments(input, outputMode);
    const ignoreArgs = gitignore.ignoreFiles.flatMap((ignoreFile) => [
      '--ignore-file',
      ignoreFile,
    ]);

    const targetPath = searchPath.relative === '.' ? '.' : searchPath.relative;
    const command = ['rg', ...args, ...ignoreArgs, input.pattern, targetPath];

    const result = await executeCommand(command, {
      channel: CHANNEL,
      truncate: false,
    });

    if (!result.success) {
      throw new ToolError(
        `ripgrep error: ${result.stderr || 'No error output available'}`,
      );
    }

    const limitedOutput = applyHeadLimit(
      result.stdout,
      input.head_limit ?? undefined,
    );
    const outputText =
      limitedOutput || `No matches found for pattern in ${display}`;
    const summary = limitedOutput
      ? `Matches for "${input.pattern}" in ${display}`
      : `No matches for "${input.pattern}" in ${display}`;

    return {
      summary,
      output: outputText,
    };
  }
}
