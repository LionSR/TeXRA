// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError, ToolResult } from '@shared/schemas/toolResult';
import { requireFileReadForEdit } from '@tools/fileInteractions';
import {
  assertWritable,
  resolveAndFormat,
  currentToolRoot,
} from '@tools/pathResolution';
import { countOccurrences } from '@tools/utils';
import {
  appendApprovalDiffNote,
  requestAndWriteApprovedEdit,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { replaceAllLiteral, replaceFirstLiteral } from './editPrimitives';

const EditInputSchema = z.strictObject({
  path: z
    .string()
    .describe('Workspace-relative or absolute file path to edit.'),
  old_str: z
    .string()
    .describe('Exact literal text to replace, copied from read_file output.'),
  new_str: z
    .string()
    .describe('Replacement text to write in place of old_str.'),
  replace_all: z
    .boolean()
    .nullish()
    .describe(
      'Replace every occurrence instead of requiring one unique match.',
    ),
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
    const root = currentToolRoot();
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

    // Literal replacement (String.replace would interpret $$, $&, $', `$\``
    // patterns and corrupt LaTeX/code); see editPrimitives.
    const updatedContent = replace_all
      ? replaceAllLiteral(currentContent, old_str, new_str)
      : replaceFirstLiteral(currentContent, old_str, new_str);

    const outcome = await requestAndWriteApprovedEdit({
      path: targetPath,
      displayPath,
      originalContent: currentContent,
      proposedContent: updatedContent,
      sourceTool: 'edit_file',
    });
    if ('rejected' in outcome) {
      return outcome.rejected;
    }
    const { approval, appliedContent } = outcome;

    const count = replace_all ? occurrences : 1;
    const occurrenceWord = pluralize(count, 'occurrence');
    const replacementSummary = `Replaced ${count} ${occurrenceWord}.`;
    const summary = `Edited ${displayPath}: replaced ${count} ${occurrenceWord}`;

    const output = appendApprovalDiffNote(
      replacementSummary,
      displayPath,
      updatedContent,
      appliedContent,
    );

    return {
      status: 'executed',
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
