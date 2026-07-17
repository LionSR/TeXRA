import type { RegisteredToolName } from './registry';

// Tools hidden when approval or user prompts cannot be answered. This includes
// tools that already ask for approval, interaction-gated prompts, plus direct
// privileged mutators like apply_path, which would otherwise bypass the CLI
// approval policy.
const APPROVAL_GATED_TOOL_NAME_LIST = [
  'accept_run_files',
  'apply_path',
  'ask_user_question',
  'bash',
  'claude_code',
  'codex',
  'delegate_agent',
  'delegate_workflow',
  'edit_file',
  'inquiry',
  'install_vscode_extension',
  'invoke_command',
  'plan',
  'send_to_terminal',
  'str_replace_editor',
  'unset_api_key',
  'update_config',
  'wolfram',
  'write_file',
] as const satisfies readonly RegisteredToolName[];

const APPROVAL_GATED_TOOL_NAMES: ReadonlySet<string> = new Set(
  APPROVAL_GATED_TOOL_NAME_LIST,
);

export function isApprovalGatedToolName(name: string): boolean {
  return APPROVAL_GATED_TOOL_NAMES.has(name);
}
