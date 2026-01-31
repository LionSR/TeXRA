export interface UseMultipleOutputsOptions {
  isToolUse: boolean;
  outputFiles?: string[];
  outputFilesActive?: boolean;
  useMultipleOutputs?: boolean | null;
  attachAgentOutputs?: boolean;
}

export function deriveUseMultipleOutputs(
  options: UseMultipleOutputsOptions,
): boolean {
  const {
    isToolUse,
    outputFiles = [],
    outputFilesActive,
    useMultipleOutputs,
    attachAgentOutputs,
  } = options;

  if (isToolUse) return false;
  if (useMultipleOutputs !== undefined && useMultipleOutputs !== null) {
    return useMultipleOutputs;
  }
  if (attachAgentOutputs) return outputFiles.length > 1;
  return Boolean(outputFilesActive) || outputFiles.length > 1;
}
