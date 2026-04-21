/**
 * Setup-assistant tools: a narrow UNIX-style set for the onboarding agent.
 *
 * Each tool has one responsibility:
 *   - probe_environment — read-only environment snapshot
 *   - verify_setup — re-check dependencies
 *   - set_api_key / unset_api_key — SecretStorage writes
 *   - invoke_command — bridge to allowlisted VS Code commands
 *   - install_vscode_extension — install LaTeX Workshop / Lean 4
 *   - update_shell_rc — append a PATH export to the user's shell rc
 *
 * Platform coupling is injected via `setSetupPlatform()` at extension
 * activation so the tools stay in the VS Code-free `@tools/*` zone.
 */
export { ProbeEnvironmentTool } from './ProbeEnvironmentTool';
export { VerifySetupTool } from './VerifySetupTool';
export { SetApiKeyTool } from './SetApiKeyTool';
export { UnsetApiKeyTool } from './UnsetApiKeyTool';
export { InvokeCommandTool } from './InvokeCommandTool';
export { InstallVscodeExtensionTool } from './InstallVscodeExtensionTool';
export { UpdateShellRcTool } from './UpdateShellRcTool';
export {
  setSetupPlatform,
  getSetupPlatform,
  type SetupPlatform,
  type SetupSecretsAdapter,
  type SetupCommandAdapter,
  type SetupExtensionAdapter,
  type SetupAuthAdapter,
} from './platform';
