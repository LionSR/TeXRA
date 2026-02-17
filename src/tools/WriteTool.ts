// Local imports - core
import { z } from 'zod';

// Internal imports
import { isTexFile } from '@common/files/fileTypeUtils';
import replacementEngine from '@replacement/engine';
import { ToolResult } from '@tools/result';
import {
  recordToolFileRead,
  requireFileReadForEdit,
} from '@tools/fileInteractions';
import {
  buildApprovalRejectedResult,
  formatUnifiedApprovalUserDiff,
  getApprovedContent,
  requestToolEditApproval,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
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
    const readGate = requireFileReadForEdit(input.path, exists);
    if (readGate) {
      return readGate;
    }

    const originalContent = exists ? await WorkspaceFS.read(input.path) : '';

    const proposedContent = isTexFile(input.path)
      ? replacementEngine.applyAll(input.content)
      : input.content;

    const approval = await requestToolEditApproval({
      path: input.path,
      originalContent,
      proposedContent,
      sourceTool: 'write_file',
    });

    if (!approval.accepted) {
      return buildApprovalRejectedResult(
        input.path,
        'write_file',
        approval.userMessage,
      );
    }

    const finalContent = getApprovedContent(approval, proposedContent);
    const { appliedContent } = await writeApprovedContent(
      input.path,
      originalContent,
      finalContent,
    );

    recordToolFileRead(input.path);

    const userDiffNote = formatUnifiedApprovalUserDiff(
      input.path,
      proposedContent,
      appliedContent,
    );
    const output = userDiffNote ? `written\n\n${userDiffNote}` : 'written';

    const originalLineCount = originalContent.split('\n').length;
    const newLineCount = appliedContent.split('\n').length;
    const action = exists ? 'Overwrote' : 'Created';
    const summary = `${action} ${input.path} (${newLineCount} lines)`;
    const userInstruction =
      exists && originalLineCount > 0
        ? `Replaced ${originalLineCount} lines with ${newLineCount} lines.`
        : undefined;

    return {
      summary,
      output,
      userPatch: approval.userPatch,
      edits: [
        {
          path: input.path,
          lineChanges: approval.lineChanges,
          startLine: approval.startLine,
        },
      ],
      ...(userInstruction && { userInstruction }),
    };
  }
}
