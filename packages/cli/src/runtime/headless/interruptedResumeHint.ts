import { TASK_ACTIONS } from '@ui/copy/nestedRuns';

import { formatResumeCommand } from '../../chat/tui/state/resumeHint';
import { readCliCwd, type CliContext } from '../platform/cliContext';
import type { RunId } from '@texra-ai/harness/schemas';

/** Read the launch directory without making recovery depend on its lifetime. */
export function tryReadCliCwd(): string | undefined {
  try {
    return readCliCwd();
  } catch {
    // The ambient launch-directory read can fail after that directory is
    // deleted. Omitting it makes the formatter state the workspace explicitly.
    return undefined;
  }
}

/** Format a copyable command after the caller has established resumability;
 *  it goes to stderr, the human-facing stream. */
export function formatInterruptedResumeHint(
  context: CliContext,
  runId: RunId,
  subject: 'session' | 'workflow',
  workingDirectory: string,
  processCwd: string | undefined,
): string {
  const resumeCommand = formatResumeCommand(context.commandName, runId, {
    cwd: workingDirectory,
    processCwd,
    approvalPolicy: context.approvalPolicy,
    outputFormat: subject === 'workflow' ? context.outputFormat : undefined,
    print: subject === 'workflow' && context.mode === 'headless',
    skillSourcePaths: context.skillSourceOptions.additionalPaths,
  });
  return `${TASK_ACTIONS.resumeHint} ${resumeCommand}`;
}
