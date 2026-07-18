// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { executeCommand } from '@utils/system/execUtils';

// Local file imports
import { defineTool } from './core/define';

const ApplyPathInputSchema = z.strictObject({
  patch: z
    .string()
    .min(1, 'patch content is required')
    .describe('Unified diff patch content to apply with git apply.'),
});

export type ApplyPathInput = z.infer<typeof ApplyPathInputSchema>;

export class ApplyPathTool extends defineTool({
  name: 'apply_path',
  requiresApproval: true,
  description: 'Apply a unified diff patch using git apply.',
  schema: ApplyPathInputSchema,
}) {
  protected async execute(input: ApplyPathInput): Promise<ToolResult> {
    const result = await executeCommand(['git', 'apply'], {
      stdin: input.patch,
      channel: 'ApplyPathTool',
    });

    if (result.success) {
      return {
        status: 'executed',
        summary: 'Applied patch',
        output: result.stdout ?? '',
      };
    }

    throw new ToolError(
      `apply_path error: ${result.stderr ?? 'Unknown failure applying patch'}`,
    );
  }
}
