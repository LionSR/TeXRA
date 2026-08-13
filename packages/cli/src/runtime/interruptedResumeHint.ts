import type { ExecutionId } from '@shared/schemas';

import { formatResumeCommand } from '../chat/tui/state/resumeHint';
import { readCliCwd, type CliContext } from './cliContext';
import { writeTextStderr, writeTextStderrAndWait } from './logSinks';

/** Read the launch directory without making recovery depend on its lifetime. */
export function tryReadCliCwd(): string | undefined {
  try {
    return readCliCwd();
  } catch {
    // process.cwd() can fail after the launch directory is deleted. Omitting
    // it safely makes the resume formatter state the workspace explicitly.
    return undefined;
  }
}

/** Keep recovery commands on the human-facing error stream. */
export function writeInterruptedResumeHint(
  hint: string,
  waitForWrite = false,
): Promise<void> | undefined {
  if (waitForWrite) return writeTextStderrAndWait(hint);
  writeTextStderr(hint);
}

/** Format a copyable command after the caller has established resumability. */
export function formatInterruptedResumeHint(
  context: CliContext,
  executionId: ExecutionId,
  subject: 'session' | 'workflow',
  workingDirectory: string,
  processCwd: string | undefined,
): string {
  const resumeCommand = formatResumeCommand(context.commandName, executionId, {
    cwd: workingDirectory,
    processCwd,
    approvalPolicy: context.approvalPolicy,
    outputFormat: subject === 'workflow' ? context.outputFormat : undefined,
    print: subject === 'workflow' && context.mode === 'headless',
    includeInteropSkills: context.skillSourceOptions.includeInterop,
    skillSourcePaths: context.skillSourceOptions.additionalPaths,
  });
  return `Resume this ${subject} with: ${resumeCommand}`;
}
