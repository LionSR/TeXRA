// Third-party imports
import { Effect, FileSystem, Schema } from 'effect';
import { ToolContext } from '@agent/core/tools/ToolTypes';

// Local imports - tools
import type { AgentCatalog } from '@agent/index/agentCatalog';
import { WorkspaceFs } from '@platform/rootedFs';
import { ToolError, type ToolResult } from '@shared/schemas';
import {
  applyApprovedFileEdit,
  replaceLiteralMatches,
  resolveWritableTarget,
} from '@tools/fileEditFlow';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/definition';

const EditInputSchema = Schema.Struct({
  path: Schema.String.annotate({
    description: 'Workspace-relative or absolute file path to edit.',
  }),
  old_str: Schema.String.annotate({
    description: 'Exact literal text to replace, copied from read_file output.',
  }),
  new_str: Schema.String.annotate({
    description: 'Replacement text to write in place of old_str.',
  }),
  replace_all: Schema.optional(Schema.NullOr(Schema.Boolean)).annotate({
    description:
      'Replace every occurrence instead of requiring one unique match.',
  }),
});

type EditInput = typeof EditInputSchema.Type;

const edit = Effect.fn('EditFileTool.execute')(function* (
  input: EditInput,
): Effect.fn.Return<
  ToolResult,
  Error,
  ToolContext | FileSystem.FileSystem | WorkspaceFs | AgentCatalog
> {
  const { old_str, new_str, replace_all } = input;
  const prepared = yield* resolveWritableTarget(input.path);
  if ('blocked' in prepared) {
    return prepared.blocked;
  }
  const { path, displayPath, exists, originalContent } = prepared.target;
  if (old_str.length === 0) {
    return yield* Effect.fail(
      new ToolError(
        `old_str must not be empty for ${displayPath}. ` +
          `Provide the exact text to replace, copied from read_file output (excluding the line-number prefix).`,
      ),
    );
  }

  // A missing or ambiguous match is the model's error to correct, so it stays
  // a failure the tool runner reports rather than a defect.
  const replacement = yield* Effect.fromResult(
    replaceLiteralMatches({
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
    }),
  );

  const occurrenceWord = pluralize(replacement.count, 'occurrence');
  return yield* applyApprovedFileEdit({
    path,
    displayPath,
    exists,
    originalContent,
    proposedContent: replacement.content,
    sourceTool: 'edit_file',
    present: () => ({
      summary: `Edited ${displayPath}: replaced ${replacement.count} ${occurrenceWord}`,
      output: `Replaced ${replacement.count} ${occurrenceWord}.`,
    }),
  });
});

/** The `edit_file` tool: exact literal string replacements in a workspace file, written after the edit is approved. */
export const EditFileTool = defineTool({
  name: 'edit_file',
  requiresApproval: 'inBody',
  description:
    'Performs exact string replacements in workspace files using literal matching. Copy text exactly as it appears in read_file output after the line-number prefix.',
  schema: EditInputSchema,
  // The file this call rewrites; refused loop-side before the body runs.
  guard: { writes: (input: EditInput) => [input.path] },
  execute: edit,
});
