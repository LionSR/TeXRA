// Node imports
import { AsyncLocalStorage } from 'node:async_hooks';

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports - tools
import { hostPort } from '@common/hostPort';
import { effectRuntime } from '@platform/processRuntime';
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

/**
 * The edit flow, bound to the calling turn: both steps read the working
 * directory, the read-before-edit tracker, and the approval host from the
 * run context the tool was called in, not from the fiber that runs them.
 */
interface FileEditPorts {
  readonly resolveWritableTarget: typeof resolveWritableTarget;
  readonly applyApprovedFileEdit: typeof applyApprovedFileEdit;
}

const edit = Effect.fn('EditFileTool.execute')(function* (
  ports: FileEditPorts,
  input: EditInput,
): Effect.fn.Return<ToolResult, unknown> {
  const { old_str, new_str, replace_all } = input;
  const prepared = yield* hostPort(() =>
    ports.resolveWritableTarget(input.path, {
      validate: ({ displayPath }) => {
        if (old_str.length === 0) {
          throw new ToolError(
            `old_str must not be empty for ${displayPath}. ` +
              `Provide the exact text to replace, copied from read_file output (excluding the line-number prefix).`,
          );
        }
      },
    }),
  );
  if ('blocked' in prepared) {
    return prepared.blocked;
  }
  const { path, displayPath, originalContent } = prepared.target;

  // A missing or ambiguous match is the model's error to correct, so it stays
  // a failure the tool runner reports rather than a defect.
  const replacement = yield* Effect.try({
    try: () =>
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
    catch: (error) => error,
  });

  const occurrenceWord = pluralize(replacement.count, 'occurrence');
  return yield* hostPort(() =>
    ports.applyApprovedFileEdit({
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
    }),
  );
});

export class EditFileTool extends defineTool({
  name: 'edit_file',
  requiresApproval: true,
  description:
    'Performs exact string replacements in workspace files using literal matching. Copy text exactly as it appears in read_file output after the line-number prefix.',
  schema: EditInputSchema,
}) {
  protected execute(input: EditInput): Promise<ToolResult> {
    return effectRuntime().runPromise(
      edit(
        {
          resolveWritableTarget: AsyncLocalStorage.bind(resolveWritableTarget),
          applyApprovedFileEdit: AsyncLocalStorage.bind(applyApprovedFileEdit),
        },
        input,
      ),
    );
  }
}
