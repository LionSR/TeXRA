// Shared logger for all progress view modules
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Single shared logger instance for all progress view modules.
 * Eliminates per-module logger instances while maintaining consistent logging.
 */
export const progressViewLogger = new AgentLogger('ProgressView');
