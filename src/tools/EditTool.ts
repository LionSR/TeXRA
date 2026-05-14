// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { ToolError, ToolResult } from '@tools/result';
import {
  recordToolFileRead,
  requireFileReadForEdit,
} from '@tools/fileInteractions';
import { pluralize } from '@tools/formatting';
import {
  assertWritable,
  resolveAndFormat,
  parseWorkingDirectory,
} from '@tools/pathResolution';
import { countOccurrences } from '@tools/utils';
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
  old_str: z.string(),
  new_str: z.string(),
  replace_all: z.boolean().nullish(),
});

export type EditInput = z.infer<typeof EditInputSchema>;

export class EditFileTool extends defineTool({
  name: 'edit_file',
  description:
    'Performs exact string replacements in workspace files using literal matching. Copy text exactly as it appears in read_file output after the line-number prefix.',
  schema: EditInputSchema,
}) {
  protected async execute(input: EditInput): Promise<ToolResult> {
    const { old_str, new_str, replace_all } = input;
    const root = parseWorkingDirectory(tryUseRunContext()?.workingDirectory);
    const { path: resolved, display: displayPath } = resolveAndFormat(
      input.path,
      root,
    );
    assertWritable(resolved, displayPath);
    const targetPath = resolved.fsPath;

    if (old_str.length === 0) {
      throw new ToolError(
        `old_str must not be empty for ${displayPath}. ` +
          `Provide the exact text to replace, copied from read_file output (excluding the line-number prefix).`,
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
        `old_str not found in ${displayPath}.\n` +
          `To fix:\n` +
          `- Re-read the file — content may have changed since last read\n` +
          `- Copy text exactly from read_file output, excluding the line-number prefix (e.g. "  42\t"); whitespace must match`,
      );
    }

    if (!replace_all && occurrences > 1) {
      throw new ToolError(
        `old_str matches ${occurrences} locations in ${displayPath}.\n` +
          `To fix, either:\n` +
          `- Include more surrounding context to make old_str unique\n` +
          `- Set replace_all to true to replace every occurrence: { "replace_all": true }`,
      );
    }

    // Use split/join and indexOf/slice for literal replacement
    // (String.replace has special patterns like $$, $&, $' that corrupt LaTeX)
    let updatedContent: string;
    if (replace_all) {
      updatedContent = currentContent.split(old_str).join(new_str);
    } else {
      const idx = currentContent.indexOf(old_str);
      updatedContent =
        currentContent.slice(0, idx) +
        new_str +
        currentContent.slice(idx + old_str.length);
    }

    const approval = await requestToolEditApproval({
      path: targetPath,
      originalContent: currentContent,
      proposedContent: updatedContent,
      sourceTool: 'edit_file',
    });

    if (!approval.accepted) {
      return buildApprovalRejectedResult(
        displayPath,
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
    const summary = `Edited ${displayPath}: replaced ${count} ${pluralize(count, 'occurrence')}`;

    const userDiffNote = formatUnifiedApprovalUserDiff(
      displayPath,
      updatedContent,
      appliedContent,
    );
    const output = userDiffNote
      ? `${replacementSummary}\n\n${userDiffNote}`
      : replacementSummary;

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
    };
  }
}
