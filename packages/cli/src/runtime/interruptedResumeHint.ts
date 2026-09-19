import type { ResumabilityDecision } from '@agent/storage';
import type { RunId } from '@shared/schemas';

import { formatResumeCommand } from '../chat/tui/state/resumeHint';
import { readCliCwd, type CliContext } from './cliContext';
import { writeTextStderr, writeTextStderrAndWait } from './logSinks';

/** The one resumability answer a hint can be advertised from. */
export type ResumableCheckpoint = Extract<
  ResumabilityDecision,
  { kind: 'checkpoint' }
>;

/**
 * The one reading of "this decision advertises a resumable run": a checkpoint
 * the command's own refinement agrees to, where no refinement means yes. Each
 * probe on the interrupt path asks this at its own instant, and `refine` may
 * throw, so its caller decides whether that is fatal.
 */
export function advertisesInterruptedRun(
  resumability: ResumabilityDecision | undefined,
  refine: ((checkpoint: ResumableCheckpoint) => boolean) | undefined,
): boolean {
  return (
    resumability?.kind === 'checkpoint' && (refine?.(resumability) ?? true)
  );
}

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
    includeInteropSkills: context.skillSourceOptions.includeInterop,
    skillSourcePaths: context.skillSourceOptions.additionalPaths,
  });
  return `Resume this ${subject} with: ${resumeCommand}`;
}
