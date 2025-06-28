// Local imports
import { InputStatusFormatter } from './InputStatusFormatter.js';
import { InputStatusInteractionHandler } from './InputStatusInteractionHandler.js';

/**
 * Facade that coordinates input status functionality.
 * Provides unified interface while maintaining separation of concerns.
 */
export class InputStatusManager {
  constructor() {
    this.formatter = new InputStatusFormatter();
    this.interactionHandler = new InputStatusInteractionHandler();
  }

  /**
   * Initialize input status functionality
   * Simple interface hides internal coordination
   */
  initialize() {
    this.interactionHandler.initialize();
  }

  /**
   * Process input status update
   * Delegates to appropriate specialized modules
   */
  processUpdate(payload) {
    return this.formatter.createLogMessage(payload);
  }

  /**
   * Make file paths clickable in existing content
   * Delegates to formatter module
   */
  makePathsClickable(text) {
    return this.formatter.makeClickable(text);
  }
}

// Export singleton instance following established patterns
export const inputStatusManager = new InputStatusManager();
