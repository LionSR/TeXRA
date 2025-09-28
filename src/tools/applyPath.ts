// Third-party imports
import { execa } from 'execa';

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolError, toolResult, type ToolResult } from '@tools/result';
import { WorkspaceFS } from '@utils/files';

const ApplyPathInputSchema = z.object({
  patch: z.string().min(1, 'patch content is required'),
});

export type ApplyPathInput = z.infer<typeof ApplyPathInputSchema>;

const COMMAND = 'git';
const ARGS = ['apply'];

export class ApplyPathTool extends defineTool({
  name: 'apply_path',
  description: 'Apply a unified diff patch using git apply.',
  schema: ApplyPathInputSchema,
}) {
  protected async execute(input: ApplyPathInput): Promise<ToolResult> {
    const workspacePath = WorkspaceFS.getPath();
    if (!workspacePath) {
      throw new ToolError('apply_path error: workspace path is not available');
    }

    try {
      const result = await execa(COMMAND, ARGS, {
        cwd: workspacePath,
        input: input.patch,
        encoding: 'utf8',
        reject: false,
      });

      if (result.exitCode === 0) {
        return toolResult({
          summary: 'Applied patch',
          output: result.stdout ?? '',
        });
      }

      throw new ToolError(
        `apply_path error: ${result.stderr || 'Unknown failure applying patch'}`,
      );
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }

      const message =
        error instanceof Error ? error.message : 'Unknown error applying patch';
      throw new ToolError(`apply_path error: ${message}`);
    }
  }
}
