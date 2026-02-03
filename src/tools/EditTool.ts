// Local imports - core
import { z } from 'zod';

// Local imports - tools
import { ToolError, ToolResult } from '@tools/result';
import {
  recordToolFileRead,
  requireFileReadForEdit,
} from '@tools/fileInteractions';
import { pluralize } from '@tools/utils';
import {
  buildApprovalRejectedResult,
  firstChangedLine,
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
  old_str: z.string(),
  new_str: z.string(),
  replace_all: z.boolean().nullish(),
});

export type EditInput = z.infer<typeof EditInputSchema>;

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
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
    const { path: targetPath, old_str, new_str, replace_all } = input;

    if (old_str.length === 0) {
      throw new ToolError(
        `old_str must not be empty for ${targetPath}. Provide the exact text to replace from read_file output after the line-number prefix.`,
      );
    }

    const exists = await WorkspaceFS.exists(targetPath);
    const readGate = requireFileReadForEdit(targetPath, exists);
    if (readGate) {
      return readGate;
    }

    const currentContent = await WorkspaceFS.read(targetPath);
    const occurrences = countOccurrences(currentContent, old_str);

    if (occurrences === 0) {
      throw new ToolError(
        `The provided old_str was not found in ${targetPath}. Ensure it matches the read_file output exactly after the line-number prefix.`,
      );
    }

    if (!replace_all && occurrences > 1) {
      throw new ToolError(
        `old_str is not unique within ${targetPath}. Include more surrounding context or set replace_all to true.`,
      );
    }

    const updatedContent = replace_all
      ? currentContent.replaceAll(old_str, new_str)
      : currentContent.replace(old_str, new_str);

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

    recordToolFileRead(targetPath);

    const count = replace_all ? occurrences : 1;
    const replacementSummary = `Replaced ${count} ${pluralize(count, 'occurrence')}.`;
    const summary = `Edited ${targetPath}: replaced ${count} ${pluralize(count, 'occurrence')}`;

    const userDiffNote = formatUnifiedApprovalUserDiff(
      targetPath,
      updatedContent,
      appliedContent,
    );
    const output = userDiffNote
      ? `${replacementSummary}\n\n${userDiffNote}`
      : replacementSummary;

    // Compute first changed line (convert from 0-based to 1-based for display)
    const changedLine = firstChangedLine(currentContent, appliedContent);
    const startLine = changedLine !== null ? changedLine + 1 : undefined;

    return {
      summary,
      output,
      userPatch: approval.userPatch,
      edits: [
        { path: targetPath, lineChanges: approval.lineChanges, startLine },
      ],
    };
  }
}
