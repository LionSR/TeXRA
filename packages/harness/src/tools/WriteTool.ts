// Third-party imports
import { Effect, FileSystem, Schema } from 'effect';
import { ToolContext } from '@tools/core/ToolTypes';

// Local imports - tools
import type { AppSignals } from '@platform/appSignals';
import { WorkspaceFs } from '@platform/rootedFs';
import type { ToolResult } from '@shared/schemas';
import {
  applyApprovedFileEdit,
  resolveWritableTarget,
} from '@tools/fileEditFlow';
import { countLines } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/definition';

const WriteInputSchema = Schema.Struct({
  path: Schema.String.annotate({
    description: 'The file path to write, workspace-relative or absolute.',
  }),
  content: Schema.String.annotate({
    description: 'The full file contents to write.',
  }),
});

type WriteInput = typeof WriteInputSchema.Type;

const write = Effect.fn('WriteFileTool.execute')(function* (
  input: WriteInput,
): Effect.fn.Return<
  ToolResult,
  Error,
  ToolContext | FileSystem.FileSystem | WorkspaceFs | AppSignals
> {
  const prepared = yield* resolveWritableTarget(input.path);
  const { displayPath, original } = prepared;

  return yield* applyApprovedFileEdit({
    target: prepared,
    proposedContent: input.content,
    sourceTool: 'write_file',
    present: (appliedContent) => {
      const originalLineCount = countLines(original ?? '');
      const newLineCount = countLines(appliedContent);
      const action = original === null ? 'Created' : 'Overwrote';
      const replacementNote =
        originalLineCount > 0
          ? `Replaced ${originalLineCount} lines with ${newLineCount} lines.`
          : undefined;
      return {
        summary: `${action} ${displayPath} (${newLineCount} lines)`,
        output: replacementNote ? `written\n\n${replacementNote}` : 'written',
      };
    },
  });
});

export const WriteFileTool = defineTool({
  name: 'write_file',
  requiresApproval: 'inBody',
  description:
    'Overwrite a workspace file with the provided content. Creates the file if it does not exist.',
  schema: WriteInputSchema,
  execute: write,
});
