// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

// Local imports - tools
import { isTexFile } from '@common/files/fileTypeUtils';
import replacementEngine from '@replacement/engine';
import type { ToolResult } from '@shared/schemas';
import {
  applyApprovedFileEdit,
  resolveWritableTarget,
} from '@tools/fileEditFlow';
import { countLines } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';

const WriteInputSchema = z.strictObject({
  path: z
    .string()
    .describe('The file path to write, workspace-relative or absolute.'),
  content: z.string().describe('The full file contents to write.'),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;

const write = Effect.fn('WriteFileTool.execute')(function* (
  input: WriteInput,
): Effect.fn.Return<ToolResult, unknown, ToolCall> {
  const prepared = yield* resolveWritableTarget(input.path, {
    missing: 'allow',
  });
  if ('blocked' in prepared) {
    return prepared.blocked;
  }
  const { path, displayPath, exists, originalContent } = prepared.target;
  const proposedContent = isTexFile(path)
    ? replacementEngine.applyFor(input.content, 'tex-write')
    : input.content;

  return yield* applyApprovedFileEdit({
    path,
    displayPath,
    originalContent,
    proposedContent,
    sourceTool: 'write_file',
    present: ({ appliedContent }) => {
      const originalLineCount = countLines(originalContent);
      const newLineCount = countLines(appliedContent);
      const action = exists ? 'Overwrote' : 'Created';
      const replacementNote =
        exists && originalLineCount > 0
          ? `Replaced ${originalLineCount} lines with ${newLineCount} lines.`
          : undefined;
      return {
        summary: `${action} ${displayPath} (${newLineCount} lines)`,
        output: replacementNote ? `written\n\n${replacementNote}` : 'written',
      };
    },
  });
});

export class WriteFileTool extends defineTool({
  name: 'write_file',
  requiresApproval: true,
  description:
    'Overwrite a workspace file with the provided content. Creates the file if it does not exist.',
  schema: WriteInputSchema,
}) {
  protected execute(input: WriteInput) {
    return write(input);
  }
}
