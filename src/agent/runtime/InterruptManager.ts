/**
 * InterruptManager - Centralized interrupt state management.
 *
 * Replaces the mutable object pattern:
 *   const interruptState = { isInterrupted: false };
 *   onInterrupt: () => { interruptState.isInterrupted = true; }
 *
 * With a proper class that:
 * - Encapsulates interrupt state
 * - Provides type-safe access
 * - Supports abort controller management
 * - Enables future extensibility (listeners, reasons, timestamps)
 */

/**
 * Manages interrupt state for a single flow execution.
 *
 * Created per-execution in executeAgent and passed to flow runners.
 * Arrow function properties are used for callbacks to automatically bind `this`.
 */
export class InterruptManager {
  private _isInterrupted = false;
  private _abortController: AbortController | null = null;

  // =========================================================================
  // Callbacks - Arrow properties for BaseFlowContextInit compatibility
  // =========================================================================

  /** Check if interruption has been requested. */
  checkInterruption = (): boolean => this._isInterrupted;

  /** Set the current abort controller for cancellation. */
  setAbortController = (controller: AbortController | null): void => {
    this._abortController = controller;
  };

  /** Request interruption - called when user stops the agent. */
  onInterrupt = (): void => {
    if (this._isInterrupted) return;
    this._isInterrupted = true;
    this._abortController?.abort();
  };

  // =========================================================================
  // Additional accessors (not passed to flows)
  // =========================================================================

  /**
   * Get the current abort controller.
   * Used by model handlers to abort ongoing requests.
   */
  getAbortController(): AbortController | null {
    return this._abortController;
  }

  /**
   * Get interrupt-related fields for flow input.
   *
   * Returns the interrupt-related subset of fields required by BaseFlowContextInit.
   * Designed to be spread into flow initialization objects alongside other context fields.
   */
  asFlowInput() {
    return {
      checkInterruption: this.checkInterruption,
      setAbortController: this.setAbortController,
      onInterrupt: this.onInterrupt,
    };
  }
}
