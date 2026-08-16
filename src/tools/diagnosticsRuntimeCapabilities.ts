/**
 * Runtime marker that removes the diagnostics tool when a host cannot read
 * linter diagnostics. Its value is the tool name so the normal runtime tool
 * gate excludes every diagnostics command.
 */
export const DIAGNOSTICS_READ_RUNTIME_CAPABILITY = 'diagnostics' as const;
