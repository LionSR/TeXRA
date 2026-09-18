import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect } from 'effect';

import { CliUsageError } from '@cli/runtime/cliContext';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { ensureError } from '@utils/errors/errorMessage';

/**
 * The instruction a run starts from: the `--instruction-file` contents ahead of
 * the inline `--instruction`, with either half omitted when it is empty.
 */
export function resolveFileBackedInstruction(
  init: {
    readonly instruction: string;
    readonly instructionFile?: string;
  },
  cwd: string,
): Effect.Effect<string, Error> {
  const inlineInstruction = init.instruction.trim();
  const trimmed = init.instructionFile?.trim();
  if (!trimmed) return Effect.succeed(inlineInstruction);
  // path.resolve drops all prior segments once it hits an absolute one, so
  // this covers both the absolute and cwd-relative spellings.
  const absolutePath = path.resolve(cwd, trimmed);
  return Effect.tryPromise({
    try: () => readFile(absolutePath, 'utf8'),
    catch: (error: unknown) =>
      isFileNotFoundError(error) || isNotADirectoryError(error)
        ? new CliUsageError(`--instruction-file: file not found: ${trimmed}`)
        : ensureError(error),
  }).pipe(
    Effect.map((fileInstruction) =>
      [fileInstruction.trim(), inlineInstruction].filter(Boolean).join('\n\n'),
    ),
  );
}
