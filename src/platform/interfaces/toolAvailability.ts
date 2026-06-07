/**
 * Host-owned availability checks for integrations that cannot be detected from
 * host-agnostic core code alone.
 */
export interface ToolAvailabilityHost {
  /** True when a VS Code extension is installed in the active extension host. */
  isVscodeExtensionInstalled(extensionId: string): boolean;

  /** True when the current process already is the TeXRA CLI entrypoint. */
  isTexraCliEntrypoint(): boolean;
}

export const NO_TOOL_AVAILABILITY_HOST: ToolAvailabilityHost = Object.freeze({
  isVscodeExtensionInstalled: () => false,
  isTexraCliEntrypoint: () => false,
});
