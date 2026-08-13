import type { ExecutionId } from '@shared/schemas';

import { formatResumeCommand } from '../chat/tui/state/resumeHint';
import { readCliCwd, type CliContext } from './cliContext';

/** Read the launch directory without making recovery depend on its lifetime. */
export function tryReadCliCwd(): string | undefined {
  try {
    return readCliCwd();
  } catch {
    return undefined;
  }
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
