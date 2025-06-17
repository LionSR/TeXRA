// Local imports
import { getConfig } from './config';

/**
 * Determines if a stream name corresponds to an agent or contains agent information.
 * Agent streams are displayed in both the ProgressView and their own output channels.
 * Non-agent streams are consolidated into a single output channel.
 */
export function isAgentStream(streamName: string): boolean {
  // Special cases that are always treated as agent streams
  if (streamName.includes('merge')) {
    return true;
  }

  // Get the list of agents from config
  const agents = getConfig<string[]>('agents', [
    'correct',
    'polish',
    'draw',
    'ocr',
    'paper2slide',
    'paper2poster',
    'transcribe_audio',
    'merge',
  ]);

  // Check if the stream name starts with any agent name followed by '@' (agent@model: file format)
  for (const agent of agents) {
    if (
      streamName.startsWith(`${agent}@`) ||
      streamName.startsWith(`${agent}_multiple@`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Determines if a stream should be excluded from the ProgressView
 * (only shown in consolidated output channel).
 */
export function shouldExcludeFromProgressView(streamName: string): boolean {
  // If it's an agent stream, it should be included in the ProgressView
  if (isAgentStream(streamName)) {
    return false;
  }

  // All other streams (including executeAgent) are excluded from ProgressView
  return true;
}

/**
 * Determines if a stream should use the consolidated output channel.
 * Agent streams get their own channel, all others (including executeAgent) use the consolidated channel.
 */
export function shouldUseConsolidatedChannel(streamName: string): boolean {
  // Special case: executeAgent should use the consolidated channel
  if (streamName === 'executeAgent') {
    return true;
  }

  // Opposite of isAgentStream for all other cases
  return !isAgentStream(streamName);
}

/**
 * Determines if a stream should be persisted in workspace storage.
 * We only persist streams that are agent streams
 */
export function shouldPersistStream(streamName: string): boolean {
  // Don't persist streams excluded from ProgressView
  if (shouldExcludeFromProgressView(streamName)) {
    return false;
  }

  return true;
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
