// Standard library imports
import * as path from 'path';

// Local imports

/**
 * Build a consistent stream identifier based on agent, model and input file.
 */
export function getStreamId(
  agent: string,
  model: string,
  inputFile: string,
  outputFiles?: string[],
): string {
  const agentName =
    outputFiles && outputFiles.length > 1 ? `${agent}_multiple` : agent;
  return `${agentName}@${model}: ${path.basename(inputFile)}`;
}
