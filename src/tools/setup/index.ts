/**
 * Setup-assistant tools: a narrow UNIX-style set for the onboarding agent.
 *
 * Each tool has one responsibility:
 *   - probe_environment — read-only environment snapshot
 *   - verify_setup — re-check dependencies
 *   - set_api_key / unset_api_key — SecretStorage writes
 *   - invoke_command — bridge to allowlisted VS Code commands
 *   - install_vscode_extension — install LaTeX Workshop / Lean 4
 *   - send_to_terminal — type into VS Code's integrated terminal for
 *     sudo / interactive prompts the captured-stdio bash tool can't handle
 *
 * Shell-rc writes go through the regular `bash` tool (and its approval
 * dialog) — there's no dedicated rc-writing tool. A hand-rolled validator
 * on top of shell would be a second, weaker approval surface that every
 * reviewer keeps finding bypasses for.
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
export { ReadConfigTool, UpdateConfigTool } from './ConfigTools';
export { SendToTerminalTool } from './SendToTerminalTool';
export {
  setSetupPlatform,
  getSetupPlatform,
  type SetupPlatform,
  type SetupSecretsAdapter,
  type SetupCommandAdapter,
  type SetupExtensionAdapter,
  type SetupAuthAdapter,
  type SetupConfigAdapter,
  type SetupTerminalAdapter,
  type TerminalRunResult,
} from './platform';
