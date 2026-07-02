/**
 * Pluggable handler for surfacing tool-missing errors to the user. Hosts
 * without a UI for this (CLI, desktop) no-op.
 */
export type ToolMissingHandler = (
  message: string,
  openDocsCommand?: string,
) => void | Promise<void>;

/**
 * Pluggable notification handler for tool groups excluded due to missing
 * dependencies. `actionCommand`/`actionLabel` let a notification funnel the
 * user to the right tab. Hosts without a UI for this (CLI, desktop) no-op.
 */
export type ToolNotificationHandler = (
  message: string,
  actionCommand?: string,
  actionLabel?: string,
) => void;
