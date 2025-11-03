// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import {
  buildApprovalRejectedResult,
  formatUnifiedApprovalUserDiff,
  getApprovedContent,
  requestToolEditApproval,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
import { ToolResult, toolResult } from '@tools/result';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

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
    const originalContent = (await WorkspaceFS.exists(input.path))
      ? await WorkspaceFS.read(input.path)
      : '';

    const approval = await requestToolEditApproval({
      path: input.path,
      originalContent,
      proposedContent: input.content,
      sourceTool: 'write_file',
    });

    if (!approval.accepted) {
      return buildApprovalRejectedResult(
        input.path,
        'write_file',
        approval.userMessage,
      );
    }

    const finalContent = getApprovedContent(approval, input.content);
    const { appliedContent } = await writeApprovedContent(
      input.path,
      originalContent,
      finalContent,
    );

    const userDiffNote = formatUnifiedApprovalUserDiff(
      input.path,
      finalContent,
      appliedContent,
    );
    const output = userDiffNote ? `written\n\n${userDiffNote}` : 'written';

    return toolResult({
      summary: `Wrote ${input.path}`,
      output,
    });
  }
}
