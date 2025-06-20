// Third-party imports
import * as path from 'path';

// Utility functions for stream identifiers

/**
 * Generate a stream identifier for logging and progress tracking.
 * Appends `_multiple` to the agent name when more than one output file
 * is provided.
 *
 * @param agent - Name of the agent
 * @param model - Model identifier
 * @param inputFile - Path to the input file
 * @param outputFiles - Optional list of output files
 * @returns Formatted stream ID
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
