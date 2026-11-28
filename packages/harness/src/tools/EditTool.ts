// Third-party imports
import { Effect, FileSystem, Schema } from 'effect';
import { ToolContext } from '@tools/core/ToolTypes';

// Local imports - tools
import type { AppSignals } from '@platform/appSignals';
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
import { optionalInput } from './core/inputSchema';

const EditInputSchema = Schema.Struct({
  path: Schema.String.annotate({
    description: 'Workspace-relative or absolute file path to edit.',
  }),
  old_str: Schema.String.annotate({
    description:
      'Exact literal text to replace, without read_file line-number prefixes.',
  }),
  new_str: Schema.String.annotate({
    description: 'Replacement text to write in place of old_str.',
  }),
  replace_all: optionalInput(
    Schema.Boolean,
    'Replace every occurrence instead of requiring one unique match.',
  ),
});

type EditInput = typeof EditInputSchema.Type;

const edit = Effect.fn('EditFileTool.execute')(function* (
  input: EditInput,
): Effect.fn.Return<
  ToolResult,
  Error,
  ToolContext | FileSystem.FileSystem | WorkspaceFs | AppSignals
> {
  const { old_str, new_str, replace_all } = input;
  const prepared = yield* resolveWritableTarget(input.path);
  const { displayPath, original } = prepared;
  if (original === null) {
    return yield* new ToolError(
      `${displayPath} does not exist. Create it with write_file.`,
    );
  }
  if (old_str.length === 0) {
    return yield* new ToolError(
      `old_str must not be empty for ${displayPath}.`,
    );
  }

  // A missing or ambiguous match is the model's error to correct, so it stays
  // a failure the tool runner reports rather than a defect.
  const replacement = yield* Effect.fromResult(
    replaceLiteralMatches({
      content: original,
      search: old_str,
      replacement: new_str,
      replaceAll: replace_all ?? false,
      notFoundError: () => `old_str not found in ${displayPath}.`,
      multipleMatchesError: (count) =>
        `old_str matches ${count} locations in ${displayPath}.`,
    }),
  );

  const occurrenceWord = pluralize(replacement.count, 'occurrence');
  return yield* applyApprovedFileEdit({
    target: prepared,
    proposedContent: replacement.content,
    sourceTool: 'edit_file',
    present: () => ({
      summary: `Edited ${displayPath}: replaced ${replacement.count} ${occurrenceWord}`,
      output: `Replaced ${replacement.count} ${occurrenceWord}.`,
    }),
  });
});

export const EditFileTool = defineTool({
  name: 'edit_file',
  requiresApproval: 'inBody',
  description:
    'Performs exact string replacements in files using literal matching.',
  schema: EditInputSchema,
  execute: edit,
});
