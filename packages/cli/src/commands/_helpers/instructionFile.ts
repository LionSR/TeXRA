import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { CliUsageError } from '@cli/runtime/cliContext';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';

async function readInstructionFile(
  instructionFile: string | undefined,
  cwd: string,
): Promise<string> {
  const trimmed = instructionFile?.trim();
  if (!trimmed) return '';
  // path.resolve drops all prior segments once it hits an absolute one, so
  // this covers both the absolute and cwd-relative spellings.
  const absolutePath = path.resolve(cwd, trimmed);
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error: unknown) {
    if (isFileNotFoundError(error) || isNotADirectoryError(error)) {
      throw new CliUsageError(`--instruction-file: file not found: ${trimmed}`);
    }
    throw error;
  }
}

export async function resolveFileBackedInstruction(
  init: {
    readonly instruction: string;
    readonly instructionFile?: string;
  },
  cwd: string,
): Promise<string> {
  const fileInstruction = await readInstructionFile(init.instructionFile, cwd);
  const inlineInstruction = init.instruction.trim();
  return [fileInstruction.trim(), inlineInstruction]
    .filter(Boolean)
    .join('\n\n');
}
