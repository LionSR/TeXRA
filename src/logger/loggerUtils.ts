// Standard library imports
import * as path from 'path';

// Local imports

// Centralised emoji mapping for log levels
export const EMOJI_BY_LEVEL: Record<string, string> = {
  error: '🔴', // Red dot
  warn: '🟡', // Yellow dot
  info: '🟢', // Green dot
  debug: '🔍', // Magnifying glass
};

/**
 * Returns the emoji icon associated with a log level.
 * Falls back to a bullet if the level is not recognised.
 */
export function getColorForLevel(level: string): string {
  return EMOJI_BY_LEVEL[level.toLowerCase()] ?? '•';
}

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
