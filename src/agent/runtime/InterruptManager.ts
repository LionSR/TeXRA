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
 * Provides callbacks compatible with BaseFlowContextInit interface.
 */
export class InterruptManager {
  private _isInterrupted = false;
  private _abortController: AbortController | null = null;

  /**
   * Check if interruption has been requested.
   * Used by cycles to check whether to stop.
   */
  isInterrupted(): boolean {
    return this._isInterrupted;
  }

  /**
   * Request interruption.
   * Called when user stops the agent or context.interrupt() is invoked.
   */
  requestInterrupt(): void {
    if (this._isInterrupted) return;
    this._isInterrupted = true;
    this._abortController?.abort();
  }

  /**
   * Set the current abort controller.
   * Called by cycles when starting API requests.
   */
  setAbortController(controller: AbortController | null): void {
    this._abortController = controller;
  }

  /**
   * Get the current abort controller.
   * Used by model handlers to abort ongoing requests.
   */
  getAbortController(): AbortController | null {
    return this._abortController;
  }

  // =========================================================================
  // Callback Factories - For BaseFlowContextInit compatibility
  // =========================================================================

  /**
   * Create checkInterruption callback for flow context.
   * Returns a bound function that checks this manager's state.
   */
  createCheckInterruption(): () => boolean {
    return () => this._isInterrupted;
  }

  /**
   * Create setAbortController callback for flow context.
   * Returns a bound function that updates this manager.
   */
  createSetAbortController(): (ctrl: AbortController | null) => void {
    return (ctrl) => this.setAbortController(ctrl);
  }

  /**
   * Create onInterrupt callback for flow context.
   * Returns a bound function that requests interruption on this manager.
   */
  createOnInterrupt(): () => void {
    return () => this.requestInterrupt();
  }
}
