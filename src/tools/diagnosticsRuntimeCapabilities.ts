/**
 * Runtime marker that removes the diagnostics tool when a host cannot read
 * linter diagnostics. Its value is the tool name so the normal runtime tool
 * gate excludes every diagnostics command.
 */
export const DIAGNOSTICS_READ_RUNTIME_CAPABILITY = 'diagnostics' as const;

/**
 * Command-level marker for hosts that can read diagnostics but cannot surface
 * criticism diagnostics. Do not use this as a substitute for the read marker.
 */
export const DIAGNOSTICS_ADD_RUNTIME_CAPABILITY = 'diagnostics.add' as const;
