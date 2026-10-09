// Third-party imports
import { Effect, FileSystem } from 'effect';
import { z } from 'zod';
import type { RunCall } from '@agent/runtime/RunCall';
import { ToolContext } from '@agent/core/tools/ToolTypes';

// Local imports - tools
import type { ConfigProvider } from '@platform/interfaces';
import type { AgentCatalogServices } from '@platform/processRuntime';
import { WorkspaceFs } from '@platform/rootedFs';
import type { ToolResult } from '@shared/schemas';
import {
  applyApprovedFileEdit,
  resolveWritableTarget,
} from '@tools/fileEditFlow';
import { countLines } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/definition';

const WriteInputSchema = z.strictObject({
  path: z
    .string()
    .describe('The file path to write, workspace-relative or absolute.'),
  content: z.string().describe('The full file contents to write.'),
});

type WriteInput = z.infer<typeof WriteInputSchema>;

/**
 * What an app does to the content `write_file` is given before it proposes
 * it, by path, under the call's workspace configuration: TeXRA's `.tex`
 * replacements. The harness's `write_file` writes what it is given.
 */
export type WriteFilter = (
  path: string,
  content: string,
  config: ConfigProvider,
) => Effect.Effect<string>;

const write = Effect.fn('WriteFileTool.execute')(function* (
  input: WriteInput,
  writeFilter: WriteFilter | undefined,
): Effect.fn.Return<
  ToolResult,
  Error,
  | ToolContext
  | RunCall
  | FileSystem.FileSystem
  | WorkspaceFs
  | AgentCatalogServices
> {
  const call = yield* ToolContext;
  const prepared = yield* resolveWritableTarget(input.path, {
    missing: 'allow',
  });
  if ('blocked' in prepared) {
    return prepared.blocked;
  }
  const { path, displayPath, exists, originalContent } = prepared.target;
  const proposedContent =
    writeFilter === undefined
      ? input.content
      : yield* writeFilter(path, input.content, call.env.roots.config);

  return yield* applyApprovedFileEdit({
    path,
    displayPath,
    exists,
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

/** The `write_file` tool, with the app's filter on what it writes. */
export const writeFileTool = (writeFilter?: WriteFilter) =>
  defineTool({
    name: 'write_file',
    requiresApproval: 'inBody',
    description:
      'Overwrite a workspace file with the provided content. Creates the file if it does not exist.',
    schema: WriteInputSchema,
    // The file this call overwrites: the loop refuses it before the body runs
    // when it escapes the call's roots or lands in a read-only external root.
    guard: { writes: (input: WriteInput) => [input.path] },
    execute: (input) => write(input, writeFilter),
  });
