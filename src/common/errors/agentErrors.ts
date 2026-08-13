/**
 * Base class for runtime errors raised by the agent layer.
 *
 * Host-neutral (lives in `@common/errors`) so any host can reference it.
 * Specific subclasses should be added only when a concrete thrower and
 * catcher exist for them — anything else duplicates the existing
 * `ProviderError` schema and `isUserAbort` machinery.
 */
export class AgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentError';
  }
}
