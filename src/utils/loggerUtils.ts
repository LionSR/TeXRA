// Standard library imports
import * as path from 'path';

// Local imports

// Track channels explicitly registered as agent loggers
const agentChannels = new Set<string>();

/**
 * Register a channel as an agent logger. Agent loggers stream to
 * the progress view and get their own output channel.
 */
export function registerAgentChannel(channel: string): void {
  agentChannels.add(channel);
}

/**
 * Determines if a stream corresponds to an agent logger.
 * Channels are registered via {@link registerAgentChannel} when the logger is created.
 */
export function isAgentChannel(channel: string): boolean {
  return agentChannels.has(channel);
}

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
