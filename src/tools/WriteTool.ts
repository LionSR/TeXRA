// Local imports - core
import { z } from 'zod';

// Internal imports
import { isTexFile } from '@common/files/fileTypeUtils';
import replacementEngine from '@replacement/engine';
import { ToolResult } from '@tools/result';
import { executeToolEditApprovalFlow } from '@tools/approval/executeApprovalFlow';
import { WorkspaceFS } from '@utils/files';

// Local file imports
import { defineTool } from './core/define';

const WriteInputSchema = z.strictObject({
  path: z.string(),
  content: z.string(),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;

export class WriteFileTool extends defineTool({
  name: 'write_file',
  description:
    'Overwrite a workspace file with the provided content. Creates the file if it does not exist.',
  schema: WriteInputSchema,
}) {
  protected async execute(input: WriteInput): Promise<ToolResult> {
    const exists = await WorkspaceFS.exists(input.path);
    const originalContent = exists ? await WorkspaceFS.read(input.path) : '';

    // Apply LaTeX transformations before approval
    const proposedContent = isTexFile(input.path)
      ? replacementEngine.applyAll(input.content)
      : input.content;

    return executeToolEditApprovalFlow({
      path: input.path,
      originalContent,
      proposedContent,
      sourceTool: 'write_file',
      summaryMessage: `Wrote ${input.path}`,
      successOutputPrefix: 'written',
      skipFileReadCheck: !exists,
    });
  }
}
