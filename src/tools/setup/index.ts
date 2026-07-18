/**
 * Setup-assistant tools: a narrow UNIX-style set for the onboarding agent.
 *
 * Each tool has one responsibility:
 *   - probe_environment — read-only environment snapshot
 *   - verify_setup — re-check dependencies
 *   - unset_api_key — remove a persisted provider credential
 *   - list_api_keys — enumerate stored secret key names for auditing
 *   - invoke_command — bridge to allowlisted VS Code commands
 *   - install_vscode_extension — install LaTeX Workshop / Lean 4
 *   - send_to_terminal — type into VS Code's integrated terminal for
 *     sudo / interactive prompts the captured-stdio bash tool can't handle
 *   - apply_team — apply a discipline roster + record the default team
 *
 * Shell-rc writes go through the regular `bash` tool (and its approval
 * dialog) — there's no dedicated rc-writing tool. A hand-rolled validator
 * on top of shell would be a second, weaker approval surface that every
 * reviewer keeps finding bypasses for.
 *
 * Common platform coupling is derived from `platform()` ports. The extension
 * adds its VS Code-only setup capabilities via `setSetupPlatform()`.
 */
export { ProbeEnvironmentTool } from './ProbeEnvironmentTool';
export { VerifySetupTool } from './VerifySetupTool';
export { UnsetApiKeyTool } from './UnsetApiKeyTool';
export { ListApiKeysTool } from './ListApiKeysTool';
export { InvokeCommandTool } from './InvokeCommandTool';
export { InstallVscodeExtensionTool } from './InstallVscodeExtensionTool';
export { ReadConfigTool, UpdateConfigTool } from './ConfigTools';
export { SendToTerminalTool } from './SendToTerminalTool';
export { ApplyTeamTool } from './ApplyTeamTool';
export { setSetupPlatform } from './platform';
