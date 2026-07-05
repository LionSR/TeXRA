/**
 * Pure section-assembly for the /output endpoint's live stdout/stderr view.
 * The actual ephemeral temp-file reads stay in ExecutionsTool; this only
 * builds the <stdout>/<stderr>-wrapped text from already-read content.
 */

import type { ExecutionId } from '@shared/schemas';

/** Wrap already-read stdout/stderr content in labeled sections. */
export function formatProcessOutputSections(
  executionId: ExecutionId,
  stdout: string,
  stderr: string,
): string {
  const sections: string[] = [`Output for ${executionId}:`];
  if (stdout) sections.push('', '<stdout>', stdout, '</stdout>');
  if (stderr) sections.push('', '<stderr>', stderr, '</stderr>');
  if (!stdout && !stderr) sections.push('', '(no output yet)');
  return sections.join('\n');
}
