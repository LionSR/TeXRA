// Stream ID utilities for command operations

import * as path from 'path';

/**
 * Generates a stream ID for agent operations.
 * Stream IDs follow the pattern: agent@model: filename
 * 
 * @param agent - The agent name
 * @param model - The model name
 * @param inputFile - The input file path (used as fallback)
 * @param outputFiles - Optional array of output files (determines _multiple suffix)
 * @param outputNameOverride - Optional override for the filename (empty strings treated as undefined)
 * @returns The generated stream ID
 */
export function getStreamId(
  agent: string,
  model: string,
  inputFile: string,
  outputFiles?: string[],
  outputNameOverride?: string,
): string {
  // Determine agent name with _multiple suffix if needed
  const agentName =
    outputFiles && outputFiles.length > 1 ? `${agent}_multiple` : agent;
  
  // Use outputNameOverride if provided and not empty, otherwise use inputFile
  // This properly handles empty strings by treating them as falsy
  const effectiveFileName = (outputNameOverride && outputNameOverride.trim()) || inputFile;
  
  return `${agentName}@${model}: ${path.basename(effectiveFileName)}`;
}