// Third-party imports
import { z } from 'zod';

// Local imports - core
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, ToolError } from './result';
import { resolvePathWithinWorkspace } from './utils';
import { executeCommand } from '@utils/system/execUtils';

const GrepInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .default('files_with_matches'),
  '-B': z.number().int().min(0).optional(),
  '-A': z.number().int().min(0).optional(),
  '-C': z.number().int().min(0).optional(),
  '-n': z.boolean().optional(),
  '-i': z.boolean().optional(),
  type: z.string().optional(),
  head_limit: z.number().int().min(1).optional(),
  multiline: z.boolean().optional(),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;

export class GrepTool extends defineTool({
  name: 'grep',
  description:
    'Search within the workspace using ripgrep with optional filters',
  schema: GrepInputSchema,
}) {
  protected async execute(input: GrepInput): Promise<ToolResult> {
    const resolved = resolvePathWithinWorkspace(input.path);
    const searchTargets: string[] = [];

    if (resolved.relativePath) {
      // Avoid duplicating the implicit current directory search when no path is provided
      if (resolved.relativePath !== '.') {
        searchTargets.push(resolved.relativePath);
      } else if (input.path) {
        searchTargets.push('.');
      }
    }

    const command: string[] = ['rg', '--color=never'];

    const mode = input.output_mode ?? 'files_with_matches';
    if (mode === 'files_with_matches') {
      command.push('--files-with-matches');
    } else if (mode === 'count') {
      command.push('--count');
    } else {
      if (input['-n']) {
        command.push('-n');
      }
      if (input['-A'] !== undefined) {
        command.push('-A', input['-A'].toString());
      }
      if (input['-B'] !== undefined) {
        command.push('-B', input['-B'].toString());
      }
      if (input['-C'] !== undefined) {
        command.push('-C', input['-C'].toString());
      }
    }

    if (input['-i']) {
      command.push('-i');
    }

    if (input.multiline) {
      command.push('--multiline', '--multiline-dotall');
    }

    if (input.glob) {
      command.push('--glob', input.glob);
    }

    if (input.type) {
      command.push('--type', input.type);
    }

    command.push('-e', input.pattern);

    if (searchTargets.length > 0) {
      command.push(...searchTargets);
    }

    const result = await executeCommand(command, { channel: 'GrepTool' });

    if (result.timedOut) {
      throw new ToolError('Grep command timed out');
    }

    if (!result.success && result.stderr) {
      throw new ToolError(`Grep command failed: ${result.stderr}`);
    }

    let output = result.stdout ?? '';
    if (input.head_limit && input.head_limit > 0 && output) {
      const lines = output.split(/\r?\n/).slice(0, input.head_limit);
      output = lines.join('\n');
    }

    return new ToolResult({ output });
  }
}
