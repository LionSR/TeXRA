import * as path from 'node:path';

import { Effect, FileSystem, PlatformError } from 'effect';

import { CliUsageError } from '@cli/runtime/cliContext';
import { absentReason } from '@utils/files/fsEntryExists';

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
): Effect.Effect<
  string,
  CliUsageError | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  const inlineInstruction = init.instruction.trim();
  const trimmed = init.instructionFile?.trim();
  if (!trimmed) return Effect.succeed(inlineInstruction);
  // path.resolve drops all prior segments once it hits an absolute one, so
  // this covers both the absolute and cwd-relative spellings.
  const absolutePath = path.resolve(cwd, trimmed);
  return FileSystem.FileSystem.use((fs) =>
    fs.readFileString(absolutePath),
  ).pipe(
    Effect.catchIf(absentReason, () =>
      Effect.fail(
        new CliUsageError(`--instruction-file: file not found: ${trimmed}`),
      ),
    ),
    Effect.map((fileInstruction) =>
      [fileInstruction.trim(), inlineInstruction].filter(Boolean).join('\n\n'),
    ),
  );
}
