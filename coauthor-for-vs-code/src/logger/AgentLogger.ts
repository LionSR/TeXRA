// Third-party imports
// (none needed)

// Local imports - log
import * as logger from './logUtils';

/**
 * Encapsulates logging functionality for agents with a dedicated channel.
 */
export class AgentLogger {
  constructor(private channelId: string) {
    logger.initialize(this.channelId);
  }

  debug(message: string): void {
    logger.debug(this.channelId, message);
  }

  info(message: string): void {
    logger.info(this.channelId, message);
  }

  warn(message: string): void {
    logger.warn(this.channelId, message);
  }

  error(message: string): void {
    logger.error(this.channelId, message);
  }
}
