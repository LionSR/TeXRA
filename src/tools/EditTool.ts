// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError, type ToolResult } from '@shared/schemas';
import {
  applyApprovedFileEdit,
  replaceLiteralMatches,
  resolveWritableTarget,
} from '@tools/fileEditFlow';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';

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
  requiresApproval: true,
  description:
    'Performs exact string replacements in workspace files using literal matching. Copy text exactly as it appears in read_file output after the line-number prefix.',
  schema: EditInputSchema,
}) {
  protected async execute(input: EditInput): Promise<ToolResult> {
    const { old_str, new_str, replace_all } = input;
    const prepared = await resolveWritableTarget(input.path, {
      validate: ({ displayPath }) => {
        if (old_str.length === 0) {
          throw new ToolError(
            `old_str must not be empty for ${displayPath}. ` +
              `Provide the exact text to replace, copied from read_file output (excluding the line-number prefix).`,
          );
        }
      },
    });
    if ('blocked' in prepared) {
      return prepared.blocked;
    }
    const { path, displayPath, originalContent } = prepared.target;

    const replacement = replaceLiteralMatches({
      content: originalContent,
      search: old_str,
      replacement: new_str,
      mode: replace_all ? 'all' : 'unique',
      notFoundError: () =>
        `old_str not found in ${displayPath}.\n` +
        `To fix:\n` +
        `- Re-read the file: content may have changed since last read\n` +
        `- Copy text exactly from read_file output, excluding the line-number prefix (e.g. "  42\t"); whitespace must match`,
      multipleMatchesError: ({ count }) =>
        `old_str matches ${count} locations in ${displayPath}.\n` +
        `To fix, either:\n` +
        `- Include more surrounding context to make old_str unique\n` +
        `- Set replace_all to true to replace every occurrence: { "replace_all": true }`,
    });

    const occurrenceWord = pluralize(replacement.count, 'occurrence');
    return applyApprovedFileEdit({
      path,
      displayPath,
      originalContent,
      proposedContent: replacement.content,
      sourceTool: 'edit_file',
      startLine: 'approval',
      present: () => ({
        summary: `Edited ${displayPath}: replaced ${replacement.count} ${occurrenceWord}`,
        output: `Replaced ${replacement.count} ${occurrenceWord}.`,
      }),
    });
  }
}
