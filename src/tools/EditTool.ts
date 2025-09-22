// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolError, ToolResult } from '@tools/result';
import { clearTrackedFile, ensureFileWasRead } from './fileAccessTracker';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const EditInputSchema = z
  .object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  })
  .strict();

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
    'Performs exact string replacements in workspace files using literal matching.',
  schema: EditInputSchema,
}) {
  protected async execute(input: EditInput): Promise<ToolResult> {
    const { path: targetPath, old_string, new_string, replace_all } = input;

    ensureFileWasRead(targetPath);

    if (old_string.length === 0) {
      throw new ToolError(
        'old_string must not be empty. Provide the exact text to replace from read_file output.',
      );
    }

    const currentContent = await WorkspaceFS.read(targetPath);
    const occurrences = countOccurrences(currentContent, old_string);

    if (occurrences === 0) {
      throw new ToolError(
        'The provided old_string was not found. Ensure it matches the read_file output exactly.',
      );
    }

    if (!replace_all && occurrences > 1) {
      throw new ToolError(
        'old_string is not unique. Include more surrounding context or set replace_all to true.',
      );
    }

    const updatedContent = replace_all
      ? currentContent.split(old_string).join(new_string)
      : currentContent.replace(old_string, new_string);

    await WorkspaceFS.write(targetPath, updatedContent);
    clearTrackedFile(targetPath);

    const replacementSummary = replace_all
      ? `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'}.`
      : 'Replaced 1 occurrence.';

    return new ToolResult({ output: replacementSummary });
  }
}
