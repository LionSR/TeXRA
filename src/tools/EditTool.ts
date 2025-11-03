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
import { ToolError, ToolResult, toolResult } from '@tools/result';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const EditInputSchema = z.strictObject({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
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

    const currentContent = await WorkspaceFS.read(targetPath);
    const occurrences = countOccurrences(currentContent, old_string);

    if (occurrences === 0) {
      throw new ToolError(
        `The provided old_string was not found in ${targetPath}. Ensure it matches the read_file output exactly after the line-number prefix.`,
      );
    }

    if (!replace_all && occurrences > 1) {
      throw new ToolError(
        `old_string is not unique within ${targetPath}. Include more surrounding context or set replace_all to true.`,
      );
    }

    // TODO: Reintroduce a read-before-edit guard when the tool runtime provides
    // session-scoped state. The previous implementation persisted state across runs.
    const updatedContent = replace_all
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

    const replacementSummary = replace_all
      ? `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'}.`
      : 'Replaced 1 occurrence.';
    const summary = replace_all
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

    return toolResult({
      summary,
      output,
    });
  }
}
