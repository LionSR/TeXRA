import * as path from 'path';

/**
 * Generate a unique stream ID for progress view entries.
 *
 * @param agent The agent name
 * @param model The model name
 * @param inputFile The main input file path
 * @param outputFiles Additional output files for multiple mode
 * @param outputNameOverride Optional override for the output file name
 */
export function getStreamId(
  agent: string,
  model: string,
  inputFile: string,
  outputFiles: string[] = [],
  outputNameOverride = '',
): string {
  const agentName = outputFiles.length > 1 ? `${agent}_multiple` : agent;
  const baseName = path.basename(outputNameOverride || inputFile);
  return `${agentName}@${model}: ${baseName}`;
}
