/**
 * Derive multiple output behavior from execution context.
 * Keeps a single algorithm across initial runs, follow-ups, and proposals.
 */
export interface UseMultipleOutputsOptions {
  isToolUse?: boolean;
  outputFiles: string[];
  outputFilesActive?: boolean;
  previousUseMultipleOutputs?: boolean;
}

export function deriveUseMultipleOutputs({
  isToolUse,
  outputFiles,
  outputFilesActive,
  previousUseMultipleOutputs,
}: UseMultipleOutputsOptions): boolean {
  if (isToolUse) return false;
  return (
    Boolean(outputFilesActive) ||
    outputFiles.length > 1 ||
    Boolean(previousUseMultipleOutputs)
  );
}
