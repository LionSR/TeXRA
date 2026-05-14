// Local imports - core
import { z } from 'zod';

// Internal imports
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { isTexFile } from '@common/files/fileTypeUtils';
import replacementEngine from '@replacement/engine';
import { ToolResult } from '@tools/result';
import {
  recordToolFileRead,
  requireFileReadForEdit,
} from '@tools/fileInteractions';
import {
  assertWritable,
  resolveAndFormat,
  parseWorkingDirectory,
} from '@tools/pathResolution';
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
    const root = parseWorkingDirectory(tryUseRunContext()?.workingDirectory);
    const { path: resolved, display: displayPath } = resolveAndFormat(
      input.path,
      root,
    );
    assertWritable(resolved, displayPath);
    const filePath = resolved.fsPath;

    const exists = await WorkspaceFS.exists(filePath);
    const readGate = requireFileReadForEdit(filePath, exists);
    if (readGate) {
      return readGate;
    }

    const originalContent = exists ? await WorkspaceFS.read(filePath) : '';

    const proposedContent = isTexFile(filePath)
      ? replacementEngine.applyAll(input.content)
      : input.content;

    const approval = await requestToolEditApproval({
      path: filePath,
      originalContent,
      proposedContent,
      sourceTool: 'write_file',
    });

    if (!approval.accepted) {
      return buildApprovalRejectedResult(
        displayPath,
        'write_file',
        approval.userMessage,
      );
    }

    const finalContent = getApprovedContent(approval, proposedContent);
    const { appliedContent } = await writeApprovedContent(
      filePath,
      originalContent,
      finalContent,
    );

    recordToolFileRead(filePath);

    const userDiffNote = formatUnifiedApprovalUserDiff(
      displayPath,
      proposedContent,
      appliedContent,
    );
    const output = userDiffNote ? `written\n\n${userDiffNote}` : 'written';

    const originalLineCount = originalContent.split('\n').length;
    const newLineCount = appliedContent.split('\n').length;
    const action = exists ? 'Overwrote' : 'Created';
    const summary = `${action} ${displayPath} (${newLineCount} lines)`;
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
          path: displayPath,
          lineChanges: approval.lineChanges,
          startLine: approval.startLine,
        },
      ],
      ...(userInstruction && { userInstruction }),
    };
  }
}
