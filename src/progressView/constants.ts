// Local constants shared across progress view host components.

/**
 * Identifier used when a stream has not yet produced a dedicated run ID.
 * Ensures tool-use sessions and early workflow events can persist data
 * consistently across managers before task groups are registered.
 */
export const DEFAULT_RUN_ID = '__default__';
