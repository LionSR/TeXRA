// Local imports - core
import { z } from 'zod';

// Local imports - tools
import { ToolError, ToolResult } from '@tools/result';
import { requireFileReadForEdit } from '@tools/fileInteractions';
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

const EditInputSchema = z.strictObject({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().nullish(),
});

export type EditInput = z.infer<typeof EditInputSchema>;

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const foundIndex = haystack.indexOf(needle, index);
    if (foundIndex === -1) {
      break;
    }
    count += 1;
    index = foundIndex + needle.length;
  }
  return count;
}

export class EditFileTool extends defineTool({
  name: 'edit_file',
  description:
    'Performs exact string replacements in workspace files using literal matching. Copy text exactly as it appears in read_file output after the line-number prefix.',
  schema: EditInputSchema,
}) {
  protected async execute(input: EditInput): Promise<ToolResult> {
    const { path: targetPath, old_string, new_string, replace_all } = input;

    if (old_string.length === 0) {
      throw new ToolError(
        `old_string must not be empty for ${targetPath}. Provide the exact text to replace from read_file output after the line-number prefix.`,
      );
    }

    const exists = await WorkspaceFS.exists(targetPath);
    const readGate = requireFileReadForEdit(targetPath, exists);
    if (readGate) {
      return readGate;
    }

    const currentContent = await WorkspaceFS.read(targetPath);
    const occurrences = countOccurrences(currentContent, old_string);

    if (occurrences === 0) {
      throw new ToolError(
        `The provided old_string was not found in ${targetPath}. Ensure it matches the read_file output exactly after the line-number prefix.`,
      );
    }

    if (replace_all !== true && occurrences > 1) {
      throw new ToolError(
        `old_string is not unique within ${targetPath}. Include more surrounding context or set replace_all to true.`,
      );
    }

    const updatedContent =
      replace_all === true
        ? currentContent.replaceAll(old_string, new_string)
        : currentContent.replace(old_string, new_string);

    const approval = await requestToolEditApproval({
      path: targetPath,
      originalContent: currentContent,
      proposedContent: updatedContent,
      sourceTool: 'edit_file',
    });

    if (!approval.accepted) {
      return buildApprovalRejectedResult(
        targetPath,
        'edit_file',
        approval.userMessage,
      );
    }

    const finalContent = getApprovedContent(approval, updatedContent);
    const { appliedContent } = await writeApprovedContent(
      targetPath,
      currentContent,
      finalContent,
    );

    const replacementSummary =
      replace_all === true
        ? `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'}.`
        : 'Replaced 1 occurrence.';
    const summary =
      replace_all === true
        ? `Edited ${targetPath}: replaced ${occurrences} occurrence${
            occurrences === 1 ? '' : 's'
          }`
        : `Edited ${targetPath}: replaced 1 occurrence`;

    const userDiffNote = formatUnifiedApprovalUserDiff(
      targetPath,
      finalContent,
      appliedContent,
    );
    const output = userDiffNote
      ? `${replacementSummary}\n\n${userDiffNote}`
      : replacementSummary;

    return {
      summary,
      output,
      userPatch: approval.userPatch,
      edits: [{ path: targetPath, lineChanges: approval.lineChanges }],
    };
  }
}
